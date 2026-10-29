import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createApi } from '../src/api';
import { bootstrapWorker } from '../src/worker';
import { parseJson } from '../src/http/json-codec';
import { createTestDatabase } from './helpers/postgres';

interface ListingFields { sellerId: string; categoryId: string; title: string; description: string; priceVnd: bigint }
interface Claim { jobId: string; listingId: string; token: string; attempt: number; leaseUntil: string }
interface JobRepository {
  claimNext(): Promise<{ kind: 'idle' | 'quarantined' | 'exhausted' | 'claimed'; claim?: Claim; jobId?: string }>;
  processClaim(claim: Claim): Promise<{ kind: 'stale' | 'quarantined' | 'completed' }>;
  recordFailure(claim: Claim, error: unknown, random?: number): Promise<'retried' | 'failed' | 'stale'>;
}
interface RepositoryModule { ModerationJobRepository?: new (database: Database) => JobRepository }
interface SubmissionModule { SubmissionRepository?: new (database: Database) => { submit(fields: ListingFields): Promise<{ id: string }> } }

function exported<T>(path: string, name: string): T {
  let module: Record<string, unknown> = {};
  try { module = require(path) as Record<string, unknown>; } catch { /* availability assertion reports setup failure */ }
  const value = module[name];
  assert.equal(typeof value, 'function', `production ${name} must be registered`);
  return value as T;
}

async function fixture<T>(run: (database: Database) => Promise<T>): Promise<T> {
  const testDatabase = await createTestDatabase();
  let database: Database | undefined;
  let result: T | undefined;
  let primary: unknown;
  try { database = await Database.open(testDatabase.url, await loadBootstrapAssets()); result = await run(database); }
  catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await testDatabase.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, `T08 PostgreSQL test/cleanup failure:\n${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`, { cause: primary });
  }
  return result as T;
}

async function addListing(database: Database, suffix: string, sellerId = 's-1002'): Promise<string> {
  const Submission = exported<new (database: Database) => SubmissionModule['SubmissionRepository'] extends new (...args: never[]) => infer R ? R : never>(
    '../src/submission/submission.repository', 'SubmissionRepository');
  const repository = new Submission(database) as { submit(fields: ListingFields): Promise<{ id: string }> };
  const result = await repository.submit({ sellerId, categoryId: 'c-phones', title: `T08 ${suffix}`, description: 'clean listing', priceVnd: 6000000n });
  return result.id;
}

function jobs(database: Database): JobRepository {
  const Repository = exported<new (database: Database) => JobRepository>('../src/worker/moderation-job.repository', 'ModerationJobRepository');
  return new Repository(database);
}

test('claim quarantines every malformed running lease without spending attempts and then claims valid queued work', async () => {
  await fixture(async database => {
    const malformedIds: string[] = [];
    for (const [index, shape] of ['null-token', 'null-lease', 'both-null'].entries()) {
      const listingId = await addListing(database, `malformed-${index}`);
      malformedIds.push(listingId);
      await database.query(
        `UPDATE moderation_jobs SET state='running', attempts=3,
           claim_token=CASE WHEN $2 IN ('null-token','both-null') THEN NULL ELSE gen_random_uuid() END,
           lease_until=CASE WHEN $2 IN ('null-lease','both-null') THEN NULL ELSE clock_timestamp()+interval '1 hour' END,
           created_at='2010-01-01T00:00:00Z'
         WHERE listing_id=$1`, [listingId, shape]);
    }
    const validListingId = await addListing(database, 'valid-after-corrupt');
    const repository = jobs(database);
    const seen = new Set<string>();
    let claimed: Claim | undefined;
    for (let index = 0; index < 5 && !claimed; index += 1) {
      const result = await repository.claimNext();
      if (result.kind === 'quarantined') { assert.ok(result.jobId); seen.add(result.jobId!); }
      else if (result.kind === 'claimed') claimed = result.claim;
      else assert.fail(`expected malformed quarantine or valid claim, got ${result.kind}`);
    }
    assert.equal(seen.size, 3);
    assert.ok(claimed);
    assert.equal(claimed.listingId, validListingId);
    assert.equal(claimed.attempt, 1);
    assert.match(claimed.token, /^[0-9a-f-]{36}$/i);
    const state = await database.query<{ state: string; attempts: number; claim_token: string | null; lease_until: Date | null; last_error: string | null }>(
      `SELECT state,attempts,claim_token,lease_until,last_error FROM moderation_jobs WHERE listing_id=ANY($1::text[])`, [malformedIds]);
    assert.equal(state.rowCount, 3);
    for (const row of state.rows) {
      assert.equal(row.state, 'failed'); assert.equal(row.attempts, 3);
      assert.equal(row.claim_token, null); assert.equal(row.lease_until, null);
      assert.equal(row.last_error, 'invalid_running_metadata');
    }
    const listingState = await database.query<{ status: string; decision: unknown; decided_at: Date | null; history_count: number }>(
      `SELECT l.status,l.decision,l.decided_at,(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l WHERE l.id=ANY($1::text[])`, [malformedIds]);
    assert.equal(listingState.rowCount, 3);
    for (const row of listingState.rows) { assert.equal(row.status, 'pending'); assert.equal(row.decision, null); assert.equal(row.decided_at, null); assert.equal(row.history_count, 0); }
  });
});

