import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { checksumMigration, loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

type RuntimeDatabase = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
};
type DatabaseModuleContract = {
  Database?: { open(url: string, assets: Awaited<ReturnType<typeof loadBootstrapAssets>>): Promise<RuntimeDatabase> };
};

test('database bootstrap migrates and seeds exact starter data, then reruns without losing domain rows', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  let database = await databaseModule.Database!.open(fixture.url, assets);
  try {
    const counts = await database.query<{ sellers: string; categories: string; banned_keywords: string; migrations: string }>(
      `SELECT (SELECT count(*) FROM sellers)::text AS sellers,
              (SELECT count(*) FROM categories)::text AS categories,
              (SELECT count(*) FROM banned_keywords)::text AS banned_keywords,
              (SELECT count(*) FROM schema_migrations)::text AS migrations`,
    );
    assert.deepEqual(counts.rows[0], { sellers: '8', categories: '5', banned_keywords: '6', migrations: '2' });
    const seller = await database.query<{ name: string; trust_score: number; verified: boolean; note: string }>(
      "SELECT name,trust_score,verified,note FROM sellers WHERE id='s-1001'",
    );
    assert.deepEqual(seller.rows[0], {
      name: 'Nguyen Van A', trust_score: 92, verified: true, note: 'long-standing trusted seller',
    });
    assert.deepEqual((await database.query('SELECT id,name,trust_score,verified,note FROM sellers ORDER BY id')).rows,
      [...assets.seeds.sellers].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual((await database.query('SELECT id,name,median_price_vnd::text AS median_price_vnd FROM categories ORDER BY id')).rows,
      [...assets.seeds.categories].sort((a, b) => a.id.localeCompare(b.id))
        .map((category) => ({ ...category, median_price_vnd: String(category.median_price_vnd) })));
    assert.deepEqual((await database.query<{ term: string }>('SELECT term FROM banned_keywords ORDER BY term')).rows.map(({ term }) => term),
      [...assets.seeds.banned_keywords].sort());
    await database.query("INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('retained','s-1001','c-phones','persisted','',0)");
    await database.query("UPDATE sellers SET trust_score=1 WHERE id='s-1001'");
    await database.query("INSERT INTO sellers(id,name,trust_score,verified,note) VALUES('owner-extra','Extra',50,true,'outside seed')");
  } finally {
    await database.close();
  }

  database = await databaseModule.Database!.open(fixture.url, assets);
  try {
    const rows = await database.query<{ trust_score: number; retained: string; extra: string; migrations: string }>(
      `SELECT (SELECT trust_score FROM sellers WHERE id='s-1001') AS trust_score,
              (SELECT count(*)::text FROM listings WHERE id='retained') AS retained,
              (SELECT count(*)::text FROM sellers WHERE id='owner-extra') AS extra,
              (SELECT count(*)::text FROM schema_migrations) AS migrations`,
    );
    assert.deepEqual(rows.rows[0], { trust_score: 92, retained: '1', extra: '1', migrations: '2' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('concurrent Database.open calls serialize migration and seed with one row per manifest entry', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const assets = await loadBootstrapAssets();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const fixture = await createTestDatabase();
    const opened = await Promise.all([
      databaseModule.Database!.open(fixture.url, assets),
      databaseModule.Database!.open(fixture.url, assets),
    ]);
    try {
      const result = await opened[0].query<{ ledger: string; sellers: string }>(
        'SELECT (SELECT count(*)::text FROM schema_migrations) AS ledger, (SELECT count(*)::text FROM sellers) AS sellers',
      );
      assert.deepEqual(result.rows[0], { ledger: '2', sellers: '8' }, `concurrent bootstrap attempt ${attempt + 1}`);
      assert.equal((await opened[1].query('SELECT 1')).rows.length, 1);
    } finally {
      await Promise.all(opened.map((database) => database.close()));
      await fixture.dispose();
    }
  }
});

test('execution failure after migration DDL rolls schema and ledger back, then valid startup succeeds', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const sql = `${assets.migrations[0].sql}\nCREATE TABLE t02_partial_migration(id integer);\nSELECT 1/0;`;
  const brokenAssets = {
    ...assets,
    migrations: [{ ...assets.migrations[0], sql, checksum: checksumMigration(sql) }],
  };
  try {
    await assert.rejects(databaseModule.Database!.open(fixture.url, brokenAssets), { code: '22012' });
    const observer = new Pool({ connectionString: fixture.url });
    try {
      const state = await observer.query<{ ledger: string; sellers: string; partial: string }>(
        `SELECT (SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations') AS ledger,
                (SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='sellers') AS sellers,
                (SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='t02_partial_migration') AS partial`,
      );
      assert.deepEqual(state.rows[0], { ledger: '0', sellers: '0', partial: '0' });
    } finally {
      await observer.end();
    }
    const recovered = await databaseModule.Database!.open(fixture.url, assets);
    try {
      const state = await recovered.query<{ migrations: string; sellers: string; partial: string | null }>(
        `SELECT (SELECT count(*)::text FROM schema_migrations) AS migrations,
                (SELECT count(*)::text FROM sellers) AS sellers,
                to_regclass('public.t02_partial_migration')::text AS partial`,
      );
      assert.deepEqual(state.rows[0], { migrations: '2', sellers: '8', partial: null });
    } finally {
      await recovered.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test('applied migration checksum drift refuses startup without resetting the database', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const database = await databaseModule.Database!.open(fixture.url, assets);
  await database.close();
  const observer = new Pool({ connectionString: fixture.url });
  try {
    await observer.query("UPDATE schema_migrations SET checksum='tampered' WHERE id='001_initial'");
    await assert.rejects(databaseModule.Database!.open(fixture.url, assets), /checksum mismatch/i);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM schema_migrations WHERE checksum='tampered'")).rows[0].count, 1);
  } finally {
    await observer.end();
    await fixture.dispose();
  }
});

test('unknown migration history refuses startup without deleting its ledger', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const database = await databaseModule.Database!.open(fixture.url, assets);
  await database.close();
  const observer = new Pool({ connectionString: fixture.url });
  try {
    await observer.query("INSERT INTO schema_migrations(id,checksum) VALUES('999_unknown','preserve-me')");
    await assert.rejects(databaseModule.Database!.open(fixture.url, assets), /migrations absent from the manifest/i);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM schema_migrations WHERE id='999_unknown'")).rows[0].count, 1);
  } finally {
    await observer.end();
    await fixture.dispose();
  }
});

test('bootstrap lock contention times out and succeeds after the lock holder releases it', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const lockPool = new Pool({ connectionString: fixture.url, max: 1 });
  const lockClient = await lockPool.connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT pg_advisory_xact_lock($1, $2)', [74201, 2]);
    await assert.rejects(databaseModule.Database!.open(fixture.url, assets), /lock timeout|canceling statement/i);
    await lockClient.query('ROLLBACK');
    const database = await databaseModule.Database!.open(fixture.url, assets);
    try {
      assert.equal((await database.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 2);
    } finally {
      await database.close();
    }
  } finally {
    if (lockClient) lockClient.release();
    await lockPool.end();
    await fixture.dispose();
  }
});

test('invalid seed fails before bootstrap creates the ledger or domain schema', async () => {
  const modulePath = '../src/db/database';
  const databaseModule = await import(modulePath).catch(() => ({} as DatabaseModuleContract)) as DatabaseModuleContract;
  assert.equal(typeof databaseModule.Database?.open, 'function', 'T02 production Database bootstrap must be available');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const invalidAssets = {
    ...assets,
    seeds: { ...assets.seeds, sellers: [{ ...assets.seeds.sellers[0], trust_score: 101 }] },
  };
  const observer = new Pool({ connectionString: fixture.url });
  try {
    await assert.rejects(databaseModule.Database!.open(fixture.url, invalidAssets), /trust_score/);
    const tables = await observer.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'",
    );
    assert.equal(tables.rows[0].count, 0);
  } finally {
    await observer.end();
    await fixture.dispose();
  }
});
