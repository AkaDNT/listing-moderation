import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

async function importAssets() {
  const modulePath = '../src/db/assets';
  type AssetsModule = {
    validateSeedData?: (value: unknown) => { sellers: unknown[]; categories: unknown[]; banned_keywords: string[] };
    loadBootstrapAssets?: (root?: string) => Promise<{ seeds: { sellers: unknown[] }; migrations: Array<{ id: string; sql: string; checksum: string }> }>;
    checksumMigration?: (sql: string) => string;
  };
  return await import(modulePath).catch(() => ({} as AssetsModule)) as AssetsModule;
}

async function readSeeds(root: string) {
  return {
    sellers: JSON.parse(await readFile(resolve(root, 'sellers.json'), 'utf8')) as unknown,
    categories: JSON.parse(await readFile(resolve(root, 'categories.json'), 'utf8')) as unknown,
    banned_keywords: JSON.parse(await readFile(resolve(root, 'banned_keywords.json'), 'utf8')) as unknown,
  };
}

test('seed validator accepts the authoritative starter data', async () => {
  const module = await importAssets();
  assert.equal(typeof module.validateSeedData, 'function', 'T02 seed validation must be available');

  const root = resolve(__dirname, '../../seed');
  const seeds = await readSeeds(root);
  const validated = module.validateSeedData!(seeds);
  assert.equal(validated.sellers.length, 8);
  assert.equal(validated.categories.length, 5);
  assert.equal(validated.banned_keywords.length, 6);
});

test('seed validator identifies invalid rows, scalar types, duplicate ids and normalized banned terms', async () => {
  const module = await importAssets();
  assert.equal(typeof module.validateSeedData, 'function', 'T02 seed validation must be available');
  const seeds = await readSeeds(resolve(__dirname, '../../seed'));
  const base = seeds as { sellers: Array<Record<string, unknown>>; categories: Array<Record<string, unknown>>; banned_keywords: string[] };
  const cases: Array<[RegExp, unknown]> = [
    [/trust_score/, { ...base, sellers: [{ ...base.sellers[0], trust_score: 101 }, ...base.sellers.slice(1)] }],
    [/verified/, { ...base, sellers: [{ ...base.sellers[0], verified: 'true' }, ...base.sellers.slice(1)] }],
    [/sellers\.id/, { ...base, sellers: [...base.sellers, base.sellers[0]] }],
    [/median_price_vnd/, { ...base, categories: [{ ...base.categories[0], median_price_vnd: 0 }, ...base.categories.slice(1)] }],
    [/median_price_vnd/, { ...base, categories: [{ ...base.categories[0], median_price_vnd: Number.MAX_SAFE_INTEGER + 1 }, ...base.categories.slice(1)] }],
    [/banned_keywords/, { ...base, banned_keywords: [...base.banned_keywords, 'REPLICA'] }],
    [/banned_keywords/, { ...base, banned_keywords: [...base.banned_keywords.slice(1), '  '] }],
    [/sellers/, { ...base, sellers: null }],
  ];
  for (const [field, value] of cases) assert.throws(() => module.validateSeedData!(value), field);
});

test('bootstrap assets load from the compiled app root with an explicit migration manifest and stable checksum', async () => {
  const module = await importAssets();
  assert.equal(typeof module.loadBootstrapAssets, 'function', 'T02 bootstrap asset loader must be available');
  const loaded = await module.loadBootstrapAssets!();
  assert.equal(loaded.seeds.sellers.length, 8);
  assert.deepEqual(loaded.migrations.map(({ id }) => id), ['001_initial', '002_listing_expiry']);
  assert.match(loaded.migrations[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(loaded.migrations[0].checksum, module.checksumMigration!(loaded.migrations[0].sql));
});

test('bootstrap asset loader reports missing migration with its path', async () => {
  const module = await importAssets();
  assert.equal(typeof module.loadBootstrapAssets, 'function', 'T02 bootstrap asset loader must be available');
  const root = await mkdtemp(resolve(tmpdir(), 't02-assets-'));
  try {
    await mkdir(resolve(root, 'seed'));
    await mkdir(resolve(root, 'migrations'));
    const source = resolve(__dirname, '../../seed');
    for (const file of ['sellers.json', 'categories.json', 'banned_keywords.json']) {
      await writeFile(resolve(root, 'seed', file), await readFile(resolve(source, file)));
    }
    await assert.rejects(module.loadBootstrapAssets!(root), /migrations[\/]001_initial\.sql/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration checksum normalizes CRLF and malformed seed JSON names the file', async () => {
  const module = await importAssets();
  assert.equal(typeof module.checksumMigration, 'function', 'T02 migration checksum must be available');
  assert.equal(module.checksumMigration!('CREATE TABLE sample(id int);\r\n'), module.checksumMigration!('CREATE TABLE sample(id int);\n'));

  assert.equal(typeof module.loadBootstrapAssets, 'function', 'T02 bootstrap asset loader must be available');
  const root = await mkdtemp(resolve(tmpdir(), 't02-malformed-seed-'));
  try {
    await mkdir(resolve(root, 'seed'));
    await mkdir(resolve(root, 'migrations'));
    await writeFile(resolve(root, 'seed', 'sellers.json'), '{not-json');
    await assert.rejects(module.loadBootstrapAssets!(root), /seed[\/]sellers\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
