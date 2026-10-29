import { Database } from '../db/database';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { mapListing } from '../listings/listing.mapper';
import { AutomatedListingRepository } from '../moderation/automated-listing.repository';
import { retryDelayMs, sanitizeWorkerError, MAX_JOB_CLAIMS } from './job-policy';

const LEASE_MS = 30_000;
const STATEMENT_TIMEOUT = '10s';
const LOCK_TIMEOUT = '5s';

export interface ModerationJobClaim {
  jobId: string;
  listingId: string;
  token: string;
  attempt: number;
  leaseUntil: string;
  recovered?: boolean;
}

export type ClaimResult =
  | { kind: 'idle' }
  | { kind: 'quarantined' | 'exhausted'; jobId: string; listingId: string; attempt: number; diagnostic: string }
  | { kind: 'claimed'; claim: ModerationJobClaim };

export type ProcessResult = { kind: 'stale' } |
  { kind: 'quarantined'; diagnostic: 'unexpected_nonpending_listing' } |
  { kind: 'completed'; status: string; outcome: string; ruleIds: string[] };

export class ModerationJobRepository {
  constructor(private readonly database: Database) {}

  async claimNext(): Promise<ClaimResult> {
    return this.database.transaction(async client => {
      await this.prepare(client);
      const selected = await client.query<{
        id: string; listing_id: string; state: string; attempts: number; claim_token: string | null; lease_until: Date | null;
      }>(
        `SELECT id,listing_id,state,attempts,claim_token,lease_until
         FROM moderation_jobs
         WHERE (state='queued' AND available_at<=clock_timestamp())
            OR (state='running' AND (claim_token IS NULL OR lease_until IS NULL OR lease_until<=clock_timestamp()))
         ORDER BY CASE WHEN state='running' AND (claim_token IS NULL OR lease_until IS NULL) THEN 0 ELSE 1 END,
           CASE WHEN state='queued' THEN available_at ELSE COALESCE(lease_until,created_at) END,id
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const job = selected.rows[0];
      if (!job) return { kind: 'idle' };

      if (job.state === 'running' && (job.claim_token === null || job.lease_until === null)) {
        const quarantined = await client.query(
          `UPDATE moderation_jobs SET state='failed',claim_token=NULL,lease_until=NULL,completed_at=NULL,
             last_error='invalid_running_metadata'
           WHERE id=$1 AND state='running' AND (claim_token IS NULL OR lease_until IS NULL)`, [job.id]);
        if (quarantined.rowCount !== 1) throw new Error('T08 invalid-running quarantine lost its row guard');
        return { kind: 'quarantined', jobId: job.id, listingId: job.listing_id,
          attempt: job.attempts, diagnostic: 'invalid_running_metadata' };
      }

      if (job.attempts >= MAX_JOB_CLAIMS) {
        const failed = await client.query(
          `UPDATE moderation_jobs SET state='failed',claim_token=NULL,lease_until=NULL,completed_at=NULL,
             last_error='max_claims_exhausted'
           WHERE id=$1 AND state=$2 AND attempts >= $3`, [job.id, job.state, MAX_JOB_CLAIMS]);
        if (failed.rowCount !== 1) throw new Error('T08 exhausted-job transition lost its row guard');
        return { kind: 'exhausted', jobId: job.id, listingId: job.listing_id,
          attempt: job.attempts, diagnostic: 'max_claims_exhausted' };
      }

      const token = randomUUID();
      const claimed = await client.query<{ attempts: number; lease_until: Date }>(
        `UPDATE moderation_jobs
         SET state='running',attempts=attempts+1,claim_token=$2::uuid,
             lease_until=clock_timestamp()+($3::int * interval '1 millisecond'),completed_at=NULL
         WHERE id=$1 AND attempts < $4 AND
           ((state='queued' AND available_at<=clock_timestamp()) OR
            (state='running' AND claim_token IS NOT NULL AND lease_until<=clock_timestamp()))
         RETURNING attempts,lease_until`, [job.id, token, LEASE_MS, MAX_JOB_CLAIMS]);
      if (claimed.rowCount !== 1 || !claimed.rows[0].lease_until || !Number.isFinite(claimed.rows[0].lease_until.getTime())) {
        throw new Error('T08 job claim failed its due-state or lease guard');
      }
      return {
        kind: 'claimed',
        claim: { jobId: job.id, listingId: job.listing_id, token, attempt: claimed.rows[0].attempts,
          leaseUntil: claimed.rows[0].lease_until.toISOString(), recovered: job.state === 'running' },
      };
    });
  }

  async processClaim(claim: ModerationJobClaim): Promise<ProcessResult> {
    return this.database.transaction(async client => {
      await this.prepare(client);
      const listingResult = await client.query<{ id: string; status: string }>(
        'SELECT id,status FROM listings WHERE id=$1 FOR UPDATE', [claim.listingId]);
      if (listingResult.rowCount !== 1) throw new Error('T08 claimed job references a missing listing');

      const jobResult = await client.query<{
        id: string; state: string; token: string | null; lease_until: Date | null; live: boolean;
      }>(
        `SELECT id,state,claim_token AS token,lease_until,
           (lease_until>clock_timestamp()) AS live
         FROM moderation_jobs WHERE id=$1 AND listing_id=$2 FOR UPDATE`, [claim.jobId, claim.listingId]);
      const job = jobResult.rows[0];
      if (!job || job.state === 'completed' || job.state !== 'running' || job.token !== claim.token || !job.live) {
        return { kind: 'stale' };
      }

      if (listingResult.rows[0].status !== 'pending') {
        const quarantined = await client.query(
          `UPDATE moderation_jobs SET state='failed',claim_token=NULL,lease_until=NULL,completed_at=NULL,
             last_error='unexpected_nonpending_listing'
           WHERE id=$1 AND listing_id=$2 AND state='running' AND claim_token=$3::uuid
             AND lease_until>clock_timestamp()`, [claim.jobId, claim.listingId, claim.token]);
        if (quarantined.rowCount !== 1) return { kind: 'stale' };
        return { kind: 'quarantined', diagnostic: 'unexpected_nonpending_listing' };
      }

      const applied = await new AutomatedListingRepository().applyAutomatedListing(client, claim.listingId);
      if (applied.kind !== 'applied') throw new Error(`T08 pending listing apply returned ${applied.kind}`);

      const persisted = await client.query<{
        id: unknown; seller_id: unknown; category_id: unknown; title: unknown; description: unknown;
        price_vnd: unknown; status: unknown; decision_json: unknown; decided_at: unknown; created_at: unknown;
      }>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,
           decision::text AS decision_json,decided_at,created_at FROM listings WHERE id=$1`, [claim.listingId]);
      if (persisted.rowCount !== 1) throw new Error('T08 applied listing disappeared before history insert');
      const dto = mapListing(persisted.rows[0]);
      if (!dto.decision || dto.status !== applied.proposal.status || !dto.decided_at ||
          dto.decided_at !== applied.decidedAt ||
          (dto.decision as { outcome?: unknown }).outcome !== applied.proposal.decision.outcome) {
        throw new Error('T08 persisted listing decision does not match the applied automated proposal');
      }

      const history = await client.query<{ id: string }>(
        `INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
         SELECT id,'auto',decision,decided_at FROM listings WHERE id=$1 RETURNING id`, [claim.listingId]);
      if (history.rowCount !== 1) throw new Error('T08 automated history insert did not insert exactly one row');

      const completed = await client.query(
        `UPDATE moderation_jobs SET state='completed',completed_at=clock_timestamp(),
           claim_token=NULL,lease_until=NULL,last_error=NULL
         WHERE id=$1 AND listing_id=$2 AND state='running' AND claim_token=$3::uuid
           AND lease_until>clock_timestamp()`, [claim.jobId, claim.listingId, claim.token]);
      if (completed.rowCount !== 1) throw new LostClaimError();
      const decision = dto.decision as { outcome: string; reasons: { rule_id: string }[] };
      return { kind: 'completed', status: dto.status, outcome: decision.outcome,
        ruleIds: decision.reasons.map(reason => reason.rule_id) };
    });
  }

