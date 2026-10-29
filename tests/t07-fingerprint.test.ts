import assert from 'node:assert/strict';
import { test } from 'node:test';

interface DuplicateModule {
  normalizeDuplicateText?: (value: string) => string;
  createDuplicateIdentity?: (value: {
    sellerId: string; categoryId: string; priceVnd: bigint; title: string; description: string;
  }) => { canonical: string; fingerprint: string; lockKey: string };
  sameDuplicateIdentity?: (left: { sellerId: string; categoryId: string; priceVnd: bigint; title: string; description: string }, right: { sellerId: string; categoryId: string; priceVnd: bigint; title: string; description: string }) => boolean;
}

function loadProduction(): DuplicateModule {
  try { return require('../src/moderation/duplicate-fingerprint') as DuplicateModule; }
  catch { return {}; }
}

const production = loadProduction();
const normalize = (value: string) => {
  assert.equal(typeof production.normalizeDuplicateText, 'function', 'production R3 normalizer must be available');
  return production.normalizeDuplicateText!(value);
};
const identity = (overrides: Record<string, unknown> = {}) => {
  assert.equal(typeof production.createDuplicateIdentity, 'function', 'production R3 identity must be available');
  return production.createDuplicateIdentity!({
    sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n,
    title: ' Café phone ', description: 'same', ...overrides,
  } as Parameters<NonNullable<DuplicateModule['createDuplicateIdentity']>>[0]);
};

test('R3 normalizer applies NFC, locale-independent lowercase, then NFC', () => {
  assert.equal(normalize('CAFÉ'), 'café');
  assert.equal(normalize('cafe\u0301'), 'café');
  assert.equal(normalize('İ'), 'i\u0307');
});

test('R3 collapses Unicode White_Space and strips only the resulting ASCII spaces', () => {
  assert.equal(normalize('\t A\n\r\u00a0B\u0085\u2003 '), 'a b');
  assert.equal(normalize('\u00a0\u202f\u3000'), '');
  assert.equal(normalize('A\u200b B\ufeff'), 'a\u200b b\ufeff');
});

test('R3 preserves accents/punctuation and does not full-case-fold sharp s', () => {
  assert.equal(normalize('ß'), 'ß');
  assert.notEqual(normalize('ß'), normalize('ss'));
  assert.equal(normalize('Crème—brûlée!'), 'crème—brûlée!');
});

test('R3 identity uses exact IDs and bigint while canonical JSON encoding avoids delimiters', () => {
  const base = identity();
  assert.deepEqual(base.canonical, JSON.stringify([
    'listing-r3-v1', 's-1007', 'c-phones', '9007199254740993', 'café phone', 'same',
  ]));
  assert.match(base.fingerprint, /^r3:v1:[0-9a-f]{64}$/);
  assert.match(base.lockKey, /^-?(0|[1-9][0-9]*)$/);
  assert.notEqual(identity({ sellerId: 'S-1007' }).fingerprint, base.fingerprint);
  assert.notEqual(identity({ categoryId: 'c-Phones' }).fingerprint, base.fingerprint);
  assert.notEqual(identity({ priceVnd: 9007199254740992n }).fingerprint, base.fingerprint);
  assert.notEqual(identity({ title: 'a|b', description: 'c' }).fingerprint,
    identity({ title: 'a', description: 'b|c' }).fingerprint);
  assert.notEqual(identity({ title: 'a"b', description: '😀' }).fingerprint,
    identity({ title: 'a', description: '"b😀' }).fingerprint);
});

test('R3 identity is deterministic and exact tuple comparison is not based on cached hashes', () => {
  const left = identity({ title: 'A  phone' });
  const equal = identity({ title: 'a\u3000phone' });
  assert.equal(left.fingerprint, equal.fingerprint);
  assert.notEqual(identity({ title: 'Ａ phone' }).fingerprint, identity({ title: 'a phone' }).fingerprint);
  assert.equal(left.lockKey, equal.lockKey);
  assert.equal(production.sameDuplicateIdentity?.(
    { sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n, title: 'A  phone', description: 'same' },
    { sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n, title: 'a\u3000phone', description: 'same' },
  ), true);
  assert.equal(production.sameDuplicateIdentity?.(
    { sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n, title: 'first', description: 'same' },
    { sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n, title: 'second', description: 'same' },
  ), false);
});

test('unknown fields do not participate in the R3 canonical identity', () => {
  const known = {
    sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n,
    title: 'Café phone', description: 'same',
  };
  const first = identity(known);
  const second = identity({ ...known, unknown: { extension: 'different', values: [1, true, null] }, ignored: 'also different' });
  assert.equal(first.canonical, second.canonical);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.lockKey, second.lockKey);
});

test('R3 v1 canonical, SHA-256 fingerprint and signed advisory key match a fixed golden vector', () => {
  const value = {
    sellerId: 's-1007', categoryId: 'c-phones', priceVnd: 9007199254740993n,
    title: ' Café phone ', description: 'same',
  };
  const actual = identity(value);
  assert.equal(actual.canonical,
    '["listing-r3-v1","s-1007","c-phones","9007199254740993","café phone","same"]');
  assert.equal(actual.fingerprint, 'r3:v1:8a12c0cbc7ba2524d73418837188831d9a1df019c99fa21744dc9aef8077b787');
  assert.equal(actual.lockKey, '4318401880842191228');

  const min = identity({ ...value, priceVnd: 0n });
  const max = identity({ ...value, priceVnd: 9223372036854775807n });
  for (const result of [actual, min, max]) {
    const lockKey = BigInt(result.lockKey);
    assert.ok(lockKey >= -(1n << 63n) && lockKey <= (1n << 63n) - 1n);
    assert.equal(typeof result.lockKey, 'string');
  }
  assert.throws(() => identity({ ...value, priceVnd: -1n }), /nonnegative int64 bigint/);
  assert.throws(() => identity({ ...value, priceVnd: 9223372036854775808n }), /nonnegative int64 bigint/);
});
