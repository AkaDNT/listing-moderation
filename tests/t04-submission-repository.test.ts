import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

interface SubmissionFields {
  sellerId: string;
  title: string;
  description: string;
  priceVnd: bigint;
  categoryId: string;
}

interface SubmissionResult {
  kind: 'created' | 'replayed';
  id: string;
  status: string;
}

interface SubmissionRepositoryInstance {
  submit(fields: SubmissionFields, identity?: { key: string; requestHash: string }): Promise<SubmissionResult>;
}

interface SubmissionRepositoryModule {
  SubmissionRepository?: new (database: Database) => SubmissionRepositoryInstance;
}

function loadSubmissionRepository(): SubmissionRepositoryModule {
  try { return require('../src/submission/submission.repository') as SubmissionRepositoryModule; }
  catch { return {}; }
}

function repositoryConstructor(): NonNullable<SubmissionRepositoryModule['SubmissionRepository']> {
  const module = loadSubmissionRepository();
  assert.equal(typeof module.SubmissionRepository, 'function', 'production submission repository must be available');
  return module.SubmissionRepository!;
}

const request = (overrides: Partial<SubmissionFields> = {}): SubmissionFields => ({
  sellerId: 's-1001',
  title: 'Repository integration probe',
  description: 'unknown values remain outside persisted fields',
  priceVnd: 9007199254740993n,
  categoryId: 'c-phones',
  ...overrides,
});

async function counts(database: Database): Promise<{ listings: string; keys: string; jobs: string; history: string }> {
  const result = await database.query<{ listings: string; keys: string; jobs: string; history: string }>(
    `SELECT (SELECT count(*)::text FROM listings) AS listings,
            (SELECT count(*)::text FROM submission_keys) AS keys,
            (SELECT count(*)::text FROM moderation_jobs) AS jobs,
            (SELECT count(*)::text FROM moderation_history) AS history`,
  );
  return result.rows[0];
}

const CONCURRENCY_TIMEOUT_MS = 10_000;

function concurrencyDatabaseUrl(url: string): string {
  const bounded = new URL(url);
  bounded.searchParams.set('options', '-c statement_timeout=8000');
  return bounded.toString();
}

async function withConcurrencyDiagnostics<T>(
  fixture: Awaited<ReturnType<typeof createTestDatabase>>,
  label: string,
  operation: Promise<T>,
): Promise<T> {
  const diagnostics = new Pool({ connectionString: fixture.url, max: 1, application_name: 't04-race-diagnostics' });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      try {
        const sessions = await diagnostics.query(
          `SELECT pid, application_name, state, wait_event_type, wait_event, query
           FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY pid`,
          [fixture.databaseName],
        );
        reject(new Error(`${label} exceeded ${CONCURRENCY_TIMEOUT_MS}ms; PostgreSQL sessions=${JSON.stringify(sessions.rows)}`));
      } catch (error) {
        reject(new Error(`${label} exceeded ${CONCURRENCY_TIMEOUT_MS}ms; diagnostics failed: ${String(error)}`));
      }
    }, CONCURRENCY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await diagnostics.end();
  }
}

