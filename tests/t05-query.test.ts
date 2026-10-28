import assert from 'node:assert/strict';
import { test } from 'node:test';

interface ParsedListingQuery {
  sellerId?: string;
  status?: string;
  limit: number;
}

interface ListingQueryModule {
  parseListingQuery?: (rawQuery: string) => ParsedListingQuery;
  isStorablePostgresText?: (value: string) => boolean;
}

function loadQueryParser(): ListingQueryModule {
  try { return require('../src/listings/listing-query') as ListingQueryModule; }
  catch { return {}; }
}

test('production listing query parser enforces the approved raw-query contract', () => {
  const parser = loadQueryParser();
  assert.equal(typeof parser.parseListingQuery, 'function',
    'production raw listing query parser must be available');
  const parse = parser.parseListingQuery!;

  assert.deepEqual(parse(''), { sellerId: undefined, status: undefined, limit: 20 });
  assert.deepEqual(parse('?limit=020&status=pending&seller_id=s-1001'), {
    sellerId: 's-1001', status: 'pending', limit: 20,
  });
  assert.deepEqual(parse('limit=001'), { sellerId: undefined, status: undefined, limit: 1 });
  assert.deepEqual(parse('limit=100'), { sellerId: undefined, status: undefined, limit: 100 });
  assert.deepEqual(parse('seller_id='), { sellerId: '', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=%00'), { sellerId: '\u0000', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=%EF%BF%BD'), { sellerId: '\ufffd', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=caf%C3%A9'), { sellerId: 'café', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=a+b'), { sellerId: 'a b', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=a%2Bb'), { sellerId: 'a+b', status: undefined, limit: 20 });
  assert.deepEqual(parse('seller_id=%2520'), { sellerId: '%20', status: undefined, limit: 20 });
  assert.deepEqual(parse('extension=%FF&other=%ZZ'), {
    sellerId: undefined, status: undefined, limit: 20,
  });

  for (const value of ['', '0', '101', '-1', '+1', '1.0', '1e1', ' 1', '1 ', 'NaN', 'Infinity', '9'.repeat(400)]) {
    assert.throws(() => parse('limit=' + value), error =>
      error instanceof Error && (error as Error & { status?: number }).status === 400,
      'limit=' + JSON.stringify(value) + ' must return HTTP 400');
  }

  for (const status of ['PENDING', 'draft', '']) {
    assert.throws(() => parse('status=' + status), error =>
      error instanceof Error && (error as Error & { status?: number }).status === 400,
      'status=' + JSON.stringify(status) + ' must return HTTP 400');
  }

  for (const raw of [
    'seller_id=%FF',
    'seller_id=%ED%A0%80',
    'seller_id=%C3%28',
    'seller_id=%ZZ',
    'seller_id=%',
    'status=%FF',
    'limit=%C3%28',
  ]) {
    assert.throws(() => parse(raw), error =>
      error instanceof Error && (error as Error & { status?: number }).status === 400,
      raw + ' must reject malformed percent or UTF-8 encoding');
  }

  for (const raw of [
    'seller_id=s-1&seller_id=s-1',
    'seller_id=s-1&%73eller_id=s-2',
    'status=pending&status=pending',
    'limit=10&limit=20',
    'seller_id%5B%5D=s-1',
    'seller_id%5Bx%5D=s-1',
    'status%5B%5D=pending',
    'limit%5Bx%5D=20',
    'seller_id%5B%FF%5D=s-1',
  ]) {
    assert.throws(() => parse(raw), error =>
      error instanceof Error && (error as Error & { status?: number }).status === 400,
      raw + ' must reject duplicate or bracket-shaped known fields');
  }

  for (const status of [
    'pending', 'auto_approved', 'auto_rejected', 'needs_human',
    'published', 'rejected', 'expired',
  ]) {
    assert.equal(parse('status=' + status).status, status);
  }

  assert.equal(typeof parser.isStorablePostgresText, 'function', 'production PostgreSQL text guard must be available');
  const storable = parser.isStorablePostgresText!;
  assert.equal(storable(''), true);
  assert.equal(storable('valid café 😀 �'), true);
  assert.equal(storable('nul\u0000text'), false);
  assert.equal(storable('\ud800'), false);
  assert.equal(storable('\udc00'), false);
  assert.equal(storable('😀'), true);
});
