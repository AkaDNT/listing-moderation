import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validateContract, validateSeeds } from './baseline.mjs';

try {
  const root = resolve(process.argv[2] ?? '.');
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const inventory = JSON.parse(read('tests/fixtures/contract-inventory.json'));
  validateContract(parse(read('openapi.yaml')), inventory);
  const seeds = Object.fromEntries(['sellers', 'categories', 'banned_keywords'].map(name => [name, JSON.parse(read(`seed/${name}.json`))]));
  const counts = validateSeeds(seeds);
  console.log(`Baseline valid: ${inventory.endpoints.length} operations checked; seeds ${JSON.stringify(counts)}`);
} catch (error) {
  const code = ['CONTRACT_INVALID', 'SEED_INVALID'].includes(error.code) ? error.code : 'INPUT_INVALID';
  console.error(`Baseline invalid [${code}]: ${error.message}`);
  process.exitCode = 1;
}
