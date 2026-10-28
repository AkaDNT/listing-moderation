import assert from 'node:assert/strict';
import { request as httpRequest, ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { createApi } from '../src/api';
import { Database } from '../src/db/database';
import { DATABASE } from '../src/db/database.module';
import { loadBootstrapAssets } from '../src/db/assets';
import { parseJson } from '../src/http/json-codec';
import { hashCanonicalRequest } from '../src/submission/canonical-request';

type HttpIncomingMessage = IncomingMessage & { res?: ServerResponse };
import { createTestDatabase } from './helpers/postgres';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let app: Awaited<ReturnType<typeof createApi>>;
let database: Database;
let baseUrl: string;

before(async () => {
  fixture = await createTestDatabase();
  app = await createApi({
    DATABASE_URL: fixture.url,
    PORT: '8080',
    POLL_INTERVAL_MS: '1000',
    LISTING_TTL_DAYS: '30',
  }, await loadBootstrapAssets());
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

async function post(raw: string, key?: string): Promise<{ status: number; raw: string; value: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const response = await fetch(`${baseUrl}/v1/listings`, {
    method: 'POST', headers, body: raw, signal: AbortSignal.timeout(5000),
  });
  const responseText = await response.text();
  let value: unknown;
  try { value = parseJson(responseText); } catch { value = undefined; }
  return { status: response.status, raw: responseText, value };
}

async function counts(): Promise<{ listings: string; keys: string; jobs: string; history: string }> {
  const result = await database.query<{ listings: string; keys: string; jobs: string; history: string }>(
    `SELECT (SELECT count(*)::text FROM listings) AS listings,
            (SELECT count(*)::text FROM submission_keys) AS keys,
            (SELECT count(*)::text FROM moderation_jobs) AS jobs,
            (SELECT count(*)::text FROM moderation_history) AS history`,
  );
  return result.rows[0];
}

const validRaw = '{"seller_id":"s-1001","title":"Production entrypoint listing","description":"","price_vnd":9007199254740993,"category_id":"c-phones"}';

async function requestWithHeaders(
  headers: Record<string, string | string[]>,
  rawBody: string,
): Promise<{ status: number; body: string; headersDistinct: IncomingMessage['headersDistinct'] }> {
  const incoming = new Promise<HttpIncomingMessage>(resolve =>
    app.getHttpServer().once('request', (request: IncomingMessage) => resolve(request as HttpIncomingMessage)));
  let resolveResponse!: (value: { status: number; body: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const client = httpRequest(baseUrl, {
    path: '/v1/listings',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(rawBody)),
      connection: 'close',
      ...headers,
    },
    signal: AbortSignal.timeout(5000),
  }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.once('end', () => resolveResponse({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
  });
  client.once('error', rejectResponse);
  client.end(rawBody);
  const response = await responsePromise;
  const request = await within(incoming, 5000, 'Node server did not expose HTTP request headers');
  return { ...response, headersDistinct: request.headersDistinct };
}

function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForCommittedSubmission(key: string): Promise<{ id: string; status: string }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await database.query<{ id: string; status: string; jobs: string }>(
      `SELECT l.id,l.status,(SELECT count(*)::text FROM moderation_jobs j WHERE j.listing_id=l.id) AS jobs
       FROM submission_keys k JOIN listings l ON l.id=k.listing_id WHERE k.key=$1`, [key],
    );
    if (result.rows.length === 1) {
      assert.equal(result.rows[0].jobs, '1', 'lost-response observation requires the initial job to be committed');
      return { id: result.rows[0].id, status: result.rows[0].status };
    }
    await delay(25);
  }
  const diagnostics = await database.query(
    `SELECT pid, application_name, state, wait_event_type, wait_event, query
     FROM pg_stat_activity WHERE datname=current_database() ORDER BY pid`,
  );
  throw new Error(`submission key ${key} was not committed within 5000ms; PostgreSQL=${JSON.stringify(diagnostics.rows)}`);
}

test('actual API entrypoint accepts raw int64 and persists pending listing plus queued job without moderation', async () => {
  const response = await post(validRaw);
  assert.equal(response.status, 202);
  const body = response.value as { id: string; status: string };
  assert.equal(typeof body.id, 'string');
  assert.equal(body.status, 'pending');
  const row = await database.query<{ price_vnd: string; status: string; decision: null; decided_at: null; job_state: string }>(
    `SELECT l.price_vnd::text,l.status,l.decision,l.decided_at,j.state AS job_state
     FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [body.id],
  );
  assert.deepEqual(row.rows, [{ price_vnd: '9007199254740993', status: 'pending', decision: null, decided_at: null, job_state: 'queued' }]);
});

test('actual API entrypoint replays current listing status and rejects changed unknown fields', async () => {
  const key = 'http-replay-key';
  const raw = '{"seller_id":"s-1001","title":"Keyed HTTP listing","description":"","price_vnd":1000,"category_id":"c-phones","extension":{"x":1}}';
  const created = await post(raw, key);
  assert.equal(created.status, 202);
  const id = (created.value as { id: string }).id;
  await database.query(
    `UPDATE listings SET status='needs_human', decision='{"outcome":"escalated","reasons":[]}'::jsonb,
       decided_at='2026-01-01T00:00:00Z' WHERE id=$1`, [id],
  );
  const replay = await post(raw, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.value, { id, status: 'needs_human' });
  const conflict = await post(raw.replace('"x":1', '"x":2'), key);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.value, { error: { code: 'conflict', message: 'Idempotency key was already used with a different request' } });
  assert.deepEqual(await counts(), { listings: '2', keys: '1', jobs: '2', history: '0' });
});

test('actual API entrypoint rejects invalid keys and unknown references without writing', async () => {
  const beforeCounts = await counts();
  const invalidKey = await post(validRaw, 'bad key');
  assert.equal(invalidKey.status, 400);
  assert.deepEqual(invalidKey.value, { error: { code: 'invalid_request', message: 'Idempotency-Key has invalid syntax or length' } });
  for (const raw of [
    validRaw.replace('s-1001', 'unknown-seller'),
    validRaw.replace('c-phones', 'unknown-category'),
  ]) {
    const response = await post(raw, raw.includes('unknown-seller') ? 'ref-unknown-seller' : 'ref-unknown-category');
    assert.equal(response.status, 422);
    assert.deepEqual(response.value, { error: { code: 'validation_error', message: 'Unknown seller or category' } });
  }
  assert.deepEqual(await counts(), beforeCounts);
});

test('actual API entrypoint treats absent key as independent submissions', async () => {
  const first = await post(validRaw);
  const second = await post(validRaw);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.notEqual((first.value as { id: string }).id, (second.value as { id: string }).id);
});

test('invalid keyed HTTP input does not consume the key before a corrected submission', async () => {
  const key = 'correct-after-invalid';
  const beforeCounts = await counts();
  const invalid = await post(validRaw.replace('9007199254740993', '1000.0'), key);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await counts(), beforeCounts);
  const corrected = await post(validRaw, key);
  assert.equal(corrected.status, 202);
  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 1),
    keys: String(Number(beforeCounts.keys) + 1),
    jobs: String(Number(beforeCounts.jobs) + 1),
    history: beforeCounts.history,
  });
});

test('actual HTTP path preserves int64 max and rejects malformed or out-of-range keyed bodies without reserving keys', async () => {
  const beforeCounts = await counts();
  const maxKey = 'http-int64-max';
  const maxRaw = validRaw.replace('9007199254740993', '9223372036854775807');
  const maxResponse = await post(maxRaw, maxKey);
  assert.equal(maxResponse.status, 202);
  const maxId = (maxResponse.value as { id: string }).id;
  const storedMax = await database.query<{ price_vnd: string }>(
    'SELECT price_vnd::text FROM listings WHERE id=$1', [maxId],
  );
  assert.deepEqual(storedMax.rows, [{ price_vnd: '9223372036854775807' }]);

  const afterMax = await counts();
  const rangeKey = 'http-int64-overflow';
  const overflow = await post(validRaw.replace('9007199254740993', '9223372036854775808'), rangeKey);
  assert.equal(overflow.status, 400);
  assert.deepEqual(await counts(), afterMax);
  const correctedRange = await post(validRaw, rangeKey);
  assert.equal(correctedRange.status, 202);

  const afterRange = await counts();
  const malformedKey = 'http-malformed-json';
  const malformed = await post('{', malformedKey);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await counts(), afterRange);
  const correctedMalformed = await post(validRaw, malformedKey);
  assert.equal(correctedMalformed.status, 202);

  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 3),
    keys: String(Number(beforeCounts.keys) + 3),
    jobs: String(Number(beforeCounts.jobs) + 3),
    history: beforeCounts.history,
  });
});

const unpersistableListingTextCases = [
  { field: 'title', value: 'nul\u0000value', name: 'title with NUL' },
  { field: 'title', value: 'high\ud800value', name: 'title with lone high surrogate' },
  { field: 'title', value: 'trailing\ud800', name: 'title ending with lone high surrogate' },
  { field: 'title', value: 'low\udc00value', name: 'title with lone low surrogate' },
  { field: 'description', value: 'nul\u0000value', name: 'description with NUL' },
  { field: 'description', value: 'high\ud800value', name: 'description with lone high surrogate' },
  { field: 'description', value: 'low\udc00value', name: 'description with lone low surrogate' },
];

for (const [index, item] of unpersistableListingTextCases.entries()) {
  test(`${item.name} returns 400 without reserving the key`, async () => {
    const beforeCounts = await counts();
    const key = `unsupported-listing-text-${index}`;
    const body: Record<string, unknown> = {
      seller_id: 's-1001', title: 'Valid title', description: '',
      price_vnd: 1000, category_id: 'c-phones',
    };
    body[item.field] = item.value;
    const invalid = await post(JSON.stringify(body), key);
    assert.equal(invalid.status, 400);
    assert.equal((invalid.value as { error?: { code?: string } }).error?.code, 'invalid_request');
    assert.deepEqual(await counts(), beforeCounts);

    const corrected = await post(validRaw, key);
    assert.equal(corrected.status, 202);
    assert.deepEqual(await counts(), {
      listings: String(Number(beforeCounts.listings) + 1),
      keys: String(Number(beforeCounts.keys) + 1),
      jobs: String(Number(beforeCounts.jobs) + 1),
      history: beforeCounts.history,
    });
  });
}

for (const [index, item] of [
  { field: 'seller_id', value: 'unknown\u0000seller', alias: undefined },
  { field: 'category_id', value: 'unknown\u0000category', alias: undefined },
  { field: 'seller_id', value: 'review-\ud800-seller', alias: 'review-\ufffd-seller' },
  { field: 'category_id', value: 'review-\ud800-category', alias: 'review-\ufffd-category' },
].entries()) {
  test(`${item.field} with an unpersistable value returns 422 without aliasing a PostgreSQL ID (${index})`, async () => {
    const beforeCounts = await counts();
    if (item.alias && item.field === 'seller_id') {
      await database.query(
        'INSERT INTO sellers(id,name,trust_score,verified,note) VALUES($1,$2,$3,$4,$5)',
        [item.alias, 'Replacement collision fixture', 0, false, 'test-only'],
      );
    }
    if (item.alias && item.field === 'category_id') {
      await database.query(
        'INSERT INTO categories(id,name,median_price_vnd) VALUES($1,$2,$3)',
        [item.alias, 'Replacement collision fixture', '1000'],
      );
    }
    const key = `unsupported-reference-text-${index}`;
    const body: Record<string, unknown> = {
      seller_id: 's-1001', title: 'Valid title', description: '',
      price_vnd: 1000, category_id: 'c-phones',
    };
    body[item.field] = item.value;
    const response = await post(JSON.stringify(body), key);
    assert.equal(response.status, 422);
    assert.deepEqual(response.value, { error: { code: 'validation_error', message: 'Unknown seller or category' } });
    assert.deepEqual(await counts(), beforeCounts);

    const corrected = await post(validRaw, key);
    assert.equal(corrected.status, 202);
    assert.equal((await counts()).keys, String(Number(beforeCounts.keys) + 1));
  });
}

for (const [index, item] of [
  { seller_id: 'invalid\u0000seller', title: 'has\u0000nul', price_vnd: 1000 },
  { seller_id: 'invalid\u0000seller', title: 'Valid title', price_vnd: 1000.0 },
].entries()) {
  test(`malformed request fields return 400 before unrepresentable reference IDs (${index})`, async () => {
    const beforeCounts = await counts();
    const key = `invalid-before-reference-${index}`;
    const raw = JSON.stringify({
      ...item, description: '', category_id: 'c-phones',
    }).replace('"price_vnd":1000', index === 1 ? '"price_vnd":1000.0' : '"price_vnd":1000');
    const response = await post(raw, key);
    assert.equal(response.status, 400);
    assert.equal((response.value as { error?: { code?: string } }).error?.code, 'invalid_request');
    assert.deepEqual(await counts(), beforeCounts);

    const corrected = await post(validRaw, key);
    assert.equal(corrected.status, 202);
  });
}

test('unknown JSON fields retain NUL and lone surrogates in keyed identity without PostgreSQL text coercion', async () => {
  const key = 'unknown-lossless-text';
  const beforeCounts = await counts();
  const body = JSON.parse(validRaw) as Record<string, unknown>;
  body.price_vnd = 1000;
  body.extension = { text: 'unknown\u0000\ud800' };
  const raw = JSON.stringify(body);
  const created = await post(raw, key);
  assert.equal(created.status, 202);
  const replay = await post(raw, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.value, created.value);
  const changed = await post(raw.replace('unknown\\u0000\\ud800', 'unknown\\ufffd'), key);
  assert.equal(changed.status, 409);
  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 1),
    keys: String(Number(beforeCounts.keys) + 1),
    jobs: String(Number(beforeCounts.jobs) + 1),
    history: beforeCounts.history,
  });
});

test('valid Unicode scalar text persists exactly through production HTTP and PostgreSQL', async () => {
  const body: Record<string, unknown> = {
    seller_id: 's-1001', title: 'Emoji 😀 title', description: 'Replacement � remains literal',
    price_vnd: 1000, category_id: 'c-phones',
  };
  const response = await post(JSON.stringify(body), 'valid-unicode-scalar-text');
  assert.equal(response.status, 202);
  const id = (response.value as { id: string }).id;
  const stored = await database.query<{ title: string; description: string }>(
    'SELECT title,description FROM listings WHERE id=$1', [id],
  );
  assert.deepEqual(stored.rows, [{ title: body.title, description: body.description }]);
});

test('wire duplicate canonical keys reject and duplicate X aliases remain keyless', async () => {
  const beforeCounts = await counts();
  const duplicate = await requestWithHeaders({ 'Idempotency-Key': ['duplicate-wire-key', 'duplicate-wire-key'] }, validRaw);
  assert.equal(duplicate.status, 400);
  assert.deepEqual(duplicate.headersDistinct['idempotency-key'], ['duplicate-wire-key', 'duplicate-wire-key']);
  assert.deepEqual(await counts(), beforeCounts);

  const aliasFirst = await requestWithHeaders({ 'X-Idempotency-Key': 'alias-key' }, validRaw);
  const aliasSecond = await requestWithHeaders({ 'X-Idempotency-Key': 'alias-key' }, validRaw);
  assert.equal(aliasFirst.status, 202);
  assert.equal(aliasSecond.status, 202);
  const firstBody = parseJson(aliasFirst.body) as { id: string };
  const secondBody = parseJson(aliasSecond.body) as { id: string };
  assert.notEqual(firstBody.id, secondBody.id);
  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 2),
    keys: beforeCounts.keys,
    jobs: String(Number(beforeCounts.jobs) + 2),
    history: beforeCounts.history,
  });
});

test('50 independent HTTP connections with the same key produce one 202 and 49 current-status replays', async () => {
  const beforeCounts = await counts();
  const responses = await Promise.all(Array.from({ length: 50 }, () => post(validRaw, 'http-50-way-key')));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 49);
  const values = responses.map(response => response.value as { id: string; status: string });
  assert.equal(new Set(values.map(value => value.id)).size, 1);
  assert.ok(values.every(value => value.status === 'pending'));
  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 1),
    keys: String(Number(beforeCounts.keys) + 1),
    jobs: String(Number(beforeCounts.jobs) + 1),
    history: beforeCounts.history,
  });
});

test('valid mixed HTTP bodies choose one committed hash and reject only the nonmatching requests', async () => {
  const beforeCounts = await counts();
  const submissions = Array.from({ length: 20 }, (_, index) => {
    const marker = index % 2;
    const raw = `{"seller_id":"s-1001","title":"Mixed HTTP listing","description":"","price_vnd":1000,"category_id":"c-phones","extension":{"marker":${marker}}}`;
    return { raw, hash: hashCanonicalRequest(parseJson(raw)) };
  });
  const responses = await Promise.all(submissions.map(item => post(item.raw, 'http-mixed-body-key')));
  const winner = await database.query<{ request_hash: string; listing_id: string; title: string }>(
    `SELECT k.request_hash,k.listing_id,l.title FROM submission_keys k
     JOIN listings l ON l.id=k.listing_id WHERE k.key='http-mixed-body-key'`,
  );
  assert.equal(winner.rows.length, 1);
  const winningHash = winner.rows[0].request_hash;
  const matches = submissions.map(item => item.hash === winningHash);
  assert.equal(matches.filter(Boolean).length, 10);
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 9);
  assert.equal(responses.filter(response => response.status === 409).length, 10);
  responses.forEach((response, index) => assert.equal(response.status === 409, !matches[index]));
  const replayIds = responses.filter(response => response.status !== 409).map(response => (response.value as { id: string }).id);
  assert.ok(replayIds.every(id => id === winner.rows[0].listing_id));
  assert.deepEqual(await counts(), {
    listings: String(Number(beforeCounts.listings) + 1),
    keys: String(Number(beforeCounts.keys) + 1),
    jobs: String(Number(beforeCounts.jobs) + 1),
    history: beforeCounts.history,
  });
});

test('complete keyed request with dropped response commits once and retry returns original listing', async () => {
  const key = 'http-lost-response-key';
  const server = app.getHttpServer();
  const incoming = new Promise<HttpIncomingMessage>(resolve => server.once('request',
    (request: IncomingMessage) => resolve(request as HttpIncomingMessage)));
  const client = httpRequest(baseUrl, {
    path: '/v1/listings',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(validRaw)),
      'Idempotency-Key': key,
      connection: 'keep-alive',
    },
  });
  client.on('error', () => {});
  client.end(validRaw);
  const serverRequest = await within(incoming, 5000, 'server did not receive complete keyed request headers');
  const requestEnded = new Promise<void>(resolve => serverRequest.once('end', resolve));
  const serverResponse = await within(new Promise<ServerResponse>(resolve => {
    const response = serverRequest.res;
    if (!response) throw new Error('Node server request did not expose its response');
    response.once('finish', () => resolve(response));
  }), 5000, 'server did not finish the response for the complete keyed request');
  await within(requestEnded, 5000, 'server did not read the complete keyed request body');
  assert.equal(serverRequest.complete, true, 'server must have received the complete HTTP request');
  assert.deepEqual(serverRequest.headersDistinct['idempotency-key'], [key]);
  assert.equal(serverResponse.statusCode, 202, 'server must complete the original submission before its client loses the response');
  client.destroy();
  const committed = await waitForCommittedSubmission(key);
  assert.equal(committed.status, 'pending');
  const retry = await post(validRaw, key);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value, { id: committed.id, status: 'pending' });
});
