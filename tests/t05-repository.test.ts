import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

interface ReadRepository {
  findById(id: string): Promise<Record<string, unknown> | undefined>;
  list(query: { sellerId?: string; status?: string; limit: number }): Promise<Array<Record<string, unknown>>>;
}
interface ReadRepositoryModule { ListingReadRepository?: new (database: Database) => ReadRepository; }
function loadRepository(): ReadRepositoryModule {
  try { return require('../src/listings/listing-read.repository') as ReadRepositoryModule; }
  catch { return {}; }
}

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let database: Database;
let repository: ReadRepository;

before(async () => {
  const mod = loadRepository();
  assert.equal(typeof mod.ListingReadRepository, 'function', 'production listing read repository must be available');
  fixture = await createTestDatabase();
  database = await Database.open(fixture.url, await loadBootstrapAssets());
  repository = new mod.ListingReadRepository!(database);
});

after(async () => {
  if (database) await database.close();
  if (fixture) await fixture.dispose();
});

async function insert(id: string, createdAt: string, sellerId = 's-1001', price = '9007199254740993'): Promise<void> {
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,created_at)
     VALUES($1,$2,'c-phones',$1,'read fixture',$3::bigint,$4::timestamptz)`,
    [id, sellerId, price, createdAt],
  );
}

test('production repository reads lossless columns, applies AND filters, and orders ties deterministically', async () => {
  await insert('old', '2026-01-01T00:00:00Z', 's-1001', '1');
  await insert('equal-a', '2026-01-02T00:00:00Z', 's-1001', '9007199254740993');
  await insert('equal-z', '2026-01-02T00:00:00Z', 's-1001', '9223372036854775807');
  await insert('micro-later', '2026-01-02T00:00:00.000001Z', 's-1002', '2');
  const rows = await repository.list({ sellerId: 's-1001', status: 'pending', limit: 2 });
  assert.deepEqual(rows.map(row => row.id), ['equal-z', 'equal-a']);
  assert.equal(rows[0].price_vnd, '9223372036854775807');
  assert.equal(rows[1].price_vnd, '9007199254740993');
  assert.equal(rows[0].decision_json, null);
  assert.equal(await repository.findById('missing'), undefined);
  assert.equal((await repository.findById('equal-a'))?.price_vnd, '9007199254740993');
  assert.deepEqual(await repository.list({ sellerId: '', limit: 20 }), []);
});

test('production repository treats selector strings as values rather than SQL syntax', async () => {
  const rows = await repository.list({ sellerId: "x' OR TRUE --", limit: 100 });
  assert.deepEqual(rows, []);
});

test('production repository enforces default 20 and maximum 100 against more than 100 real rows', async () => {
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,created_at)
     SELECT 'bulk-' || n, 's-1002', 'c-phones', 'bulk', '', 1::bigint,
            '2026-02-01T00:00:00Z'::timestamptz + n * interval '1 microsecond'
     FROM generate_series(1, 105) AS n`,
  );
  const defaultPage = await repository.list({ limit: 20 });
  const maxPage = await repository.list({ limit: 100 });
  assert.equal(defaultPage.length, 20);
  assert.equal(maxPage.length, 100);
  assert.equal(maxPage[0].id, 'bulk-105');
  assert.equal(maxPage[99].id, 'bulk-6');
  assert.ok(defaultPage.every((row, index) => index === 0 ||
    (defaultPage[index - 1].created_at as Date).getTime() >= (row.created_at as Date).getTime()));
});
