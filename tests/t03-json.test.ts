import assert from 'node:assert/strict';
import { test } from 'node:test';

function loadCodec(): {
  parseJson?: (text: string) => unknown;
  stringifyJson?: (value: unknown) => string;
} {
  try { return require('../src/http/json-codec') as ReturnType<typeof loadCodec>; }
  catch { return {}; }
}

function codec() {
  const module = loadCodec();
  assert.equal(typeof module.parseJson, 'function', 'production lossless JSON parser must be registered');
  assert.equal(typeof module.stringifyJson, 'function', 'production safe JSON serializer must be registered');
  return module as Required<ReturnType<typeof loadCodec>>;
}

test('lossless parser retains int64 and unknown numeric lexemes', () => {
  const { parseJson } = codec();
  const parsed = parseJson('{"price_vnd":9007199254740993,"unknown":1.2300e2}') as Record<string, { toString(): string }>;
  assert.equal(parsed.price_vnd.toString(), '9007199254740993');
  assert.equal(parsed.unknown.toString(), '1.2300e2');
});

test('lossless parser rejects duplicate keys, malformed JSON, and trailing input', () => {
  const { parseJson } = codec();
  for (const input of ['{"x":1,"x":2}', '{', '{"x":1} trailing']) {
    assert.throws(() => parseJson(input), `must reject ${input}`);
  }
});

test('JSON depth accepts 128 containers, rejects 129, and ignores escaped delimiters inside strings', () => {
  const { parseJson } = codec();
  assert.doesNotThrow(() => parseJson(`${'['.repeat(128)}0${']'.repeat(128)}`));
  assert.throws(() => parseJson(`${'['.repeat(129)}0${']'.repeat(129)}`), /nesting limit/);
  assert.doesNotThrow(() => parseJson(JSON.stringify({ text: '[[[[\\\\"]]]]]' })));
});

test('parser keeps prototype-related property names as own data without mutating prototypes', () => {
  const { parseJson } = codec();
  const parsed = parseJson('{"__proto__":{"polluted":true},"constructor":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'constructor']);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('serializer emits bigint as a numeric token and preserves adjacent strings', () => {
  const { stringifyJson } = codec();
  const raw = stringifyJson({ price_vnd: 9223372036854775807n, description: 'literal "price_vnd": 7' });
  assert.equal(raw, '{"price_vnd":9223372036854775807,"description":"literal \\"price_vnd\\": 7"}');
});

test('serializer rejects unsafe native numbers and non-finite numbers', () => {
  const { stringifyJson } = codec();
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => stringifyJson({ value }));
  }
});

test('serializer rejects invalid Date and cyclic object graphs instead of emitting altered output', () => {
  const { stringifyJson } = codec();
  assert.throws(() => stringifyJson({ at: new Date(Number.NaN) }));
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => stringifyJson(cyclic));
});
