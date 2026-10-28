import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { parseJson } from '../src/http/json-codec';

interface HttpHarness {
  baseUrl: string;
  close(): Promise<void>;
  hits(): number;
  resetHits(): void;
  nextIncomingRequest(): Promise<import('node:http').IncomingMessage>;
  persistedCount(): Promise<number>;
}
let harness: HttpHarness;

before(async () => {
  const helper = require('./helpers/t03-app') as { createT03HttpApp?: () => Promise<HttpHarness> };
  assert.equal(typeof helper.createT03HttpApp, 'function', 'T03 test harness must exist');
  harness = await helper.createT03HttpApp!();
});

after(async () => { if (harness) await harness.close(); });

function losslessObject(raw: string): Record<string, unknown> {
  return parseJson(raw) as Record<string, unknown>;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: { connection: 'close', ...init?.headers },
    signal: AbortSignal.timeout(5000),
  });
}

async function sendChunked(path: string, chunks: Buffer[]): Promise<{ status: number; headers: Headers; body: string }> {
  const url = new URL(`${harness.baseUrl}${path}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close' } }, (res) => {
      const output: Buffer[] = [];
      res.on('data', chunk => output.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: new Headers(res.headers as HeadersInit), body: Buffer.concat(output).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('chunked request exceeded 5 seconds')));
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('production interceptor sends a complete JSON object, preserves status, and emits exact bigint token', async () => {
  const response = await send('/test/object');
  const raw = await response.text();
  assert.equal(response.status, 202);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  assert.equal((losslessObject(raw).price_vnd as { toString(): string }).toString(), '9007199254740993');
  assert.match(raw, /"price_vnd":9007199254740993(?:[,}])/);
  assert.doesNotMatch(raw, /^"\{/);
});

test('production response handling preserves 200, 202 and an empty 204 response', async () => {
  const ok = await send('/test/ok');
  assert.equal(ok.status, 200);
  assert.deepEqual(losslessObject(await ok.text()), { ok: true });
  const accepted = await send('/test/accepted');
  assert.equal(accepted.status, 202);
  assert.deepEqual(losslessObject(await accepted.text()), { accepted: true });
  const empty = await send('/test/empty');
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

test('production exception filter maps 400/409/422/404/500 into the shared safe envelope', async () => {
  for (const [path, status, code] of [
    ['/test/fail/400', 400, 'invalid_request'],
    ['/test/fail/409', 409, 'conflict'],
    ['/test/fail/422', 422, 'validation_error'],
    ['/test/fail/404', 404, 'not_found'],
    ['/test/fail/500', 500, 'internal_error'],
    ['/route-that-does-not-exist', 404, 'not_found'],
  ] as const) {
    const response = await send(path);
    assert.equal(response.status, status, path);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
    const envelope = losslessObject(await response.text()) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, code);
    assert.equal(typeof envelope.error.message, 'string');
    if (path === '/test/fail/422') assert.equal(envelope.error.message, 'Unknown seller or category');
    assert.doesNotMatch(envelope.error.message, /sentinel|password|database/i);
  }
});

test('serializer failures return safe500 without a second send and the next request succeeds', async () => {
  for (const path of ['/test/fault/unsafe', '/test/fault/nan', '/test/fault/infinity', '/test/fault/date', '/test/fault/cycle']) {
    const response = await send(path);
    assert.equal(response.status, 500, path);
    const envelope = losslessObject(await response.text()) as { error: { code: string } };
    assert.equal(envelope.error.code, 'internal_error');
    const next = await send('/test/ok');
    assert.equal(next.status, 200);
    await next.arrayBuffer();
  }
});

test('production parser and pipe accept a raw large int64 and return a JSON numeric token', async () => {
  const response = await send('/test/echo', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"seller_id":"s","title":"t","description":"","price_vnd":9007199254740993,"category_id":"c","extension":{"n":1.2300e2}}',
  });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.match(raw, /"price_vnd":9007199254740993(?:[,}])/);
  assert.match(raw, /"extension":\{"n":1\.2300e2\}/);
});

test('production parser, validator, PostgreSQL BIGINT and serializer round-trip int64 and ISO date', async () => {
  for (const price of ['9007199254740993', '9223372036854775807']) {
    const response = await send('/test/persist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: `{"seller_id":"s","title":"t","description":"","price_vnd":${price},"category_id":"c"}`,
    });
    const raw = await response.text();
    assert.equal(response.status, 202);
    assert.match(raw, new RegExp(`"price_vnd":${price}(?:[,}])`));
    const result = losslessObject(raw) as { price_vnd: { toString(): string }; created_at: string };
    assert.equal(result.price_vnd.toString(), price);
    assert.match(result.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(new Date(result.created_at).toISOString(), result.created_at);
  }
});

test('invalid actual HTTP requests return400 and leave the real transport table unchanged', async () => {
  const before = await harness.persistedCount();
  const response = await send('/test/persist', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"seller_id":"s","title":"t","description":"","price_vnd":1000.0,"category_id":"c"}',
  });
  assert.equal(response.status, 400);
  assert.equal((losslessObject(await response.text()) as { error: { code: string } }).error.code, 'invalid_request');
  assert.equal(await harness.persistedCount(), before);
});

test('production parser rejects duplicate/malformed/trailing JSON before the controller', async () => {
  for (const body of ['{"x":1,"x":2}', '{', '{"x":1} trailing']) {
    harness.resetHits();
    const response = await send('/test/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    assert.equal(harness.hits(), 0);
    const envelope = losslessObject(await response.text()) as { error: { code: string } };
    assert.equal(envelope.error.code, 'invalid_request');
  }
});

test('parser enforces media type, UTF-8 charset and identity content encoding policy', async () => {
  const valid = await send('/test/raw', {
    method: 'POST', headers: { 'content-type': 'application/vnd.listing+json; charset=UTF-8' }, body: '{"x":1}',
  });
  assert.equal(valid.status, 200);
  await valid.arrayBuffer();
  const invalidRequests: Array<{ headers: Record<string, string>; body: string }> = [
    { headers: { 'content-type': 'text/json' }, body: '{}' },
    { headers: { 'content-type': 'application/json; charset=iso-8859-1' }, body: '{}' },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}' },
    { headers: {}, body: '{}' },
  ];
  for (const item of invalidRequests) {
    const response = await send('/test/raw', { method: 'POST', headers: item.headers, body: item.body });
    assert.equal(response.status, 400);
    const envelope = losslessObject(await response.text()) as { error: { code: string } };
    assert.equal(envelope.error.code, 'invalid_request');
  }
});

test('parser strictly rejects malformed UTF-8 and bodyless GET needs no content type', async () => {
  const malformed = await send('/test/raw', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  });
  assert.equal(malformed.status, 400);
  assert.equal((losslessObject(await malformed.text()) as { error: { code: string } }).error.code, 'invalid_request');
  const get = await send('/test/ok');
  assert.equal(get.status, 200);
  await get.arrayBuffer();
});

test('empty listing JSON is rejected by the production pipe and aborted input is cleaned up', async () => {
  harness.resetHits();
  const empty = await send('/test/echo', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '0' },
  });
  assert.equal(empty.status, 400);
  assert.equal((losslessObject(await empty.text()) as { error: { code: string } }).error.code, 'invalid_request');

  const url = new URL(`${harness.baseUrl}/test/raw`);
  const incoming = harness.nextIncomingRequest();
  const request = httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '32', connection: 'close' },
  });
  request.on('error', () => {});
  request.flushHeaders();
  const serverRequest = await within(incoming, 5000, 'server did not receive the request headers');
  const observedAbort = new Promise<void>(resolve => serverRequest.once('aborted', resolve));
  request.write('{"partial":');
  request.destroy();
  await within(observedAbort, 5000, 'server did not observe the request abort');

  assert.equal(harness.hits(), 0, 'aborted body must not reach the route handler');
  const next = await send('/test/ok');
  assert.equal(next.status, 200, 'a valid request after abort must still be served');
  await next.arrayBuffer();
});

test('actual raw byte boundary accepts 1 MiB and rejects 1 MiB plus one, including chunked input', async () => {
  const makeBody = (size: number) => {
    const prefix = Buffer.from('{"p":"');
    const suffix = Buffer.from('"}');
    return Buffer.concat([prefix, Buffer.alloc(size - prefix.length - suffix.length, 0x61), suffix]);
  };
  const exact = makeBody(1_048_576);
  assert.equal(exact.byteLength, 1_048_576);
  const accepted = await send('/test/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact });
  assert.equal(accepted.status, 200);
  await accepted.arrayBuffer();
  const oversized = await send('/test/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: makeBody(1_048_577) });
  assert.equal(oversized.status, 413);
  assert.equal((losslessObject(await oversized.text()) as { error: { code: string } }).error.code, 'payload_too_large');

  const prefix = Buffer.from('{"p":"');
  const suffix = Buffer.from('"}');
  const fill = Buffer.alloc(1_048_576 - prefix.length - suffix.length, 0x61);
  const chunked = await sendChunked('/test/raw', [prefix, fill, suffix]);
  assert.equal(chunked.status, 200);
  const chunkedOversized = await sendChunked('/test/raw', [prefix, fill, suffix, Buffer.from(' ')]);
  assert.equal(chunkedOversized.status, 413);
});

test('production raw parser decodes a UTF-8 code point split across network chunks', async () => {
  const bytes = Buffer.from('{"text":"😀"}', 'utf8');
  const start = bytes.indexOf(0xf0);
  assert.ok(start > 0);
  const response = await sendChunked('/test/raw', [bytes.subarray(0, start + 2), bytes.subarray(start + 2)]);
  assert.equal(response.status, 200);
  assert.deepEqual(losslessObject(response.body), { received: true });
});

test('actual JSON body depth accepts 128 and rejects 129 with the same parser envelope', async () => {
  const valid = `${'['.repeat(128)}0${']'.repeat(128)}`;
  const accepted = await send('/test/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: valid });
  assert.equal(accepted.status, 200);
  await accepted.arrayBuffer();
  const invalid = `${'['.repeat(129)}0${']'.repeat(129)}`;
  const rejected = await send('/test/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: invalid });
  assert.equal(rejected.status, 400);
  assert.equal((losslessObject(await rejected.text()) as { error: { code: string } }).error.code, 'invalid_request');
});
