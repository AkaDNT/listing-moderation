import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validateContract, validateSeeds } from '../scripts/baseline.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = () => parse(read('openapi.yaml'));
const inventory = () => JSON.parse(read('tests/fixtures/contract-inventory.json'));
const seeds = () => Object.fromEntries(['sellers', 'categories', 'banned_keywords'].map(name => [name, JSON.parse(read(`seed/${name}.json`))]));

test('actual OpenAPI matches the locked inventory', () => {
  assert.doesNotThrow(() => validateContract(contract(), inventory()));
});
for (const [name, change] of [
  ['missing route', doc => { delete doc.paths['/livez']; }],
  ['missing response status', doc => { delete doc.paths['/v1/listings'].post.responses['422']; }],
  ['missing required field', doc => { doc.components.schemas.ListingRequest.required.pop(); }],
  ['changed price type', doc => { doc.components.schemas.ListingRequest.properties.price_vnd.type = 'string'; }],
  ['changed status enum', doc => { doc.components.schemas.Status.enum.push('draft'); }],
  ['changed list limit', doc => { doc.paths['/v1/listings'].get.parameters[2].schema.maximum = 200; }],
  ['missing human decision field', doc => { doc.paths['/v1/listings/{id}/decision'].post.requestBody.content['application/json'].schema.required.pop(); }]
]) {
  test(`contract checker rejects ${name}`, () => {
    const doc = contract(); change(doc);
    assert.throws(() => validateContract(doc, inventory()), { code: 'CONTRACT_INVALID' });
  });
}
test('actual seed files contain eight sellers, five categories and six terms', () => {
  assert.deepEqual(validateSeeds(seeds()), { sellers: 8, categories: 5, banned_keywords: 6 });
});
for (const [name, change] of [
  ['duplicate seller ID', data => { data.sellers[1].id = data.sellers[0].id; }],
  ['duplicate category ID', data => { data.categories[1].id = data.categories[0].id; }],
  ['string trust score', data => { data.sellers[0].trust_score = '92'; }],
  ['nonboolean verified', data => { data.sellers[0].verified = 1; }],
  ['invalid median', data => { data.categories[0].median_price_vnd = -1; }],
  ['empty banned term', data => { data.banned_keywords[0] = ''; }],
  ['duplicate banned term', data => { data.banned_keywords[0] = 'FAKE'; }]
]) {
  test(`seed checker rejects ${name}`, () => {
    const data = seeds(); change(data);
    assert.throws(() => validateSeeds(data), { code: 'SEED_INVALID' });
  });
}
test('CLI reads repository fixtures successfully', () => {
  const result = spawnSync(process.execPath, ['scripts/check-baseline.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 operations/);
});
test('CLI fails early with diagnostics for a malformed fixture on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'moderation-baseline-'));
  try {
    cpSync('seed', join(root, 'seed'), { recursive: true });
    cpSync('openapi.yaml', join(root, 'openapi.yaml'));
    cpSync('tests', join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'seed/sellers.json'), '[{"id":"bad"}]');
    const result = spawnSync(process.execPath, ['scripts/check-baseline.mjs', root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[SEED_INVALID\]/);
    assert.equal(result.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// These mutations expose gaps in the inherited checker, not HTTP business behavior.
for (const [name, change] of [
  ['wrong object type', doc => { doc.components.schemas.ListingRequest.type = 'array'; }],
  ['missing submission body requirement', doc => { delete doc.paths['/v1/listings'].post.requestBody.required; }],
  ['wrong submission body reference', doc => { doc.paths['/v1/listings'].post.requestBody.content['application/json'].schema.$ref = '#/components/schemas/Listing'; }],
  ['missing path parameter', doc => { doc.paths['/v1/listings/{id}'].get.parameters = []; }],
  ['optional human request body', doc => { doc.paths['/v1/listings/{id}/decision'].post.requestBody.required = false; }],
  ['new required request field', doc => { doc.components.schemas.ListingRequest.required.push('token'); }],
  ['new undeclared minimum', doc => { doc.components.schemas.ListingRequest.properties.price_vnd.maximum = 100; }],
  ['rejecting unknown request fields', doc => { doc.components.schemas.ListingRequest.additionalProperties = false; }]
]) {
  test(`contract rejects ${name} with a validation error code`, () => {
    const doc = contract(); change(doc);
    assert.throws(() => validateContract(doc, inventory()), { code: 'CONTRACT_INVALID' });
  });
}

test('contract validates a property named description instead of treating it as annotation', () => {
  const doc = contract();
  doc.components.schemas.ListingRequest.properties.description.maxLength = 10;
  assert.throws(() => validateContract(doc, inventory()), { code: 'CONTRACT_INVALID' });
});

test('contract accepts semantically identical required/enum/parameter order', () => {
  const doc = contract();
  doc.components.schemas.ListingRequest.required.reverse();
  doc.components.schemas.Status.enum.reverse();
  doc.paths['/v1/listings'].get.parameters.reverse();
  assert.doesNotThrow(() => validateContract(doc, inventory()));
});

test('contract permits additive operations/statuses and descriptive edits', () => {
  const doc = contract();
  doc.paths['/extra'] = { get: { responses: { 200: { description: 'Extra' } } } };
  doc.paths['/v1/listings'].post.responses['503'] = { description: 'Unavailable' };
  doc.components.schemas.ListingRequest.description = 'Editorial change';
  assert.doesNotThrow(() => validateContract(doc, inventory()));
});

function temporaryRoot(action) {
  const root = mkdtempSync(join(tmpdir(), 'moderation-t00-'));
  try {
    for (const path of ['seed', 'tests/fixtures']) cpSync(path, join(root, path), { recursive: true });
    cpSync('openapi.yaml', join(root, 'openapi.yaml'));
    action(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runCli(root) {
  return spawnSync(process.execPath, ['scripts/check-baseline.mjs', root], { encoding: 'utf8' });
}

test('real CLI rejects a missing inventory as INPUT_INVALID, never CONTRACT_INVALID', () => {
  temporaryRoot(root => {
    rmSync(join(root, 'tests/fixtures/contract-inventory.json'));
    const result = runCli(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[INPUT_INVALID\]/);
    assert.doesNotMatch(result.stderr, /\[CONTRACT_INVALID\]/);
    assert.equal(result.stdout, '');
  });
});

test('real CLI rejects a valid seed array with a bad field through its real validator', () => {
  temporaryRoot(root => {
    const data = seeds().sellers;
    data[0].verified = 'false';
    writeFileSync(join(root, 'seed/sellers.json'), JSON.stringify(data));
    const result = runCli(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[SEED_INVALID\]/);
    assert.match(result.stderr, /seller/);
    assert.equal(result.stdout, '');
  });
});

test('real CLI rejects a mutated OpenAPI schema through parser and real validator', () => {
  temporaryRoot(root => {
    writeFileSync(join(root, 'openapi.yaml'), read('openapi.yaml').replace('minLength: 1', 'minLength: 2'));
    const result = runCli(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[CONTRACT_INVALID\]/);
    assert.equal(result.stdout, '');
  });
});

for (const [name, path, value] of [
  ['malformed JSON', 'seed/sellers.json', '['],
  ['malformed YAML', 'openapi.yaml', 'paths: ['],
  ['duplicate YAML keys', 'openapi.yaml', 'paths: {}\npaths: {}\n']
]) {
  test(`real CLI rejects ${name} as INPUT_INVALID`, () => {
    temporaryRoot(root => {
      writeFileSync(join(root, path), value);
      const result = runCli(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\[INPUT_INVALID\]/);
      assert.equal(result.stdout, '');
    });
  });
}

test('npm check:baseline registration invokes the actual CLI with validation', () => {
  assert.ok(process.env.npm_execpath, 'Run this suite through npm test to exercise npm wiring');
  temporaryRoot(root => {
    writeFileSync(join(root, 'seed/categories.json'), '[]');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', '--silent', 'check:baseline', '--', root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[SEED_INVALID\]/);
    assert.equal(result.stdout, '');
  });
});