test('a live current claim quarantines a nonpending listing and never acknowledges its phase as completed', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'nonpending');
    const updated = await database.query<{ id: string }>(
      `UPDATE listings SET status='auto_approved',decision='{"outcome":"approved","reasons":[]}'::jsonb,
         decided_at=clock_timestamp() WHERE id=$1 RETURNING id`, [listingId]);
    assert.equal(updated.rowCount, 1);
    const token = 'd8a83e92-9d82-4710-85f5-dc6a5dbb49f1';
    const job = await database.query<{ id: string }>(
      `UPDATE moderation_jobs SET state='running',attempts=2,claim_token=$2::uuid,
         lease_until=clock_timestamp()+interval '30 seconds' WHERE listing_id=$1 RETURNING id`, [listingId, token]);
    const repository = jobs(database);
    const result = await repository.processClaim({ jobId: job.rows[0].id, listingId, token, attempt: 2, leaseUntil: new Date(Date.now() + 30000).toISOString() });
    assert.equal(result.kind, 'quarantined');
    const state = await database.query<{ state: string; attempts: number; claim_token: string | null; lease_until: Date | null; completed_at: Date | null; last_error: string | null }>(
      'SELECT state,attempts,claim_token,lease_until,completed_at,last_error FROM moderation_jobs WHERE id=$1', [job.rows[0].id]);
    assert.deepEqual(state.rows[0], { state: 'failed', attempts: 2, claim_token: null, lease_until: null, completed_at: null, last_error: 'unexpected_nonpending_listing' });
    const listing = await database.query<{ status: string; reason_count: number; history_count: number }>(
      `SELECT status,jsonb_array_length(decision->'reasons') AS reason_count,
         (SELECT count(*)::int FROM moderation_history WHERE listing_id=$1) AS history_count
       FROM listings WHERE id=$1`, [listingId]);
    assert.deepEqual(listing.rows[0], { status: 'auto_approved', reason_count: 0, history_count: 0 });
  });
});

test('stale claim token cannot quarantine a replacement claim or change the listing', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'stale-token');
    const currentToken = '760500e9-799f-4553-99c8-08a7f2feb2d1';
    const job = await database.query<{ id: string }>(
      `UPDATE moderation_jobs SET state='running',attempts=2,claim_token=$2::uuid,lease_until=clock_timestamp()+interval '30 seconds'
       WHERE listing_id=$1 RETURNING id`, [listingId, currentToken]);
    const repository = jobs(database);
    const result = await repository.processClaim({ jobId: job.rows[0].id, listingId, token: 'd8a83e92-9d82-4710-85f5-dc6a5dbb49f1', attempt: 1, leaseUntil: new Date().toISOString() });
    assert.equal(result.kind, 'stale');
    await database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [job.rows[0].id]);
    const expired = await repository.processClaim({ jobId: job.rows[0].id, listingId, token: currentToken, attempt: 2,
      leaseUntil: new Date(Date.now() - 1000).toISOString() });
    assert.equal(expired.kind, 'stale');
    const current = await database.query<{ state: string; attempts: number; claim_token: string; status: string; history_count: number }>(
      `SELECT j.state,j.attempts,j.claim_token,l.status,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM moderation_jobs j JOIN listings l ON l.id=j.listing_id WHERE j.id=$1`, [job.rows[0].id]);
    assert.deepEqual(current.rows[0], { state: 'running', attempts: 2, claim_token: currentToken, status: 'pending', history_count: 0 });
  });
});

