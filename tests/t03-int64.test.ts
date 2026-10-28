import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/http/json-codec';

function loadParser(): (token: unknown) => bigint {
  return require('../src/http/int64').parsePriceInt64 as (token: unknown) => bigint;
}

function token(raw: string): unknown {
  return (parseJson(`{"value":${raw}}`) as { value: unknown }).value;
}

test('price parser accepts zero, negative-zero, unsafe-safe-range values, and int64 maximum exactly', () => {
  const parsePriceInt64 = loadParser();
  assert.equal(parsePriceInt64(token('0')), 0n);
  assert.equal(parsePriceInt64(token('-0')), 0n);
  assert.equal(parsePriceInt64(token('9007199254740993')), 9007199254740993n);
  assert.equal(parsePriceInt64(token('9223372036854775807')), 9223372036854775807n);
});

test('price parser rejects negative, fraction/exponent syntax, and int64 overflow', () => {
  const parsePriceInt64 = loadParser();
  for (const raw of ['-1', '1000.0', '1e3', '1.2300e2', '1e-1', '9223372036854775808']) {
    assert.throws(() => parsePriceInt64(token(raw)), `must reject price token ${raw}`);
  }
});

test('price parser rejects non-JSON-number values and native Numbers', () => {
  const parsePriceInt64 = loadParser();
  for (const value of ['1000', null, true, 1000, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePriceInt64(value));
  }
});
