import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/http/json-codec';

interface CanonicalRequestModule {
  canonicalizeRequest?: (value: unknown) => string;
  hashCanonicalRequest?: (value: unknown) => string;
}

function loadCanonicalizer(): CanonicalRequestModule {
  try { return require('../src/submission/canonical-request') as CanonicalRequestModule; }
  catch { return {}; }
}

function canonicalizer(): Required<CanonicalRequestModule> {
  const module = loadCanonicalizer();
  assert.equal(typeof module.canonicalizeRequest, 'function', 'production canonicalizer must be available');
  assert.equal(typeof module.hashCanonicalRequest, 'function', 'production canonical hash must be available');
  return module as Required<CanonicalRequestModule>;
}

function parsed(text: string): unknown {
  return parseJson(text);
}

test('canonical request helper preserves complete JSON identity exactly', () => {
  const { canonicalizeRequest, hashCanonicalRequest } = canonicalizer();

  const ordered = parsed('{"a":1,"b":2}');
  const reordered = parsed('{ "b" : 2.0, "a" : 1e0 }');
  assert.equal(canonicalizeRequest(ordered), canonicalizeRequest(reordered));
  const orderedHash = hashCanonicalRequest(ordered);
  const reorderedHash = hashCanonicalRequest(reordered);
  assert.equal(orderedHash, reorderedHash);

  assert.notEqual(canonicalizeRequest(parsed('{"value":[1,2]}')), canonicalizeRequest(parsed('{"value":[2,1]}')));
  assert.notEqual(canonicalizeRequest(parsed('{"known":1}')), canonicalizeRequest(parsed('{"known":1,"extra":null}')));
  assert.notEqual(canonicalizeRequest(parsed('{"extra":1}')), canonicalizeRequest(parsed('{"extra":2}')));

  assert.equal(canonicalizeRequest(parsed('{"a":1}')), canonicalizeRequest(parsed('{"\\u0061":1}')));
  assert.notEqual(canonicalizeRequest(parsed('{"value":"\\ud800"}')), canonicalizeRequest(parsed('{"value":"\\ufffd"}')));
  assert.notEqual(canonicalizeRequest(parsed('{"\\ud800":1}')), canonicalizeRequest(parsed('{"\\ufffd":1}')));

  for (const [left, right] of [
    ['1', '1.0'],
    ['1', '1e0'],
    ['1000', '1e3'],
    ['-0', '0'],
  ]) {
    assert.equal(canonicalizeRequest(parsed(`{"value":${left}}`)), canonicalizeRequest(parsed(`{"value":${right}}`)));
  }
  assert.notEqual(
    canonicalizeRequest(parsed('{"value":9007199254740992}')),
    canonicalizeRequest(parsed('{"value":9007199254740993}')),
  );

  const hugeExponent = parsed(`{"value":1e${'9'.repeat(256)}}`);
  const compact = canonicalizeRequest(hugeExponent);
  assert.ok(compact.length < 1024, `canonical form expanded an exponent: ${compact.length} characters`);

  assert.notEqual(canonicalizeRequest(parsed('{"value":"1"}')), canonicalizeRequest(parsed('{"value":1}')));
  assert.notEqual(canonicalizeRequest(parsed('{"value":null}')), canonicalizeRequest(parsed('{"value":false}')));

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeRequest(cyclic), /JSON|cyclic|unsupported/i);
  assert.throws(() => canonicalizeRequest({ value: undefined }), /JSON|unsupported/i);
});

test('canonical object keys sort by UTF-16 code units rather than locale', () => {
  const { canonicalizeRequest } = canonicalizer();
  const left = parsed('{"z":1,"é":2,"A":3,"😀":4}');
  const right = parsed('{"😀":4,"A":3,"é":2,"z":1}');
  assert.equal(canonicalizeRequest(left), canonicalizeRequest(right));
});