test('a live claim quarantines every nonpending status without changing listing or existing phase history', async () => {
  await fixture(async database => {
    const cases = [
      { status: 'auto_approved', outcome: 'approved', history: [] },
      { status: 'auto_approved', outcome: 'approved', history: ['auto'] },
      { status: 'auto_rejected', outcome: 'rejected', history: ['auto'] },
      { status: 'needs_human', outcome: 'escalated', history: [] },
      { status: 'needs_human', outcome: 'escalated', history: ['auto'] },
      { status: 'published', outcome: 'approved', history: ['auto', 'human'] },
      { status: 'rejected', outcome: 'rejected', history: ['auto', 'human'] },
      { status: 'expired', outcome: 'approved', history: ['auto'] },
    ];
    const repository = jobs(database);
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const listingId = await addListing(database, `f2-matrix-${index}`);
      const listing = await database.query<{ decided_at: Date }>(
        `UPDATE listings SET status=$2,decision=jsonb_build_object('outcome',$3::text,'reasons','[]'::jsonb),
           decided_at=clock_timestamp(),published_at=CASE WHEN $2='published' THEN clock_timestamp() END,
           expires_at=CASE WHEN $2='expired' THEN clock_timestamp() END WHERE id=$1 RETURNING decided_at`,
        [listingId, item.status, item.outcome]);
      for (const phase of item.history) {
        const outcome = phase === 'auto' ? (item.status === 'needs_human' ? 'escalated' : item.status === 'rejected' || item.status === 'auto_rejected' ? 'rejected' : 'approved')
          : item.status === 'rejected' ? 'rejected' : 'approved';
        await database.query(
          `INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
           VALUES($1,$2,jsonb_build_object('outcome',$3::text,'reasons','[]'::jsonb),$4)`,
          [listingId, phase, outcome, listing.rows[0].decided_at]);
      }
      const token = randomUUID();
      const job = await database.query<{ id: string; attempts: number }>(
        `UPDATE moderation_jobs SET state='running',attempts=3,claim_token=$2::uuid,
           lease_until=clock_timestamp()+interval '30 seconds' WHERE listing_id=$1 RETURNING id,attempts`, [listingId, token]);
      const before = await database.query(
        `SELECT status,decision::text AS decision,decided_at::text,published_at::text,expires_at::text,
           normalized_fingerprint,version::text AS version FROM listings WHERE id=$1`, [listingId]);
      const historyBefore = await database.query(
        `SELECT phase,decision::text AS decision,decided_at::text FROM moderation_history WHERE listing_id=$1 ORDER BY phase`, [listingId]);
      assert.equal((await repository.processClaim({ jobId: job.rows[0].id, listingId, token, attempt: 3,
        leaseUntil: new Date(Date.now() + 30000).toISOString() })).kind, 'quarantined');
      const after = await database.query(
        `SELECT status,decision::text AS decision,decided_at::text,published_at::text,expires_at::text,
           normalized_fingerprint,version::text AS version FROM listings WHERE id=$1`, [listingId]);
      const historyAfter = await database.query(
        `SELECT phase,decision::text AS decision,decided_at::text FROM moderation_history WHERE listing_id=$1 ORDER BY phase`, [listingId]);
      const jobAfter = await database.query<{ state: string; attempts: number; last_error: string }>(
        'SELECT state,attempts,last_error FROM moderation_jobs WHERE id=$1', [job.rows[0].id]);
      assert.deepEqual(after.rows, before.rows);
      assert.deepEqual(historyAfter.rows, historyBefore.rows);
      assert.deepEqual(jobAfter.rows[0], { state: 'failed', attempts: 3, last_error: 'unexpected_nonpending_listing' });
    }
  });
});

