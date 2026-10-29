import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { bootstrapWorker } from '../src/worker';
import { loadBootstrapAssets } from '../src/db/assets';
import { WorkerLoop } from '../src/worker/worker-loop';
import { PublicationRepository } from '../src/lifecycle/publication.repository';
import { ExpiryRepository } from '../src/lifecycle/expiry.repository';
import { createTestDatabase } from './helpers/postgres';
import { scope } from './helpers/t08';

const valid = { DATABASE_URL: 'postgres://moderator:test-only@db/listings_test', LISTING_TTL_DAYS: '30' };

test('T08 config rejects positive safe polling intervals beyond the Node timer maximum', () => {
  assert.equal(loadConfig(valid).pollIntervalMs, 1000);
  for (const value of ['1', '2147483647']) {
    assert.equal(loadConfig({ ...valid, POLL_INTERVAL_MS: value }).pollIntervalMs, Number(value));
  }
  for (const value of ['2147483648', String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => loadConfig({ ...valid, POLL_INTERVAL_MS: value }), /POLL_INTERVAL_MS/);
  }
});

test('T08 direct WorkerLoop constructor rejects timer overflow and accepts the supported boundaries', async () => {
  await scope(async s => {
    const publication = new PublicationRepository(s.database, 30);
    for (const value of [1, 2147483647]) assert.doesNotThrow(() => new WorkerLoop(s.jobs, publication, new ExpiryRepository(s.database), value));
    for (const value of [2147483648, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => new WorkerLoop(s.jobs, publication, new ExpiryRepository(s.database), value), /polling interval/i);
    }
  });
});

test('T08 actual worker startup rejects timer overflow before database bootstrap', async () => {
  const fixture = await createTestDatabase();
  const observer = new Pool({ connectionString: fixture.url, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  let app: Awaited<ReturnType<typeof bootstrapWorker>> | undefined;
  let primary: unknown;
  try {
    const assets = await loadBootstrapAssets();
    await assert.rejects(async () => {
      app = await bootstrapWorker({ ...valid, DATABASE_URL: fixture.url, POLL_INTERVAL_MS: '2147483648' }, assets);
    }, /POLL_INTERVAL_MS/);
    const state = (await observer.query(
      "SELECT to_regclass('schema_migrations') AS ledger,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name='listing-moderation') AS worker_sessions",
    )).rows[0];
    assert.deepEqual(state, { ledger: null, worker_sessions: 0 });
  } catch (error) { primary = error; }
  const errors: unknown[] = primary === undefined ? [] : [primary];
  if (app) try { await app.close(); } catch (error) { errors.push(error); }
  try { await observer.end(); } catch (error) { errors.push(error); }
  try { await fixture.dispose(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors,
    errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
});
