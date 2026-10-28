import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, PoolClient } from 'pg';
import { createTestDatabase } from './helpers/postgres';

test('transaction helper uses one PostgreSQL client and commits or rolls back observable writes', async () => {
  const modulePath = '../src/db/transaction';
  const transactionModule = await import(modulePath).catch(() => ({} as {
    withTransaction?: <T>(pool: Pool, work: (client: import('pg').PoolClient) => Promise<T>) => Promise<T>;
  }));
  assert.equal(typeof transactionModule.withTransaction, 'function', 'T02 PostgreSQL transaction helper must be available');

  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url, max: 2 });
  const observer = new Pool({ connectionString: database.url, max: 1 });
  try {
    await pool.query('CREATE TABLE transaction_probe (id text PRIMARY KEY)');
    let signalInserted!: () => void;
    let releaseCallback!: () => void;
    const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const committed = transactionModule.withTransaction!(pool, async (client: PoolClient) => {
      await client.query("INSERT INTO transaction_probe(id) VALUES ('committed')");
      signalInserted();
      await barrier;
      return 'result';
    });
    await inserted;
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM transaction_probe WHERE id = 'committed'")).rows[0].count, 0);
    releaseCallback();
    assert.equal(await committed, 'result');
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM transaction_probe WHERE id = 'committed'")).rows[0].count, 1);

    await assert.rejects(transactionModule.withTransaction!(pool, async (client: PoolClient) => {
      await client.query("INSERT INTO transaction_probe(id) VALUES ('rolled-back')");
      throw new Error('sentinel-rollback');
    }), /sentinel-rollback/);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM transaction_probe WHERE id = 'rolled-back'")).rows[0].count, 0);

    await assert.rejects(transactionModule.withTransaction!(pool, async (client: PoolClient) => {
      await client.query("INSERT INTO transaction_probe(id) VALUES ('before-unique-error')");
      await client.query("INSERT INTO transaction_probe(id) VALUES ('committed')");
    }), { code: '23505' });
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM transaction_probe WHERE id = 'before-unique-error'")).rows[0].count, 0);
    assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1);
  } finally {
    await Promise.all([pool.end(), observer.end()]);
    await database.dispose();
  }
});

test('transaction rejects a PostgreSQL rollback command after a callback catches a SQL error', async () => {
  const { withTransaction } = await import('../src/db/transaction');
  const fixture = await createTestDatabase();
  const pool = new Pool({ connectionString: fixture.url, max: 1 });
  let workCalls = 0;
  try {
    await pool.query('CREATE TABLE swallowed_error_probe(id integer PRIMARY KEY)');
    await assert.rejects(withTransaction(pool, async (client) => {
      workCalls += 1;
      await client.query('INSERT INTO swallowed_error_probe VALUES(1)');
      try {
        await client.query('INSERT INTO swallowed_error_probe VALUES(1)');
        assert.fail('duplicate INSERT must fail before testing swallowed errors');
      } catch (error) {
        assert.equal((error as { code?: string }).code, '23505');
      }
      return 'reported-success';
    }), /transaction.*not committed.*ROLLBACK/i);
    assert.equal(workCalls, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM swallowed_error_probe')).rows[0].count, 0);
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO swallowed_error_probe VALUES(2)');
    });
    assert.deepEqual((await pool.query('SELECT id FROM swallowed_error_probe')).rows, [{ id: 2 }]);
  } finally {
    await pool.end();
    await fixture.dispose();
  }
});

test('transaction helper destroys the checked-out client when BEGIN fails', async () => {
  const { withTransaction } = await import('../src/db/transaction');
  const beginError = new Error('begin-failed');
  const calls: string[] = [];
  let releasedWith: unknown;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN') throw beginError;
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { releasedWith = error; },
  };
  const pool = { connect: async () => client };
  let callbackCalled = false;
  await assert.rejects(withTransaction(pool as never, async () => {
    callbackCalled = true;
    return undefined;
  }), /begin-failed/);
  assert.deepEqual(calls, ['BEGIN']);
  assert.equal(callbackCalled, false);
  assert.equal(releasedWith, beginError);
});

test('transaction helper preserves callback and rollback errors and destroys the client', async () => {
  const { withTransaction } = await import('../src/db/transaction');
  const callbackError = new Error('callback-failed');
  const rollbackError = new Error('rollback-failed');
  const calls: string[] = [];
  let releasedWith: unknown;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { releasedWith = error; },
  };
  const pool = { connect: async () => client };
  await assert.rejects(withTransaction(pool as never, async () => { throw callbackError; }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, callbackError);
    assert.deepEqual(error.errors, [callbackError, rollbackError]);
    return true;
  });
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(releasedWith, true);
});

test('transaction helper never retries an uncertain COMMIT failure', async () => {
  const { withTransaction } = await import('../src/db/transaction');
  const commitError = new Error('commit-outcome-unknown');
  const calls: string[] = [];
  let workCalls = 0;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === 'COMMIT') throw commitError;
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client };
  await assert.rejects(withTransaction(pool as never, async () => { workCalls += 1; return 'done'; }), /commit-outcome-unknown/);
  assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(workCalls, 1);
});