test('worker claim atomically commits each production automated decision, matching history, and job completion', async () => {
  await fixture(async database => {
    const cases = [
      { suffix: 'approved', seller: 's-1002', title: 'ordinary approved item', expected: 'auto_approved' },
      { suffix: 'rejected', seller: 's-1001', title: 'fake listing', expected: 'auto_rejected' },
      { suffix: 'human', seller: 's-1004', title: 'ordinary unverified item', expected: 'needs_human' },
    ];
    const expectedById = new Map<string, string>();
    const Submission = exported<new (database: Database) => { submit(fields: ListingFields): Promise<{ id: string }> }>(
      '../src/submission/submission.repository', 'SubmissionRepository');
    const submissions = new Submission(database);
    for (const item of cases) {
      const created = await submissions.submit({ sellerId: item.seller, categoryId: 'c-phones', title: item.title,
        description: 'clean listing', priceVnd: 6000000n });
      expectedById.set(created.id, item.expected);
    }
    const repository = jobs(database);
    const committed = new Set<string>();
    for (let index = 0; index < cases.length; index += 1) {
      const selected = await repository.claimNext();
      assert.equal(selected.kind, 'claimed');
      assert.equal((await repository.processClaim(selected.claim!)).kind, 'completed');
      committed.add(selected.claim!.listingId);
    }
    assert.deepEqual(committed, new Set(expectedById.keys()));
    for (const [listingId, expectedStatus] of expectedById) {
      const persisted = await database.query<{
        status: string; outcome: string; decision_json: string; decided_at: Date; history_decision: string;
        history_at: Date; phase: string; job_state: string; claim_token: string | null; lease_until: Date | null;
        attempts: number; version: string;
      }>(
        "SELECT l.status,l.decision->>'outcome' AS outcome,l.decision::text AS decision_json,l.decided_at," +
        'h.decision::text AS history_decision,h.decided_at AS history_at,h.phase,' +
        'j.state AS job_state,j.claim_token,j.lease_until,j.attempts,l.version::text AS version ' +
        'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id ' +
        "JOIN moderation_history h ON h.listing_id=l.id AND h.phase='auto' WHERE l.id=$1", [listingId]);
      assert.equal(persisted.rowCount, 1);
      const row = persisted.rows[0];
      assert.equal(row.status, expectedStatus);
      assert.equal(row.phase, 'auto');
      assert.equal(row.decision_json, row.history_decision);
      assert.equal(row.decided_at.toISOString(), row.history_at.toISOString());
      assert.equal(row.job_state, 'completed'); assert.equal(row.claim_token, null); assert.equal(row.lease_until, null);
      assert.equal(row.attempts, 1); assert.equal(row.version, '1');
      assert.equal(row.outcome, expectedStatus === 'auto_approved' ? 'approved' : expectedStatus === 'auto_rejected' ? 'rejected' : 'escalated');
    }
  });
});

