import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config';

const valid = {
  DATABASE_URL: 'postgres://moderator:secret@db:5432/listings',
  POLL_INTERVAL_MS: '1000',
  LISTING_TTL_DAYS: '30',
};

test('configuration defaults the host API port to 8080', () => {
  assert.equal(loadConfig(valid).port, 8080);
});

test('configuration accepts port bounds and rejects malformed values', () => {
  for (const port of ['1', '65535']) assert.equal(loadConfig({ ...valid, PORT: port }).port, Number(port));
  for (const port of ['', '0', '65536', '1.5', ' 80', '0x50', '1e2']) {
    assert.throws(() => loadConfig({ ...valid, PORT: port }), /PORT/);
  }
});

test('configuration requires a valid PostgreSQL URL with host and database', () => {
  assert.equal(loadConfig(valid).databaseUrl, valid.DATABASE_URL);
  for (const databaseUrl of ['', 'http://db/listings', 'postgres://', 'postgres://db/']) {
    assert.throws(() => loadConfig({ ...valid, DATABASE_URL: databaseUrl }), /DATABASE_URL/);
  }
});

test('configuration rejects non-positive or non-decimal worker intervals and TTLs', () => {
  for (const key of ['POLL_INTERVAL_MS', 'LISTING_TTL_DAYS'] as const) {
    for (const value of ['', '0', '-1', '1.2', '1e2', '999999999999999999999']) {
      assert.throws(() => loadConfig({ ...valid, [key]: value }), new RegExp(key));
    }
  }
  assert.throws(() => loadConfig({ ...valid, LISTING_TTL_DAYS: undefined }), /LISTING_TTL_DAYS/);
});

test('runtime config factory validates configuration through production module wiring', async () => {
  const { RuntimeModule, RUNTIME_CONFIG } = await import('../src/runtime.module');
  const { NestFactory } = await import('@nestjs/core');
  const app = await NestFactory.createApplicationContext(RuntimeModule.register(valid), { logger: false });
  try {
    assert.equal(app.get(RUNTIME_CONFIG).databaseUrl, valid.DATABASE_URL);
  } finally {
    await app.close();
  }
  await assert.rejects(
    NestFactory.createApplicationContext(RuntimeModule.register({ ...valid, PORT: '0' }), { logger: false, abortOnError: false }),
    /PORT/,
  );
});

test('actual API HTTP entrypoint exposes the exact live contract and validates startup config', { skip: process.platform === 'win32' && 'Nest HTTP adapter lifecycle is exercised on Linux/WSL' }, async () => {
  const { createApi } = await import('../src/api');
  const app = await createApi(valid);
  const server = app.getHttpServer();
  await app.listen(0, '127.0.0.1');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/livez`, { headers: { connection: 'close' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await response.json(), { status: 'ok' });
    const readiness = await fetch(`http://127.0.0.1:${address.port}/readyz`, { headers: { connection: 'close' } });
    assert.equal(readiness.status, 404);
    await readiness.arrayBuffer();
  } finally {
    await app.close();
  }
  await assert.rejects(createApi({ ...valid, PORT: '0' }), /PORT/);
});

test('standalone worker entrypoint constructs with real config and exits on SIGTERM', { skip: process.platform === 'win32' && 'POSIX signal semantics are tested in WSL/Linux' }, async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const worker = spawn(process.execPath, [resolve('dist/src/worker.js')], {
    env: { ...process.env, ...valid, PORT: '8080' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker startup timeout')), 30000);
      worker.once('message', () => { clearTimeout(timeout); resolveReady(); });
      worker.once('error', reject);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
      worker.once('exit', (code, signal) => resolveExit({ code, signal })));
    worker.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.code, 0);
  } finally {
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
});