test('repository creates independent pending listings and one queued job for each keyless request', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  try {
    const first = await repository.submit(request());
    const second = await repository.submit(request());
    assert.deepEqual(first, { kind: 'created', id: first.id, status: 'pending' });
    assert.deepEqual(second, { kind: 'created', id: second.id, status: 'pending' });
    assert.notEqual(first.id, second.id);

    const rows = await database.query<{
      id: string; price_vnd: string; status: string; decision: null; decided_at: null;
      job_id: string; job_state: string; key_count: string; history_count: string;
    }>(
      `SELECT l.id,l.price_vnd::text,l.status,l.decision,l.decided_at,
              j.id AS job_id,j.state AS job_state,
              (SELECT count(*)::text FROM submission_keys k WHERE k.listing_id=l.id) AS key_count,
              (SELECT count(*)::text FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id
       ORDER BY l.id`,
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].price_vnd, '9007199254740993');
    assert.equal(rows.rows[1].price_vnd, '9007199254740993');
    for (const row of rows.rows) {
      assert.equal(row.status, 'pending');
      assert.equal(row.decision, null);
      assert.equal(row.decided_at, null);
      assert.equal(row.job_state, 'queued');
      assert.equal(row.key_count, '0');
      assert.equal(row.history_count, '0');
    }
    assert.notEqual(rows.rows[0].job_id, rows.rows[1].job_id);
    assert.deepEqual(await counts(database), { listings: '2', keys: '0', jobs: '2', history: '0' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('repository rejects missing seller or category without writing submission rows', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  try {
    for (const invalid of [
      request({ sellerId: 'unknown-seller' }),
      request({ categoryId: 'unknown-category' }),
    ]) {
      await assert.rejects(repository.submit(invalid), error =>
        error instanceof Error && error.name === 'UnknownReferenceError');
      assert.deepEqual(await counts(database), { listings: '0', keys: '0', jobs: '0', history: '0' });
    }
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('job insertion failure rolls back listing, job and optional submission key together', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  try {
    await database.query(`
      CREATE FUNCTION t04_reject_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forced T04 job insert failure';
      END;
      $$;
      CREATE TRIGGER t04_reject_job_insert BEFORE INSERT ON moderation_jobs
      FOR EACH ROW EXECUTE FUNCTION t04_reject_job_insert();
    `);

    await assert.rejects(repository.submit(request(), { key: 'atomic-key', requestHash: 'a'.repeat(64) }),
      /forced T04 job insert failure/);
    assert.deepEqual(await counts(database), { listings: '0', keys: '0', jobs: '0', history: '0' });
  } finally {
    await database.query('DROP TRIGGER IF EXISTS t04_reject_job_insert ON moderation_jobs');
    await database.query('DROP FUNCTION IF EXISTS t04_reject_job_insert()');
    await database.close();
    await fixture.dispose();
  }
});

test('repository replays the original listing with its current status and no new records', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  const identity = { key: 'replay-key', requestHash: 'a'.repeat(64) };
  try {
    const created = await repository.submit(request(), identity);
    await database.query(
      `UPDATE listings
       SET status='needs_human', decision='{"outcome":"escalated","reasons":[]}'::jsonb,
           decided_at='2026-01-01T00:00:00Z'
       WHERE id=$1`,
      [created.id],
    );

    const replay = await repository.submit(request(), identity);
    assert.deepEqual(replay, { kind: 'replayed', id: created.id, status: 'needs_human' });
    assert.deepEqual(await counts(database), { listings: '1', keys: '1', jobs: '1', history: '0' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('repository rejects a reused key with a different request hash without new records', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  try {
    const original = await repository.submit(request(), { key: 'conflict-key', requestHash: 'a'.repeat(64) });
    await assert.rejects(
      repository.submit(request({ title: 'Changed request' }), { key: 'conflict-key', requestHash: 'b'.repeat(64) }),
      error => error instanceof Error && error.name === 'IdempotencyConflictError',
    );
    assert.deepEqual(await counts(database), { listings: '1', keys: '1', jobs: '1', history: '0' });
    const key = await database.query<{ listing_id: string; request_hash: string }>(
      'SELECT listing_id, request_hash FROM submission_keys WHERE key=$1', ['conflict-key'],
    );
    assert.deepEqual(key.rows, [{ listing_id: original.id, request_hash: 'a'.repeat(64) }]);
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('concurrent repository submissions with one key and hash commit one listing, key and job', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(concurrencyDatabaseUrl(fixture.url), await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  try {
    const results = await withConcurrencyDiagnostics(fixture, '50-way same-key repository race', Promise.all(Array.from({ length: 50 }, () =>
      repository.submit(request(), { key: 'concurrent-key', requestHash: 'c'.repeat(64) }))));
    assert.equal(results.filter(result => result.kind === 'created').length, 1);
    assert.equal(results.filter(result => result.kind === 'replayed').length, 49);
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.deepEqual(await counts(database), { listings: '1', keys: '1', jobs: '1', history: '0' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('concurrent valid mixed hashes resolve to one committed winner without speculative rows', async () => {
  const SubmissionRepository = repositoryConstructor();
  const fixture = await createTestDatabase();
  const database = await Database.open(concurrencyDatabaseUrl(fixture.url), await loadBootstrapAssets());
  const repository = new SubmissionRepository(database);
  const requests = Array.from({ length: 20 }, (_, index) => ({
    fields: request({ title: `Mixed request ${index % 2}` }),
    hash: index % 2 === 0 ? 'd'.repeat(64) : 'e'.repeat(64),
  }));
  try {
    const outcomes = await withConcurrencyDiagnostics(fixture, '20-way mixed-hash repository race', Promise.allSettled(requests.map(({ fields, hash }) =>
      repository.submit(fields, { key: 'mixed-key', requestHash: hash }))));
    const committed = await database.query<{ request_hash: string; listing_id: string; title: string }>(
      `SELECT k.request_hash,k.listing_id,l.title
       FROM submission_keys k JOIN listings l ON l.id=k.listing_id
       WHERE k.key='mixed-key'`,
    );
    assert.equal(committed.rows.length, 1);
    const winnerHash = committed.rows[0].request_hash;
    const matching = requests.filter(item => item.hash === winnerHash).length;
    const successful = outcomes.filter((outcome): outcome is PromiseFulfilledResult<SubmissionResult> =>
      outcome.status === 'fulfilled');
    const conflicts = outcomes.filter((outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected');
    assert.equal(successful.length, matching);
    assert.equal(successful.filter(({ value }) => value.kind === 'created').length, 1);
    assert.equal(successful.filter(({ value }) => value.kind === 'replayed').length, matching - 1);
    assert.ok(conflicts.every(({ reason }) => reason instanceof Error && reason.name === 'IdempotencyConflictError'));
    assert.equal(committed.rows[0].title, winnerHash === 'd'.repeat(64) ? 'Mixed request 0' : 'Mixed request 1');
    assert.deepEqual(await counts(database), { listings: '1', keys: '1', jobs: '1', history: '0' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});
