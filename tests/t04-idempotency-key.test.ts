import assert from 'node:assert/strict';
import { test } from 'node:test';

type DistinctHeaders = Readonly<Record<string, readonly string[] | undefined>>;

interface IdempotencyKeyModule {
  parseIdempotencyKey?: (headersDistinct: DistinctHeaders) => string | undefined;
}

function loadParser(): IdempotencyKeyModule {
  try { return require('../src/submission/idempotency-key') as IdempotencyKeyModule; }
  catch { return {}; }
}

function parser(): Required<IdempotencyKeyModule> {
  const module = loadParser();
  assert.equal(typeof module.parseIdempotencyKey, 'function', 'production idempotency header parser must be available');
  return module as Required<IdempotencyKeyModule>;
}

function canonical(value: string | readonly string[]): DistinctHeaders {
  return { 'idempotency-key': typeof value === 'string' ? [value] : value };
}

test('idempotency key accepts exact project syntax and length boundaries', () => {
  const parseIdempotencyKey = parser().parseIdempotencyKey;
  assert.equal(parseIdempotencyKey(canonical('A')), 'A');
  assert.equal(parseIdempotencyKey(canonical('Az09._~-')), 'Az09._~-');
  assert.equal(parseIdempotencyKey(canonical('k'.repeat(128))), 'k'.repeat(128));
  assert.throws(() => parseIdempotencyKey(canonical('k'.repeat(129))));
  for (const value of ['', 'has space', 'a,b', '"quoted"', 'é', 'a/b', '\tkey']) {
    assert.throws(() => parseIdempotencyKey(canonical(value)), `must reject ${JSON.stringify(value)}`);
  }
});

test('idempotency key preserves case and does not application-normalize parsed values', () => {
  const parseIdempotencyKey = parser().parseIdempotencyKey;
  assert.equal(parseIdempotencyKey(canonical('AbC-1')), 'AbC-1');
  assert.equal(parseIdempotencyKey(canonical('abc-1')), 'abc-1');
  assert.notEqual(parseIdempotencyKey(canonical('AbC-1')), parseIdempotencyKey(canonical('abc-1')));
  assert.throws(() => parseIdempotencyKey(canonical(' key ')));
});

test('duplicate canonical header values are rejected', () => {
  const parseIdempotencyKey = parser().parseIdempotencyKey;
  assert.throws(() => parseIdempotencyKey(canonical(['same', 'same'])));
  assert.throws(() => parseIdempotencyKey(canonical(['first', 'second'])));
});

test('X-Idempotency-Key is ignored and is not an alias', () => {
  const parseIdempotencyKey = parser().parseIdempotencyKey;
  assert.equal(parseIdempotencyKey({ 'x-idempotency-key': ['legacy'] }), undefined);
  assert.equal(parseIdempotencyKey({ 'x-idempotency-key': ['legacy', 'ignored'] }), undefined);
  assert.equal(parseIdempotencyKey({ 'idempotency-key': ['canonical'], 'x-idempotency-key': ['legacy'] }), 'canonical');
});
