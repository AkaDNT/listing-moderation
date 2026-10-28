import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { isLosslessNumber, parse as parseLossless } from 'lossless-json';
import { parse as parseYaml } from 'yaml';
import { createApi } from '../src/api';
import { Database } from '../src/db/database';
import { DATABASE } from '../src/db/database.module';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let app: Awaited<ReturnType<typeof createApi>>;
let database: Database;
let baseUrl: string;
const listingSchema = (parseYaml(readFileSync('openapi.yaml', 'utf8')) as {
  components: { schemas: { Listing: { required: string[]; properties: Record<string, { type?: string; format?: string }> } } };
}).components.schemas.Listing;

before(async () => {
  fixture = await createTestDatabase();
  app = await createApi({ DATABASE_URL: fixture.url, PORT: '8080', POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' }, await loadBootstrapAssets());
  database = app.get<Database>(DATABASE);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Actual API did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
});

async function get(path: string): Promise<{ status: number; body: string; value: unknown; contentType: string | undefined }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'GET', signal: AbortSignal.timeout(5000) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let value: unknown;
        try { value = parseLossless(body); } catch { value = undefined; }
        resolve({ status: response.statusCode ?? 0, body, value, contentType: response.headers['content-type'] });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function post(priceToken: string, title: string): Promise<string> {
  const raw = `{"seller_id":"s-1001","title":${JSON.stringify(title)},"description":"unicode café","price_vnd":${priceToken},"category_id":"c-phones"}`;
  const response = await fetch(baseUrl + '/v1/listings', {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: raw,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 202);
  return (parseLossless(await response.text()) as { id: string }).id;
}

function assertListing(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null && !Array.isArray(value));
  const listing = value as Record<string, unknown>;
  for (const required of listingSchema.required) assert.ok(Object.hasOwn(listing, required), `OpenAPI Listing required field ${required}`);
  for (const key of ['id', 'seller_id', 'title', 'description', 'category_id', 'status']) assert.equal(typeof listing[key], 'string', key);
  assert.ok(isLosslessNumber(listing.price_vnd), 'price_vnd remains a JSON numeric token');
  assert.match(listing.price_vnd.toString(), /^(0|[1-9][0-9]*)$/);
  assert.equal(listingSchema.properties.price_vnd.type, 'integer');
  assert.equal(listingSchema.properties.price_vnd.format, 'int64');
  assert.equal(typeof listing.created_at, 'string');
  assert.match(listing.created_at as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Number.isFinite(Date.parse(listing.created_at as string)));
  assert.ok(listing.decided_at === null || (typeof listing.decided_at === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(listing.decided_at) && Number.isFinite(Date.parse(listing.decided_at))));
  if (listing.decision !== null) {
    assert.equal(typeof listing.decision, 'object');
    const decision = listing.decision as { outcome?: unknown; reasons?: unknown };
    assert.ok(['approved', 'rejected', 'escalated'].includes(decision.outcome as string));
    assert.ok(Array.isArray(decision.reasons));
    for (const reason of decision.reasons as Array<Record<string, unknown>>) {
      assert.equal(typeof reason.rule_id, 'string');
      assert.equal(typeof reason.message, 'string');
      assert.ok(reason.detail === undefined || (typeof reason.detail === 'object' && reason.detail !== null && !Array.isArray(reason.detail)));
    }
  }
  assert.deepEqual(Object.keys(listing).sort(), [
    'id', 'seller_id', 'title', 'description', 'price_vnd', 'category_id', 'status', 'created_at', 'decided_at', 'decision',
  ].sort());
}

test('actual createApi POST to PostgreSQL to GET preserves int64 tokens, dates, null decision and list envelope', async () => {
  const normal = await post('9007199254740993', 'T05 precision normal');
  const maximum = await post('9223372036854775807', 'T05 precision maximum');
  const one = await get('/v1/listings/' + normal);
  assert.equal(one.status, 200);
  assert.match(one.contentType ?? '', /^application\/json/);
  assertListing(one.value);
  assert.equal((one.value.price_vnd as { toString(): string }).toString(), '9007199254740993');
  assert.equal(one.value.decided_at, null);
  assert.equal(one.value.decision, null);
  assert.equal((one.value as { description: string }).description, 'unicode café');
  const maxOne = await get('/v1/listings/' + maximum);
  assertListing(maxOne.value);
  assert.equal((maxOne.value.price_vnd as { toString(): string }).toString(), '9223372036854775807');

  const list = await get('/v1/listings?limit=100');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray((list.value as { items: unknown[] }).items));
  for (const item of (list.value as { items: unknown[] }).items) assertListing(item);
  const byId = (list.value as { items: Array<Record<string, unknown>> }).items.find(item => item.id === maximum);
  assert.ok(byId);
  assert.equal((byId.price_vnd as { toString(): string }).toString(), '9223372036854775807');
  assert.equal(one.body.includes('"price_vnd":"9007199254740993"'), false);
});

test('actual GET routes apply status, seller, AND, limit, stable ordering, and current decision projection', async () => {
  const id = await post('1000', 'T05 status fixture');
  await database.query(
    `UPDATE listings SET status='needs_human',decision='{"outcome":"escalated","reasons":[{"rule_id":"R5","message":"verify seller","detail":{"source":"test","exact":9007199254740993}}]}'::jsonb,
       decided_at='2026-10-27T00:00:00Z' WHERE id=$1`, [id],
  );
  const exact = await get('/v1/listings?seller_id=s-1001&status=needs_human&limit=020');
  assert.equal(exact.status, 200);
  const items = (exact.value as { items: Array<Record<string, unknown>> }).items;
  assert.ok(items.some(item => item.id === id));
  const listing = items.find(item => item.id === id)!;
  assertListing(listing);
  assert.equal(listing.status, 'needs_human');
  assert.equal(listing.decided_at, '2026-10-27T00:00:00.000Z');
  const decision = listing.decision as { reasons: Array<{ detail: { source: string; exact: { toString(): string } } }> };
  assert.equal(decision.reasons[0].detail.source, 'test');
  assert.equal(decision.reasons[0].detail.exact.toString(), '9007199254740993');
  assert.deepEqual((await get('/v1/listings?seller_id=s-1001&status=published')).value, { items: [] });
  assert.deepEqual((await get('/v1/listings?seller_id=')).value, { items: [] });
  const limited = await get('/v1/listings?seller_id=s-1001&limit=1');
  assert.equal((limited.value as { items: unknown[] }).items.length, 1);

  for (const status of ['auto_approved', 'auto_rejected', 'published', 'rejected', 'expired']) {
    await database.query(
      `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at)
       VALUES($1,'s-1002','c-phones',$1,'status fixture',1,$2,
         '{"outcome":"approved","reasons":[]}'::jsonb,'2026-10-27T00:00:00Z')`,
      ['t05-status-' + status, status],
    );
  }
  for (const status of ['pending', 'auto_approved', 'auto_rejected', 'needs_human', 'published', 'rejected', 'expired']) {
    const response = await get('/v1/listings?status=' + status + '&limit=100');
    assert.equal(response.status, 200, status);
    const matched = (response.value as { items: Array<Record<string, unknown>> }).items;
    assert.ok(matched.length > 0, `fixture for status ${status} is returned`);
    for (const item of matched) { assertListing(item); assert.equal(item.status, status); }
  }
  assert.deepEqual((await get('/v1/listings/not-a-real-id')).value,
    { error: { code: 'not_found', message: 'Listing not found' } });
});

test('actual list route applies default 20 and maximum 100 with more than 100 PostgreSQL rows', async () => {
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,created_at)
     SELECT 'http-bulk-' || n, 's-1002', 'c-phones', 'bulk', '', 1::bigint,
            '2027-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond'
     FROM generate_series(1, 105) AS n`,
  );
  const defaults = await get('/v1/listings?seller_id=s-1002');
  const defaultItems = (defaults.value as { items: Array<Record<string, unknown>> }).items;
  assert.equal(defaultItems.length, 20);
  assert.ok(defaultItems.every(item => String(item.id).startsWith('http-bulk-')));
  const max = await get('/v1/listings?seller_id=s-1002&limit=100');
  const maxItems = (max.value as { items: Array<Record<string, unknown>> }).items;
  assert.equal(maxItems.length, 100);
  assert.equal(maxItems[0].id, 'http-bulk-105');
  assert.equal(maxItems[99].id, 'http-bulk-6');
});

test('actual raw HTTP query decoding rejects malformed known values and validates before NUL short circuit', async () => {
  for (const raw of ['%FF', '%ED%A0%80', '%C3%28', '%ZZ', '%']) {
    const response = await get('/v1/listings?seller_id=' + raw);
    assert.equal(response.status, 400, raw);
    assert.deepEqual(response.value, { error: { code: 'invalid_request', message: 'seller_id has malformed percent encoding or UTF-8' } });
  }
  assert.equal((await get('/v1/listings?seller_id=%00&status=INVALID')).status, 400);
  assert.equal((await get('/v1/listings?seller_id=%00&limit=0')).status, 400);
  assert.deepEqual((await get('/v1/listings?seller_id=%00&limit=20')).value, { items: [] });
  for (const query of [
    'seller_id=x&seller_id=x', 'seller_id%5B%5D=x', 'status=INVALID', 'limit=101',
  ]) assert.equal((await get('/v1/listings?' + query)).status, 400, query);
  assert.equal((await get('/v1/listings?extension=%FF')).status, 200);
  await database.query(`INSERT INTO sellers(id,name,trust_score,verified,note) VALUES($1,'replacement control',80,false,'')`, ['seller-\ufffd']);
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('t05-ufffd','seller-\ufffd','c-phones','Replacement','control',0)`,
  );
  const replacement = await get('/v1/listings?seller_id=seller-%EF%BF%BD');
  assert.equal(replacement.status, 200);
  assert.deepEqual((replacement.value as { items: Array<{ id: string }> }).items.map(item => item.id), ['t05-ufffd']);
  assert.equal((await get('/v1/listings?seller_id=seller-%FF')).status, 400);
  assert.equal((await get('/v1/listings/a%00b')).status, 404);
});

test('actual GET one and list fail safely for persisted malformed reasons and recover on later request', async () => {
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,created_at)
     VALUES('t05-corrupt-reason','s-1001','c-phones','Corrupt','fixture',1,'published',
       '{"outcome":"approved","reasons":[{"rule_id":7}]}'::jsonb,'2026-10-27T00:00:00Z','2028-01-01T00:00:00Z')`,
  );
  for (const path of ['/v1/listings/t05-corrupt-reason', '/v1/listings?seller_id=s-1001&limit=100']) {
    const response = await get(path);
    assert.equal(response.status, 500);
    assert.deepEqual(response.value, { error: { code: 'internal_error', message: 'Internal server error' } });
    assert.equal(response.body.includes('rule_id'), false);
    assert.equal(response.body.includes('SELECT'), false);
  }
  assert.equal((await get('/v1/listings')).status, 500, 'unfiltered list also fails closed on any malformed stored row');
  const valid = await get('/v1/listings?seller_id=s-1002');
  assert.equal(valid.status, 200, 'a valid request still succeeds after mapper failures');
});
