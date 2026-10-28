import assert from 'node:assert/strict';
import { test } from 'node:test';

interface MapperModule {
  mapListing?: (row: Record<string, unknown>) => Record<string, unknown>;
}

function loadMapper(): MapperModule {
  try { return require('../src/listings/listing.mapper') as MapperModule; }
  catch { return {}; }
}

const pendingRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'listing-1', seller_id: 'seller-1', category_id: 'phones', title: 'Phone',
  description: 'Details', price_vnd: '9007199254740993', status: 'pending',
  decision_json: null, decided_at: null, created_at: new Date('2026-10-28T10:20:30.123Z'),
  ...overrides,
});

test('production listing mapper preserves int64 and projects pending DTO with explicit nulls', () => {
  const mapper = loadMapper();
  assert.equal(typeof mapper.mapListing, 'function', 'production listing mapper must be available');
  assert.deepEqual(mapper.mapListing!(pendingRow()), {
    id: 'listing-1', seller_id: 'seller-1', category_id: 'phones', title: 'Phone',
    description: 'Details', price_vnd: 9007199254740993n, status: 'pending',
    created_at: '2026-10-28T10:20:30.123Z', decision: null, decided_at: null,
  });
});

test('production listing mapper parses decision JSON losslessly and rejects inconsistent stored rows', () => {
  const mapper = loadMapper();
  assert.equal(typeof mapper.mapListing, 'function', 'production listing mapper must be available');
  const map = mapper.mapListing!;
  const mapped = map(pendingRow({
    status: 'published', decision_json: '{"outcome":"approved","reasons":[{"rule_id":"R1","message":"clear","detail":{"n":9007199254740993}}]}',
    decided_at: new Date('2026-10-28T10:21:00.000Z'),
  }));
  assert.equal((mapped.decision as { reasons: Array<{ detail: { n: { toString(): string } } }> }).reasons[0].detail.n.toString(), '9007199254740993');
  assert.equal(mapped.decided_at, '2026-10-28T10:21:00.000Z');
  assert.deepEqual(Object.keys(mapped).sort(), [
    'category_id', 'created_at', 'decided_at', 'decision', 'description', 'id',
    'price_vnd', 'seller_id', 'status', 'title',
  ].sort());

  for (const bad of [
    pendingRow({ price_vnd: '01' }), pendingRow({ price_vnd: '-1' }),
    pendingRow({ price_vnd: '9223372036854775808' }), pendingRow({ status: 'draft' }),
    pendingRow({ created_at: new Date(NaN) }), pendingRow({ status: 'pending', decision_json: '{}' }),
    pendingRow({ status: 'published', decision_json: null, decided_at: new Date() }),
    pendingRow({ status: 'published', decision_json: '{"outcome":"approved","reasons":[{"rule_id":7}]}', decided_at: new Date() }),
  ]) assert.throws(() => map(bad), TypeError);
});
