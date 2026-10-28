import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/postgres';

test('PostgreSQL fixture databases are isolated and disposable', async () => {
  const modulePath = './helpers/postgres';
  const helpers = await import(modulePath).catch(() => ({} as { createTestDatabase?: () => Promise<{ url: string; dispose(): Promise<void> }> }));
  assert.equal(typeof helpers.createTestDatabase, 'function', 'T02 real PostgreSQL fixture must be available');
  const first = await helpers.createTestDatabase!();
  const second = await helpers.createTestDatabase!();
  try {
    const { Pool } = await import('pg');
    const firstPool = new Pool({ connectionString: first.url });
    const secondPool = new Pool({ connectionString: second.url });
    try {
      const firstName = await firstPool.query<{ name: string }>('SELECT current_database() AS name');
      const secondName = await secondPool.query<{ name: string }>('SELECT current_database() AS name');
      assert.notEqual(firstName.rows[0].name, secondName.rows[0].name);
      await firstPool.query('CREATE TABLE fixture_sentinel (value text NOT NULL)');
      await firstPool.query("INSERT INTO fixture_sentinel(value) VALUES ('only-first')");
      await assert.rejects(secondPool.query('SELECT * FROM fixture_sentinel'), { code: '42P01' });
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test('fixture refuses to drop a database with a live application session', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url, max: 1 });
  try {
    await pool.query('SELECT 1');
    await assert.rejects(database.dispose(), /PostgreSQL session\(s\) remain/);
  } finally {
    await pool.end();
    await database.dispose();
  }
});
