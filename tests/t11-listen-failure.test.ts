import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/postgres';

test('T11 compiled API EADDRINUSE exits nonzero, closes DB sessions and later starts on that port', { timeout: 25000 }, async () => {
  const fixture = await createTestDatabase();
  const holder = createServer();
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await new Promise<void>((done, reject) => holder.once('error', reject).listen(0, '127.0.0.1', done));
    const address = holder.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    const env = { ...process.env, DATABASE_URL: fixture.url, PORT: String(port), POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' };
    const failed = spawn(process.execPath, [resolve('dist/src/api.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    failed.stdout!.on('data', data => { output += String(data); });
    failed.stderr!.on('data', data => { output += String(data); });
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { failed.kill('SIGKILL'); reject(new Error('T11 listen failure deadline')); }, 10000);
      failed.once('exit', value => { clearTimeout(timer); done(value); });
      failed.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(code, 1);
    assert.match(output, /api_startup_failed/);
    assert.doesNotMatch(output, /postgres:\/\//);
    const sessions = (await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [fixture.databaseName])).rows[0].n;
    assert.equal(sessions, 0);
    await new Promise<void>(done => holder.close(() => done()));
    const restarted = spawn(process.execPath, [resolve('dist/src/api.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const deadline = Date.now() + 10000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) });
          ready = response.status === 200 && (await response.json() as { status: string }).status === 'ok';
        } catch { await new Promise(delay => setTimeout(delay, 50)); }
      }
      assert.equal(ready, true);
    } finally {
      if (restarted.exitCode === null && restarted.signalCode === null) {
        const exit = new Promise<void>(done => restarted.once('exit', () => done()));
        restarted.kill('SIGTERM');
        await exit;
      }
    }
  } finally {
    if (holder.listening) await new Promise<void>(done => holder.close(() => done()));
    await admin.end();
    await fixture.dispose();
  }
});
