import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

test('T11 readiness probe uses a query deadline and releases the checked-out client', async () => {
  const queries: unknown[] = [];
  const releases: unknown[] = [];
  const fakePool = {
    async query() { return { rowCount: 1, rows: [{ '?column?': 1 }] }; },
    async connect() {
      return {
        async query(config: unknown) { queries.push(config); return { rowCount: 1, rows: [{ '?column?': 1 }] }; },
        release(destroy?: boolean) { releases.push(destroy); },
      };
    },
    async end() {},
  } as unknown as Pool;
  const constructor = Database as unknown as new (pool: Pool) => Database;
  const db = new constructor(fakePool);
  await (db as Database & { readinessProbe(): Promise<void> }).readinessProbe();
  assert.deepEqual(queries, [{ text: 'SELECT 1', query_timeout: 1000 }]);
  assert.deepEqual(releases, [undefined]);
});

test('T11 readiness probe destroys a client after query failure', async () => {
  const releases: unknown[] = [];
  const fakePool = {
    async query() { return { rowCount: 1, rows: [{ '?column?': 1 }] }; },
    async connect() {
      return {
        async query() { throw new Error('probe-private-sentinel'); },
        release(destroy?: boolean) { releases.push(destroy); },
      };
    },
    async end() {},
  } as unknown as Pool;
  const constructor = Database as unknown as new (pool: Pool) => Database;
  const db = new constructor(fakePool);
  await assert.rejects((db as Database & { readinessProbe(): Promise<void> }).readinessProbe(), /probe-private-sentinel/);
  assert.deepEqual(releases, [true]);
});

test('T11 readiness probe succeeds with production PostgreSQL pool after bootstrap', async () => {
  const fixture = await createTestDatabase();
  let db: Database | undefined;
  try {
    db = await Database.open(fixture.url, await loadBootstrapAssets());
    await (db as Database & { readinessProbe(): Promise<void> }).readinessProbe();
  } finally {
    if (db) await db.close();
    await fixture.dispose();
  }
});

test('T11 pinned pg runtime times out a stalled query and a destroyed client can be replaced', async () => {
  const fixture = await createTestDatabase();
  const pool = new Pool({ connectionString: fixture.url, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      const start = Date.now();
      const stalled = { text: 'SELECT pg_sleep(0.7)', query_timeout: 100 };
      await assert.rejects(client.query(stalled), /query read timeout/i);
      assert.ok(Date.now() - start < 2000);
    } finally {
      client.release(true);
    }
    const recovered = await pool.query('SELECT 1 AS healthy');
    assert.equal(recovered.rows[0].healthy, 1);
  } finally {
    await pool.end();
    await fixture.dispose();
  }
});
