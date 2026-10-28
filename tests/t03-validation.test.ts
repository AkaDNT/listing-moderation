import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/http/json-codec';

interface ValidatedListingRequest {
  seller_id: string;
  title: string;
  description: string;
  price_vnd: bigint;
  category_id: string;
  original: Record<string, unknown>;
}
interface ListingRequestPipeLike { transform(value: unknown): ValidatedListingRequest; }

function createPipe(): ListingRequestPipeLike {
  const module = require('../src/http/listing-request.pipe') as { ListingRequestPipe?: new () => ListingRequestPipeLike };
  assert.equal(typeof module.ListingRequestPipe, 'function', 'production listing request pipe must be available');
  return new module.ListingRequestPipe!();
}

function body(overrides: Record<string, unknown> = {}): unknown {
  const parsed = parseJson('{"seller_id":"s-1001","title":"Listing","description":"","price_vnd":9007199254740993,"category_id":"c-phones"}') as Record<string, unknown>;
  return Object.assign(parsed, overrides);
}

test('listing pipe returns typed bigint and preserves all unknown fields without mutation', () => {
  const request = body({ extension: { count: parseJson('1.2300e2'), nested: ['keep'] } }) as Record<string, unknown>;
  const before = JSON.stringify(request, (_key, value) => typeof value === 'object' && value !== null && 'value' in value ? value.value : value);
  const result = createPipe().transform(request);
  assert.equal(result.price_vnd, 9007199254740993n);
  assert.equal(result.original, request);
  assert.equal((result.original.extension as { nested: string[] }).nested[0], 'keep');
  assert.equal(JSON.stringify(request, (_key, value) => typeof value === 'object' && value !== null && 'value' in value ? value.value : value), before);
});

test('listing pipe enforces the required object shape and string field types', () => {
  const pipe = createPipe();
  for (const input of [null, [], 'listing', 1]) assert.throws(() => pipe.transform(input));
  for (const key of ['seller_id', 'title', 'description', 'price_vnd', 'category_id']) {
    const missing = { ...(body() as object) } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => pipe.transform(missing), `must require ${key}`);
  }
  for (const key of ['seller_id', 'title', 'description', 'category_id']) {
    assert.throws(() => pipe.transform(body({ [key]: 7 })), `must reject non-string ${key}`);
  }
});

test('title and description limits count Unicode code points and preserve submitted text', () => {
  const pipe = createPipe();
  const title = '😀'.repeat(200);
  const description = 'e\u0301'.repeat(2500);
  const result = pipe.transform(body({ title, description }));
  assert.equal(result.title, title);
  assert.equal(result.description, description);
  assert.throws(() => pipe.transform(body({ title: '' })));
  assert.throws(() => pipe.transform(body({ title: '😀'.repeat(201) })));
  assert.equal(pipe.transform(body({ description: '😀'.repeat(5000) })).description.length, 10000);
  assert.throws(() => pipe.transform(body({ description: '😀'.repeat(5001) })));
  assert.equal(pipe.transform(body({ title: '  title  ' })).title, '  title  ');
});

test('listing pipe enforces strict price token policy and returns standard bad-request metadata', () => {
  const pipe = createPipe();
  for (const raw of ['-1', '1000.0', '1e3', '1.2300e2', '1e-1', '9223372036854775808', '"1000"', 'null', 'true']) {
    let thrown: unknown;
    try { pipe.transform(parseJson(`{"seller_id":"s","title":"t","description":"","price_vnd":${raw},"category_id":"c"}`)); }
    catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error, `must reject price ${raw}`);
    assert.equal((thrown as { status?: number }).status, 400);
    assert.equal((thrown as { code?: string }).code, 'invalid_request');
  }
});
