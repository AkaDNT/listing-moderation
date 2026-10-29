import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { createApi } from '../src/api';
import { DATABASE } from '../src/db/database.module';
import { Database } from '../src/db/database';
import { HealthService } from '../src/health/health.service';
import { createTestDatabase } from './helpers/postgres';

const env = { POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' };

test('T11 actual API health routes keep liveness up and return JSON 503 after database closes', async () => {
  const fixture = await createTestDatabase();
  let app: Awaited<ReturnType<typeof createApi>> | undefined;
  try {
    app = await createApi({ ...env, DATABASE_URL: fixture.url });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const request = (path: string) => fetch(url + path, { headers: { connection: 'close' } });
    const healthy = await request('/readyz');
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: 'ok' });
    await app.get<Database>(DATABASE).close();
    const unavailable = await request('/readyz');
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await unavailable.json(), { status: 'not_ready' });
    const alive = await request('/livez');
    assert.equal(alive.status, 200);
    assert.deepEqual(await alive.json(), { status: 'ok' });
  } finally {
    if (app) await app.close();
    await fixture.dispose();
  }
});

test('T11 readiness coalesces simultaneous probes and never revives draining state', async () => {
  let calls = 0;
  let finish: (() => void) | undefined;
  const db = { readinessProbe: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } } as Database;
  const service = new HealthService(db);
  const first = service.ready();
  const second = service.ready();
  assert.equal(calls, 1);
  service.drain();
  finish?.();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await service.ready(), false);
  assert.equal(calls, 1);
});

test('T11 readiness does not cache a settled probe failure or success', async () => {
  let calls = 0;
  const db = { readinessProbe: async () => {
    calls++;
    if (calls === 2) throw new Error('transient probe fault');
  } } as Database;
  const service = new HealthService(db);
  assert.equal(await service.ready(), true);
  assert.equal(await service.ready(), false);
  assert.equal(await service.ready(), true);
  assert.equal(calls, 3);
});

test('T11 actual API readiness times out on its saturated PostgreSQL pool, stays live, then recovers',
  { timeout: 15000 }, async () => {
    const fixture = await createTestDatabase();
    let app: Awaited<ReturnType<typeof createApi>> | undefined;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    let allEntered!: () => void;
    const allHoldersEntered = new Promise<void>(resolve => { allEntered = resolve; });
    let operations: Promise<void>[] = [];
    let settled: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      app = await createApi({ ...env, DATABASE_URL: fixture.url });
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}`;
      const request = (path: string, timeout = 12000) => fetch(url + path, {
        headers: { connection: 'close' }, signal: AbortSignal.timeout(timeout),
      });
      assert.equal((await request('/readyz')).status, 200);

      const database = app.get<Database>(DATABASE);
      operations = Array.from({ length: 10 }, () => database.transaction(async client => {
        await client.query('SELECT 1');
        entered++;
        if (entered === 10) allEntered();
        await held;
      }));
      settled = Promise.allSettled(operations);
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        allHoldersEntered,
        new Promise<never>((_, reject) => { holdTimer = setTimeout(() => reject(new Error('pool holders did not enter')), 10000); }),
      ]).finally(() => { if (holdTimer) clearTimeout(holdTimer); });
      assert.equal(entered, 10, 'the default pg pool capacity must be fully checked out');

      const server = app.getHttpServer();
      let removeRequestObserver = () => {};
      const requestSeen = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { removeRequestObserver(); reject(new Error('ready request did not reach HTTP server')); }, 2000);
        const listener = (incoming: IncomingMessage) => {
          if (incoming.url !== '/readyz') return;
          clearTimeout(timer);
          removeRequestObserver();
          resolve();
        };
        removeRequestObserver = () => server.off('request', listener);
        server.on('request', listener);
      });
      const readyPromise = request('/readyz');
      await requestSeen;
      const live = await request('/livez');
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: 'ok' });
      const unavailable = await readyPromise;
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { status: 'not_ready' });

      release();
      assert.equal((await settled).every(result => result.status === 'fulfilled'), true);
      const recovered = await request('/readyz');
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), { status: 'ok' });
      await database.query('SELECT 1');
    } finally {
      release();
      if (settled) await settled;
      if (app) await app.close();
      await fixture.dispose();
    }
  });

test('T11 actual Nest app.close invokes draining hook before HTTP adapter and database close',
  { timeout: 15000 }, async () => {
    const fixture = await createTestDatabase();
    let app: Awaited<ReturnType<typeof createApi>> | undefined;
    let release!: () => void;
    const closeGate = new Promise<void>(resolve => { release = resolve; });
    let reachedClose!: () => void;
    const atClose = new Promise<void>(resolve => { reachedClose = resolve; });
    let shutdown: Promise<void> | undefined;
    let originalClose: ((...args: unknown[]) => unknown) | undefined;
    let adapter: ReturnType<Awaited<ReturnType<typeof createApi>>['getHttpAdapter']> | undefined;
    try {
      app = await createApi({ ...env, DATABASE_URL: fixture.url });
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}`;
      const request = (path: string) => fetch(url + path, { headers: { connection: 'close' } });
      const health = app.get(HealthService);
      const database = app.get<Database>(DATABASE);
      assert.equal((await request('/readyz')).status, 200);

      adapter = app.getHttpAdapter();
      originalClose = adapter.close.bind(adapter) as (...args: unknown[]) => unknown;
      (adapter as unknown as { close: (...args: unknown[]) => unknown }).close = (...args: unknown[]) => {
        reachedClose();
        return closeGate.then(() => originalClose!.apply(adapter, args));
      };
      shutdown = app.close();
      let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        atClose,
        new Promise<never>((_, reject) => { boundaryTimer = setTimeout(() => reject(new Error('adapter close boundary not reached')), 3000); }),
      ]).finally(() => { if (boundaryTimer) clearTimeout(boundaryTimer); });

      assert.equal(await health.ready(), false);
      assert.equal((await request('/readyz')).status, 503);
      const live = await request('/livez');
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: 'ok' });
      await database.query('SELECT 1');

      release();
      await shutdown;
      await assert.rejects(database.readinessProbe(), /Database is closed/);
      await assert.rejects(fetch(url + '/livez', { signal: AbortSignal.timeout(500) }));
    } finally {
      release();
      if (adapter && originalClose) {
        (adapter as unknown as { close: (...args: unknown[]) => unknown }).close = originalClose;
      }
      if (shutdown) await shutdown;
      else if (app) await app.close();
      await fixture.dispose();
    }
  });