test('actual POST stays pending without a worker; registered worker loop later commits and actual GET returns the decision', { timeout: 20000 }, async () => {
  const fixtureDb = await createTestDatabase();
  const env = { DATABASE_URL: fixtureDb.url, PORT: '8080', POLL_INTERVAL_MS: '20', LISTING_TTL_DAYS: '30' };
  const assets = await loadBootstrapAssets();
  const observer = new Pool({ connectionString: fixtureDb.url });
  let api: Awaited<ReturnType<typeof createApi>> | undefined;
  let worker: Awaited<ReturnType<typeof bootstrapWorker>> | undefined;
  let primary: unknown;
  try {
    api = await createApi(env, assets);
    await api.listen(0, '127.0.0.1');
    const address = api.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const post = await fetch(base + '/v1/listings', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ seller_id: 's-1002', category_id: 'c-phones', title: 'T08 actual worker', description: 'clean', price_vnd: 6000000 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(post.status, 202);
    const accepted = await post.json() as { id: string; status: string };
    assert.equal(accepted.status, 'pending');
    const before = await observer.query<{ status: string; decision: unknown; job_state: string; history_count: number }>(
      'SELECT l.status,l.decision,j.state AS job_state,' +
      '(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count ' +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [accepted.id]);
    assert.deepEqual(before.rows[0], { status: 'pending', decision: null, job_state: 'queued', history_count: 0 });

    worker = await bootstrapWorker(env, assets);
    const deadline = Date.now() + 7000;
    let committed: { status: string; job_state: string; history_count: number } | undefined;
    while (Date.now() < deadline) {
      const current = await observer.query<{ status: string; job_state: string; history_count: number }>(
        'SELECT l.status,j.state AS job_state,' +
        "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
        'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [accepted.id]);
      if (current.rows[0].job_state === 'completed') { committed = current.rows[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(committed, { status: 'auto_approved', job_state: 'completed', history_count: 1 });
    const get = await fetch(base + '/v1/listings/' + encodeURIComponent(accepted.id), {
      headers: { connection: 'close' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(get.status, 200);
    const body = parseJson(await get.text()) as { id: string; status: string; decision: { outcome: string; reasons: unknown[] }; decided_at: string };
    assert.equal(body.id, accepted.id); assert.equal(body.status, 'auto_approved');
    assert.equal(body.decision.outcome, 'approved'); assert.deepEqual(body.decision.reasons, []);
    assert.ok(Number.isFinite(Date.parse(body.decided_at)));
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (worker) try { await worker.close(); } catch (error) { cleanup.push(error); }
  if (api) try { await api.close(); } catch (error) { cleanup.push(error); }
  try { await observer.end(); } catch (error) { cleanup.push(error); }
  try { await fixtureDb.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, 'T08 actual worker HTTP/cleanup failure:\n' + errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
  }
});

test('history SQL failure rolls listing back and fenced retry completes once without persisting private diagnostics', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'retry-after-history-failure');
    const repository = jobs(database);
    const first = await repository.claimNext();
    assert.equal(first.kind, 'claimed');
    const claim = first.claim!;
    await database.query("CREATE FUNCTION fail_t08_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='private title and password=secret'; END $$");
    await database.query('CREATE TRIGGER t08_fail_history BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION fail_t08_history()');
    await assert.rejects(repository.processClaim(claim), /private title and password=secret/);
    const rollback = await database.query<{
      status: string; decision: unknown; decided_at: Date | null; fingerprint: string | null; version: string;
      job_state: string; attempts: number; claim_token: string; history_count: number;
    }>('SELECT l.status,l.decision,l.decided_at,l.normalized_fingerprint AS fingerprint,l.version::text AS version,' +
      'j.state AS job_state,j.attempts,j.claim_token,' +
      '(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count ' +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(rollback.rows[0], {
      status: 'pending', decision: null, decided_at: null, fingerprint: null, version: '0',
      job_state: 'running', attempts: 1, claim_token: claim.token, history_count: 0,
    });
    assert.equal(await repository.recordFailure(claim, { code: '23514', message: 'private title password=secret' }, 0), 'retried');
    const saved = await database.query<{ state: string; attempts: number; last_error: string; claim_token: string | null }>(
      'SELECT state,attempts,last_error,claim_token FROM moderation_jobs WHERE id=$1', [claim.jobId]);
    assert.deepEqual(saved.rows[0], { state: 'queued', attempts: 1, last_error: 'database_error:23514', claim_token: null });
    assert.doesNotMatch(saved.rows[0].last_error, /private|secret/);
    await database.query('DROP TRIGGER t08_fail_history ON moderation_history');
    await database.query('DROP FUNCTION fail_t08_history()');
    const second = await repository.claimNext();
    assert.equal(second.kind, 'claimed');
    assert.equal(second.claim!.attempt, 2);
    assert.notEqual(second.claim!.token, claim.token);
    assert.equal((await repository.processClaim(second.claim!)).kind, 'completed');
    const final = await database.query<{ status: string; state: string; attempts: number; history_count: number; version: string }>(
      'SELECT l.status,j.state,j.attempts,l.version::text AS version,' +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(final.rows[0], { status: 'auto_approved', state: 'completed', attempts: 2, history_count: 1, version: '1' });
  });
});

test('job completion SQL failure rolls back listing and history before a new claim commits them together', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'retry-after-completion-failure');
    const repository = jobs(database);
    const first = await repository.claimNext();
    assert.equal(first.kind, 'claimed');
    const claim = first.claim!;
    await database.query("CREATE FUNCTION fail_t08_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='private completion detail'; END IF; RETURN NEW; END $$");
    await database.query('CREATE TRIGGER t08_fail_job_completion BEFORE UPDATE ON moderation_jobs FOR EACH ROW EXECUTE FUNCTION fail_t08_job_completion()');
    await assert.rejects(repository.processClaim(claim), /private completion detail/);
    const rollback = await database.query<{
      status: string; decision: unknown; decided_at: Date | null; fingerprint: string | null; version: string;
      job_state: string; attempts: number; claim_token: string; history_count: number;
    }>('SELECT l.status,l.decision,l.decided_at,l.normalized_fingerprint AS fingerprint,l.version::text AS version,' +
      'j.state AS job_state,j.attempts,j.claim_token,' +
      '(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count ' +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(rollback.rows[0], {
      status: 'pending', decision: null, decided_at: null, fingerprint: null, version: '0',
      job_state: 'running', attempts: 1, claim_token: claim.token, history_count: 0,
    });
    await database.query('DROP TRIGGER t08_fail_job_completion ON moderation_jobs');
    await database.query('DROP FUNCTION fail_t08_job_completion()');
    assert.equal(await repository.recordFailure(claim, { code: '23514', message: 'private completion detail' }, 0), 'retried');
    const second = await repository.claimNext();
    assert.equal(second.kind, 'claimed');
    assert.equal(second.claim!.attempt, 2);
    assert.notEqual(second.claim!.token, claim.token);
    assert.equal((await repository.processClaim(second.claim!)).kind, 'completed');
    const final = await database.query<{ status: string; job_state: string; attempts: number; history_count: number; version: string }>(
      'SELECT l.status,j.state AS job_state,j.attempts,l.version::text AS version,' +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(final.rows[0], { status: 'auto_approved', job_state: 'completed', attempts: 2, history_count: 1, version: '1' });
  });
});

test('lease expiry during history work fences completion and rolls back the listing and history', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'lease-fence');
    const repository = jobs(database);
    const selected = await repository.claimNext();
    assert.equal(selected.kind, 'claimed');
    const claim = selected.claim!;
    await database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()+interval '250 milliseconds' WHERE id=$1", [claim.jobId]);
    await database.query("CREATE FUNCTION delay_t08_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$");
    await database.query('CREATE TRIGGER t08_delay_history BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION delay_t08_history()');
    await assert.rejects(repository.processClaim(claim), /claim expired or was replaced/i);
    const state = await database.query<{
      status: string; decision: unknown; decided_at: Date | null; fingerprint: string | null; version: string;
      job_state: string; claim_token: string; history_count: number;
    }>('SELECT l.status,l.decision,l.decided_at,l.normalized_fingerprint AS fingerprint,l.version::text AS version,' +
      'j.state AS job_state,j.claim_token,' +
      '(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count ' +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(state.rows[0], {
      status: 'pending', decision: null, decided_at: null, fingerprint: null, version: '0',
      job_state: 'running', claim_token: claim.token, history_count: 0,
    });
    await database.query('DROP TRIGGER t08_delay_history ON moderation_history');
    await database.query('DROP FUNCTION delay_t08_history()');
    const recovered = await repository.claimNext();
    assert.equal(recovered.kind, 'claimed');
    assert.equal(recovered.claim!.attempt, 2);
    assert.notEqual(recovered.claim!.token, claim.token);
    assert.equal((await repository.processClaim(recovered.claim!)).kind, 'completed');
  });
});

test('five retry claims exhaust visibly and leave the pending listing available for operator review', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'max-attempts');
    const repository = jobs(database);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const selected = await repository.claimNext();
      assert.equal(selected.kind, 'claimed');
      assert.equal(selected.claim!.attempt, attempt);
      if (attempt < 5) {
        assert.equal(await repository.recordFailure(selected.claim!, new Error('temporary private failure'), 0), 'retried');
      } else {
        assert.equal(await repository.recordFailure(selected.claim!, new Error('permanent private failure'), 0), 'failed');
      }
    }
    const state = await database.query<{
      status: string; decision: unknown; version: string; job_state: string; attempts: number;
      claim_token: string | null; lease_until: Date | null; completed_at: Date | null;
      last_error: string; history_count: number;
    }>('SELECT l.status,l.decision,l.version::text AS version,j.state AS job_state,j.attempts,j.claim_token,j.lease_until,j.completed_at,j.last_error,' +
      '(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count ' +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [listingId]);
    assert.deepEqual(state.rows[0], {
      status: 'pending', decision: null, version: '0', job_state: 'failed', attempts: 5,
      claim_token: null, lease_until: null, completed_at: null, last_error: 'unexpected_error:Error', history_count: 0,
    });
    const requeued = await database.transaction(async client => {
      await client.query('SELECT id,status FROM listings WHERE id=$1 FOR UPDATE', [listingId]);
      await client.query('SELECT id,state,last_error,attempts FROM moderation_jobs WHERE listing_id=$1 FOR UPDATE', [listingId]);
      return client.query<{ id: string }>(
        `UPDATE moderation_jobs SET state='queued',attempts=0,available_at=clock_timestamp(),
           lease_until=NULL,claim_token=NULL,completed_at=NULL,last_error='operator_requeue_after_inspection'
         WHERE listing_id=$1 AND state='failed'
           AND EXISTS (SELECT 1 FROM listings WHERE id=$1 AND status='pending') RETURNING id`, [listingId]);
    });
    assert.equal(requeued.rowCount, 1);
    const reopened = await repository.claimNext();
    assert.equal(reopened.kind, 'claimed');
    assert.equal(reopened.claim!.attempt, 1);
    assert.equal((await repository.processClaim(reopened.claim!)).kind, 'completed');

    const nonpendingId = await addListing(database, 'operator-requeue-guard');
    await database.query("UPDATE listings SET status='auto_approved',decision='{" +
      "\"outcome\":\"approved\",\"reasons\":[]}'::jsonb,decided_at=clock_timestamp() WHERE id=$1", [nonpendingId]);
    await database.query("UPDATE moderation_jobs SET state='failed',last_error='inspect' WHERE listing_id=$1", [nonpendingId]);
    const refused = await database.transaction(async client => client.query(
      `UPDATE moderation_jobs SET state='queued',attempts=0,available_at=clock_timestamp(),
         lease_until=NULL,claim_token=NULL,completed_at=NULL,last_error='operator_requeue_after_inspection'
       WHERE listing_id=$1 AND state='failed'
         AND EXISTS (SELECT 1 FROM listings WHERE id=$1 AND status='pending') RETURNING id`, [nonpendingId]));
    assert.equal(refused.rowCount, 0);
  });
});

