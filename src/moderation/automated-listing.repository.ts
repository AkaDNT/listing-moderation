import { PoolClient } from 'pg';
import { stringifyJson } from '../http/json-codec';
import { ReferenceDataRepository } from './reference-data.repository';
import { finalizeNormalModeration, screenModeration } from './moderation-policy';
import { DuplicateFact, ModerationListing, ModerationProposal, ModerationReferences } from './moderation.types';
import { createDuplicateIdentity, DuplicateIdentity, DuplicateIdentityFields, sameDuplicateIdentity } from './duplicate-fingerprint';

const MAX_INT64 = 9223372036854775807n;
const DUPLICATE_PAGE_SIZE = 100;

interface CandidateRow {
  id: unknown;
  seller_id: unknown;
  category_id: unknown;
  title: unknown;
  description: unknown;
  price_vnd: unknown;
  status: unknown;
}

interface DuplicateRow {
  id: unknown;
  seller_id: unknown;
  category_id: unknown;
  title: unknown;
  description: unknown;
  price_vnd: unknown;
}

export type AutomatedListingResult =
  | { kind: 'missing' }
  | { kind: 'not_pending' }
  | { kind: 'applied'; listingId: string; proposal: ModerationProposal; decidedAt: string; fingerprint: string };

function parsePrice(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`Persisted ${label} price is not an exact nonnegative BIGINT token`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new TypeError(`Persisted ${label} price exceeds int64`);
  return parsed;
}

function identityFields(row: CandidateRow | DuplicateRow, label: string): DuplicateIdentityFields {
  if (typeof row.seller_id !== 'string' || typeof row.category_id !== 'string' ||
      typeof row.title !== 'string' || typeof row.description !== 'string') {
    throw new TypeError(`Persisted ${label} listing identity fields are invalid`);
  }
  return {
    sellerId: row.seller_id,
    categoryId: row.category_id,
    priceVnd: parsePrice(row.price_vnd, label),
    title: row.title,
    description: row.description,
  };
}

async function assertReadCommittedTransaction(client: PoolClient): Promise<void> {
  const first = await client.query<{ transaction_id: string; isolation: string }>(
    `SELECT pg_current_xact_id()::text AS transaction_id,
            current_setting('transaction_isolation') AS isolation`,
  );
  const second = await client.query<{ transaction_id: string }>(
    'SELECT pg_current_xact_id()::text AS transaction_id',
  );
  if (first.rowCount !== 1 || second.rowCount !== 1 || first.rows[0].transaction_id !== second.rows[0].transaction_id) {
    throw new TypeError('R3 apply requires a checked-out client inside an active READ COMMITTED transaction');
  }
  if (first.rows[0].isolation !== 'read committed') {
    throw new TypeError('R3 apply requires an active READ COMMITTED transaction');
  }
}

export class AutomatedListingRepository {
  async applyAutomatedListing(client: PoolClient, listingId: string): Promise<AutomatedListingResult> {
    if (!client || typeof client.query !== 'function' || typeof listingId !== 'string' || listingId.length === 0) {
      throw new TypeError('R3 apply requires a PostgreSQL transaction client and listing ID');
    }
    await assertReadCommittedTransaction(client);

    const candidateResult = await client.query<CandidateRow>(
      `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status
       FROM listings WHERE id=$1 FOR UPDATE`, [listingId]);
    const candidate = candidateResult.rows[0];
    if (!candidate) return { kind: 'missing' };
    if (candidate.status !== 'pending') return { kind: 'not_pending' };
    if (candidate.id !== listingId) throw new TypeError('Persisted listing identifier does not match the requested row');

    const fields = identityFields(candidate, 'candidate');
    const listing: ModerationListing = {
      sellerId: fields.sellerId,
      categoryId: fields.categoryId,
      title: fields.title,
      description: fields.description,
      priceVnd: fields.priceVnd,
    };
    const references: ModerationReferences | undefined =
      await new ReferenceDataRepository(client).load(fields.sellerId, fields.categoryId);
    if (!references) throw new Error('Persisted listing references are missing during R3 evaluation');
    const screening = screenModeration(listing, references);
    const identity: DuplicateIdentity = createDuplicateIdentity(fields);

    let proposal: ModerationProposal;
    if (screening.kind === 'terminal') {
      proposal = screening.proposal;
    } else {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [identity.lockKey]);
      const duplicate: DuplicateFact = await this.findDuplicate(client, fields, listingId);
      proposal = finalizeNormalModeration(screening, duplicate);
    }

    const update = await client.query<{ decided_at: Date }>(
      `UPDATE listings
       SET status=$2,
           decision=$3::jsonb,
           decided_at=statement_timestamp(),
           normalized_fingerprint=$4,
           version=version+1
       WHERE id=$1 AND status='pending'
       RETURNING decided_at`,
      [listingId, proposal.status, stringifyJson(proposal.decision), identity.fingerprint],
    );
    if (update.rowCount !== 1 || update.rows.length !== 1 || !(update.rows[0].decided_at instanceof Date) ||
        !Number.isFinite(update.rows[0].decided_at.getTime())) {
      throw new Error('R3 listing transition did not update exactly one pending row with a valid timestamp');
    }
    return {
      kind: 'applied',
      listingId,
      proposal,
      decidedAt: update.rows[0].decided_at.toISOString(),
      fingerprint: identity.fingerprint,
    };
  }

  private async findDuplicate(
    client: PoolClient,
    candidate: DuplicateIdentityFields,
    candidateId: string,
  ): Promise<DuplicateFact> {
    let cursor: string | null = null;
    while (true) {
      const page: { rows: DuplicateRow[] } = await client.query<DuplicateRow>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd
         FROM listings
         WHERE seller_id=$1 AND category_id=$2 AND price_vnd=$3::bigint
           AND status IN ('auto_approved','published') AND id<>$4
           AND ($5::text IS NULL OR id COLLATE "C" > $5::text COLLATE "C")
         ORDER BY id COLLATE "C"
         LIMIT ${DUPLICATE_PAGE_SIZE}`,
        [candidate.sellerId, candidate.categoryId, candidate.priceVnd.toString(), candidateId, cursor],
      );
      let previous: string | null = cursor;
      for (const duplicateRow of page.rows) {
        if (typeof duplicateRow.id !== 'string' || duplicateRow.id.length === 0 || duplicateRow.id === previous) {
          throw new TypeError('Persisted duplicate page is not strictly ordered by listing ID');
        }
        previous = duplicateRow.id;
        const possible = identityFields(duplicateRow, 'active duplicate candidate');
        if (sameDuplicateIdentity(candidate, possible)) return { kind: 'duplicate', listingId: duplicateRow.id };
      }
      if (page.rows.length < DUPLICATE_PAGE_SIZE) return { kind: 'clear' };
      if (!previous || previous === cursor) throw new Error('R3 duplicate pagination did not advance its cursor');
      cursor = previous;
    }
  }
}
