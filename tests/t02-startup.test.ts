import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { checksumMigration, loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

const validConfig = {
  DATABASE_URL: 'postgres://moderator:test-only@127.0.0.1:1/unreachable',
  POLL_INTERVAL_MS: '1000',
  LISTING_TTL_DAYS: '30',
};

test('API factory rejects an unreachable database before returning an app that could listen', async () => {
  const { createApi } = await import('../src/api');
  await assert.rejects(createApi(validConfig), /ECONNREFUSED|connect|timeout/i);
});

test('database startup bounds an unresponsive PostgreSQL handshake and closes its socket', { timeout: 12000 }, async () => {
  const { createServer } = await import('node:net');
  const { Database } = await import('../src/db/database');
  const sockets = new Set<import('node:net').Socket>();
  let startupBytes = 0;
  let accepted = 0;
  // Network fault injection only: accepts a real TCP connection, deliberately
  // never sends PostgreSQL authentication/ReadyForQuery. No DB behavior is mocked.
  const server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('data', (bytes) => { startupBytes += bytes.length; });
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const started = performance.now();
  const opening = Database.open(`postgres://moderator:test-only@127.0.0.1:${address.port}/silent`, await loadBootstrapAssets())
    .then(async (database) => { await database.close(); return { kind: 'success' as const }; },
      (error: unknown) => ({ kind: 'error' as const, error }));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      opening,
      new Promise<{ kind: 'watchdog' }>((resolve) => {
        watchdog = setTimeout(() => resolve({ kind: 'watchdog' }), 7500);
      }),
    ]);
    assert.equal(outcome.kind, 'error', 'startup must reject before the 7.5s test watchdog');
    if (outcome.kind === 'error') assert.match(String(outcome.error), /timeout/i);
    assert.ok(performance.now() - started < 7500);
    assert.equal(accepted, 1);
    assert.ok(startupBytes > 0, 'production pg must actually attempt a handshake');
    // Let the peer observe FIN/reset after Database.open has completed cleanup.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sockets.size, 0, 'failed startup must not leave an open connection');
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    await opening;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('API factory rejects a bad migration before app creation and leaves no partial schema', async () => {
  const { createApi } = await import('../src/api');
  const fixture = await createTestDatabase();
  const assets = await loadBootstrapAssets();
  const sql = `${assets.migrations[0].sql}\nINVALID SQL;`;
  const brokenAssets = {
    ...assets,
    migrations: [{ ...assets.migrations[0], sql, checksum: checksumMigration(sql) }],
  };
  const observer = new Pool({ connectionString: fixture.url });
  try {
    await assert.rejects(createApi({ ...validConfig, DATABASE_URL: fixture.url }, brokenAssets), /syntax error/i);
    const result = await observer.query<{ table_count: number }>(
      "SELECT count(*)::int AS table_count FROM information_schema.tables WHERE table_schema='public'",
    );
    assert.equal(result.rows[0].table_count, 0);
  } finally {
    await observer.end();
    await fixture.dispose();
  }
});

test('worker does not announce startup when database bootstrap fails', { skip: process.platform === 'win32' && 'POSIX worker signals are exercised on Linux/WSL' }, async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const worker = spawn(process.execPath, [resolve('dist/src/worker.js')], {
    env: { ...process.env, ...validConfig, PORT: '8080' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const outcome = await Promise.race([
      new Promise<{ kind: 'message' }>((resolveMessage, reject) => {
        worker.once('message', () => resolveMessage({ kind: 'message' }));
        worker.once('error', reject);
      }),
      new Promise<{ kind: 'exit'; code: number | null }>((resolveExit) => {
        worker.once('exit', (code) => resolveExit({ kind: 'exit', code }));
      }),
    ]);
    assert.equal(outcome.kind, 'exit', 'worker must exit without sending worker-started');
    if (outcome.kind === 'exit') assert.notEqual(outcome.code, 0);
  } finally {
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
});