test('claim eligibility uses database time and reclaims a genuinely expired running lease', async () => {
  await fixture(async database => {
    const expiredId = await addListing(database, 'expired-running-lease');
    const futureId = await addListing(database, 'future-queued-job');
    const runningId = await addListing(database, 'live-running-lease');
    const repository = jobs(database);
    const first = await repository.claimNext();
    assert.equal(first.kind, 'claimed');
    assert.equal(first.claim!.listingId, expiredId);
    const oldToken = first.claim!.token;
    await database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [first.claim!.jobId]);
    await database.query("UPDATE moderation_jobs SET available_at=clock_timestamp()+interval '1 hour' WHERE listing_id=$1", [futureId]);
    await database.query("UPDATE moderation_jobs SET state='running',attempts=1,claim_token=$2::uuid,lease_until=clock_timestamp()+interval '1 hour' WHERE listing_id=$1", [runningId, randomUUID()]);
    const leaseStart = await database.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    const dueClaim = await repository.claimNext();
    const leaseEnd = await database.query<{ at: Date; lease_until: Date }>(
      'SELECT clock_timestamp() AS at,lease_until FROM moderation_jobs WHERE id=$1', [first.claim!.jobId]);
    assert.equal(dueClaim.kind, 'claimed');
    assert.equal(dueClaim.claim!.listingId, expiredId);
    assert.equal(dueClaim.claim!.attempt, 2);
    assert.notEqual(dueClaim.claim!.token, oldToken);

    assert.ok(leaseEnd.rows[0].lease_until.getTime() >= leaseStart.rows[0].at.getTime() + 30_000);
    assert.ok(leaseEnd.rows[0].lease_until.getTime() <= leaseEnd.rows[0].at.getTime() + 30_000);
    assert.equal((await repository.claimNext()).kind, 'idle', 'future queued and live running jobs are not claimable');
    const states = await database.query<{ listing_id: string; state: string; attempts: number; claim_token: string | null; lease_until: Date | null }>(
      'SELECT listing_id,state,attempts,claim_token,lease_until FROM moderation_jobs WHERE listing_id=ANY($1::text[]) ORDER BY listing_id',
      [[futureId, runningId]]);
    assert.equal(states.rowCount, 2);
    assert.deepEqual(states.rows.find(row => row.listing_id === futureId), {
      listing_id: futureId, state: 'queued', attempts: 0, claim_token: null, lease_until: null,
    });
    const live = states.rows.find(row => row.listing_id === runningId)!;
    assert.equal(live.state, 'running'); assert.equal(live.attempts, 1);
    assert.ok(live.claim_token); assert.ok(live.lease_until!.getTime() > Date.now());
    const pending = await database.query<{ status: string; version: string; history_count: number }>(
      `SELECT l.status,l.version::text AS version,(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l WHERE l.id=$1`, [expiredId]);
    assert.deepEqual(pending.rows[0], { status: 'pending', version: '0', history_count: 0 });
  });
});

