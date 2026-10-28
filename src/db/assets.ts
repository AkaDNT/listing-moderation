import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SellerSeed {
  id: string;
  name: string;
  trust_score: number;
  verified: boolean;
  note: string;
}

export interface CategorySeed {
  id: string;
  name: string;
  median_price_vnd: number;
}

export interface SeedData {
  sellers: SellerSeed[];
  categories: CategorySeed[];
  banned_keywords: string[];
}

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

export interface BootstrapAssets {
  seeds: SeedData;
  migrations: Migration[];
}

const MIGRATION_IDS = ['001_initial'] as const;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a nonempty string`);
  }
  return value;
}

function arrayValue(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must be a nonempty array`);
  return value;
}

function unique(values: string[], context: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${context} contains duplicate values`);
}

export function validateSeedData(input: unknown): SeedData {
  const root = asRecord(input, 'seed data');
  const sellers = arrayValue(root.sellers, 'sellers').map((value, index): SellerSeed => {
    const row = asRecord(value, `sellers[${index}]`);
    const id = nonemptyString(row.id, `sellers[${index}].id`);
    const name = nonemptyString(row.name, `sellers[${index}].name`);
    if (!Number.isInteger(row.trust_score) || (row.trust_score as number) < 0 || (row.trust_score as number) > 100) {
      throw new Error(`sellers[${index}].trust_score must be an integer from 0 through 100`);
    }
    if (typeof row.verified !== 'boolean') throw new Error(`sellers[${index}].verified must be a boolean`);
    if (typeof row.note !== 'string') throw new Error(`sellers[${index}].note must be a string`);
    return { id, name, trust_score: row.trust_score as number, verified: row.verified, note: row.note };
  });
  unique(sellers.map(({ id }) => id), 'sellers.id');

  const categories = arrayValue(root.categories, 'categories').map((value, index): CategorySeed => {
    const row = asRecord(value, `categories[${index}]`);
    const id = nonemptyString(row.id, `categories[${index}].id`);
    const name = nonemptyString(row.name, `categories[${index}].name`);
    if (!Number.isSafeInteger(row.median_price_vnd) || (row.median_price_vnd as number) <= 0) {
      throw new Error(`categories[${index}].median_price_vnd must be a positive safe integer`);
    }
    return { id, name, median_price_vnd: row.median_price_vnd as number };
  });
  unique(categories.map(({ id }) => id), 'categories.id');

  const bannedKeywords = arrayValue(root.banned_keywords, 'banned_keywords').map((value, index) =>
    nonemptyString(value, `banned_keywords[${index}]`));
  unique(bannedKeywords.map((term) => term.normalize('NFC').toLocaleLowerCase('en-US')), 'banned_keywords');
  return { sellers, categories, banned_keywords: bannedKeywords };
}

export function checksumMigration(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown read error';
    throw new Error(`Unable to load seed asset ${path}: ${reason}`, { cause: error });
  }
}

export async function loadBootstrapAssets(root = resolve(__dirname, '../../..')): Promise<BootstrapAssets> {
  const seedRoot = resolve(root, 'seed');
  const seeds = validateSeedData({
    sellers: await readJson(resolve(seedRoot, 'sellers.json')),
    categories: await readJson(resolve(seedRoot, 'categories.json')),
    banned_keywords: await readJson(resolve(seedRoot, 'banned_keywords.json')),
  });

  const migrations: Migration[] = [];
  for (const id of MIGRATION_IDS) {
    const path = resolve(root, 'migrations', `${id}.sql`);
    let sql: string;
    try {
      sql = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown read error';
      throw new Error(`Unable to load migration asset ${path}: ${reason}`, { cause: error });
    }
    if (sql.trim().length === 0) throw new Error(`Migration asset ${path} is empty`);
    migrations.push({ id, sql, checksum: checksumMigration(sql) });
  }
  const ids = migrations.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== MIGRATION_IDS[index])) {
    throw new Error('Migration manifest contains duplicate or out-of-order IDs');
  }
  return { seeds, migrations };
}