  async recordFailure(claim: ModerationJobClaim, error: unknown, random = Math.random()): Promise<'retried' | 'failed' | 'stale'> {
    const diagnostic = sanitizeWorkerError(error);
    return this.database.transaction(async client => {
      await this.prepare(client);
      const current = await client.query<{ attempts: number }>(
        `SELECT attempts FROM moderation_jobs WHERE id=$1 AND listing_id=$2 AND state='running'
           AND claim_token=$3::uuid AND lease_until>clock_timestamp() FOR UPDATE`,
        [claim.jobId, claim.listingId, claim.token]);
      if (current.rowCount !== 1) return 'stale';
      if (current.rows[0].attempts >= MAX_JOB_CLAIMS) {
        const failed = await client.query(
          `UPDATE moderation_jobs SET state='failed',claim_token=NULL,lease_until=NULL,completed_at=NULL,last_error=$4
           WHERE id=$1 AND listing_id=$2 AND state='running' AND claim_token=$3::uuid
             AND lease_until>clock_timestamp() AND attempts >= $5`,
          [claim.jobId, claim.listingId, claim.token, diagnostic, MAX_JOB_CLAIMS]);
        return failed.rowCount === 1 ? 'failed' : 'stale';
      }
      const delay = retryDelayMs(current.rows[0].attempts, random);
      const queued = await client.query(
        `UPDATE moderation_jobs SET state='queued',available_at=clock_timestamp()+($4::int * interval '1 millisecond'),
           claim_token=NULL,lease_until=NULL,completed_at=NULL,last_error=$5
         WHERE id=$1 AND listing_id=$2 AND state='running' AND claim_token=$3::uuid
           AND lease_until>clock_timestamp() AND attempts=$6`,
        [claim.jobId, claim.listingId, claim.token, delay, diagnostic, current.rows[0].attempts]);
      return queued.rowCount === 1 ? 'retried' : 'stale';
    });
  }

  private async prepare(client: PoolClient): Promise<void> {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await client.query(`SET LOCAL statement_timeout='${STATEMENT_TIMEOUT}'`);
    await client.query(`SET LOCAL lock_timeout='${LOCK_TIMEOUT}'`);
  }
}

export class LostClaimError extends Error {
  constructor() { super('T08 worker claim expired or was replaced before completion'); this.name = 'LostClaimError'; }
}