test('attempt five running lease recovery exhausts without issuing a sixth claim', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'attempt-five-crash');
    const token = randomUUID();
    const job = await database.query<{ id: string }>(
      `UPDATE moderation_jobs SET state='running',attempts=5,claim_token=$2::uuid,
         lease_until=clock_timestamp()-interval '1 millisecond' WHERE listing_id=$1 RETURNING id`, [listingId, token]);
    const repository = jobs(database);
    const result = await repository.claimNext();
    assert.deepEqual(result, { kind: 'exhausted', jobId: job.rows[0].id });
    assert.equal((await repository.claimNext()).kind, 'idle');
    const state = await database.query<{ state: string; attempts: number; claim_token: string | null; lease_until: Date | null; last_error: string }>(
      'SELECT state,attempts,claim_token,lease_until,last_error FROM moderation_jobs WHERE id=$1', [job.rows[0].id]);
    assert.deepEqual(state.rows[0], { state: 'failed', attempts: 5, claim_token: null, lease_until: null, last_error: 'max_claims_exhausted' });
    const listing = await database.query<{ status: string; decision: unknown; version: string; history_count: number }>(
      `SELECT l.status,l.decision,l.version::text AS version,
         (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l WHERE l.id=$1`, [listingId]);
    assert.deepEqual(listing.rows[0], { status: 'pending', decision: null, version: '0', history_count: 0 });
  });
});

test('queued attempt five is exhausted without a new claim', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'attempt-five-queued');
    const job = await database.query<{ id: string }>(
      `UPDATE moderation_jobs SET attempts=5,available_at=clock_timestamp()-interval '1 millisecond'
       WHERE listing_id=$1 RETURNING id`, [listingId]);
    const repository = jobs(database);
    assert.deepEqual(await repository.claimNext(), { kind: 'exhausted', jobId: job.rows[0].id });
    assert.equal((await repository.claimNext()).kind, 'idle');
    const state = await database.query<{ state: string; attempts: number }>(
      'SELECT state,attempts FROM moderation_jobs WHERE id=$1', [job.rows[0].id]);
    assert.deepEqual(state.rows[0], { state: 'failed', attempts: 5 });
  });
});

test('two simultaneous claims use SKIP LOCKED and only one obtains the same due job', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'single-claim-race');
    const repository = jobs(database);
    const results = await Promise.all([repository.claimNext(), repository.claimNext()]);
    assert.equal(results.filter(result => result.kind === 'claimed').length, 1);
    assert.equal(results.filter(result => result.kind === 'idle').length, 1);
    const claimed = results.find(result => result.kind === 'claimed')!.claim!;
    assert.equal(claimed.listingId, listingId); assert.equal(claimed.attempt, 1);
    const state = await database.query<{ state: string; attempts: number; claim_token: string | null }>(
      'SELECT state,attempts,claim_token FROM moderation_jobs WHERE listing_id=$1', [listingId]);
    assert.equal(state.rows[0].state, 'running'); assert.equal(state.rows[0].attempts, 1);
    assert.equal(state.rows[0].claim_token, claimed.token);
  });
});

test('retry backoff is persisted against database time and the job is not claimable before its due time', async () => {
  await fixture(async database => {
    const listingId = await addListing(database, 'persisted-retry-backoff');
    const repository = jobs(database);
    const selected = await repository.claimNext();
    assert.equal(selected.kind, 'claimed');
    const claim = selected.claim!;
    const before = await database.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    assert.equal(await repository.recordFailure(claim, new Error('temporary private message'), 0.5), 'retried');
    const persisted = await database.query<{ available_at: Date; after_at: Date; state: string; attempts: number; last_error: string }>(
      `SELECT available_at,clock_timestamp() AS after_at,state,attempts,last_error
       FROM moderation_jobs WHERE id=$1`, [claim.jobId]);
    assert.ok(persisted.rows[0].available_at.getTime() >= before.rows[0].at.getTime() + 498);
    assert.ok(persisted.rows[0].available_at.getTime() <= persisted.rows[0].after_at.getTime() + 502);
    assert.deepEqual({ state: persisted.rows[0].state, attempts: persisted.rows[0].attempts, last_error: persisted.rows[0].last_error },
      { state: 'queued', attempts: 1, last_error: 'unexpected_error:Error' });
    assert.equal((await repository.claimNext()).kind, 'idle');
  });
});

test('SKIP LOCKED claims the next due job while the oldest job row is locked elsewhere', async () => {
  await fixture(async database => {
    const lockedId = await addListing(database, 'skip-locked-oldest');
    const availableId = await addListing(database, 'skip-locked-next');
    const jobsResult = await database.query<{ id: string; listing_id: string }>(
      'SELECT id,listing_id FROM moderation_jobs WHERE listing_id=ANY($1::text[]) ORDER BY id', [[lockedId, availableId]]);
    const lockedJob = jobsResult.rows.find(row => row.listing_id === lockedId)!;
    await database.query("UPDATE moderation_jobs SET available_at=clock_timestamp()-interval '2 seconds' WHERE listing_id=$1", [lockedId]);
    await database.query("UPDATE moderation_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE listing_id=$1", [availableId]);
    const repository = jobs(database);
    await database.transaction(async client => {
      await client.query('SELECT id FROM moderation_jobs WHERE id=$1 FOR UPDATE', [lockedJob.id]);
      const selected = await repository.claimNext();
      assert.equal(selected.kind, 'claimed');
      assert.equal(selected.claim!.listingId, availableId);
    });
  });
});
