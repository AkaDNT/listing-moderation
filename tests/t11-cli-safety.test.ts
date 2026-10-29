import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';
import { scope, stop } from './helpers/t08';

test('T11 compiled API and worker startup failures never print a PostgreSQL secret message', { timeout: 20000 }, async () => {
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const observer = new Pool({ connectionString: fixture.url });
  try {
    await database.close();
    await observer.query(`CREATE FUNCTION t11_fail_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='t11-private-password-sentinel'; END $$`);
    await observer.query('CREATE TRIGGER t11_fail_seed BEFORE UPDATE ON sellers FOR EACH ROW EXECUTE FUNCTION t11_fail_seed()');
    for (const executable of ['api', 'worker']) {
      const child = spawn(process.execPath, [resolve(`dist/src/${executable}.js`)], {
        env: { ...process.env, DATABASE_URL: fixture.url, POLL_INTERVAL_MS: '100', LISTING_TTL_DAYS: '30', PORT: '8080' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', data => { output += String(data); });
      child.stderr!.on('data', data => { output += String(data); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('T11 CLI exit timeout')); }, 7000);
        child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.doesNotMatch(output, /t11-private-password-sentinel/);
      assert.match(output, /database_error:P0001/);
    }
  } finally {
    await observer.end();
    await fixture.dispose();
  }
});

test('T11 compiled worker shutdown catch sanitizes app.close rejection after closing real PostgreSQL pool',
  { timeout: 20000 }, async () => {
    await scope(async s => {
      const baseline = (await s.observer.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname=current_database() AND application_name='listing-moderation'`)).rows[0].count;
      const child = spawn(process.execPath, ['--require', resolve('tests/fixtures/t11-shutdown-failure.cjs'), resolve('dist/src/worker.js')], {
        env: { ...process.env, DATABASE_URL: s.url, POLL_INTERVAL_MS: '60000', LISTING_TTL_DAYS: '30' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      s.defer(() => stop(child));
      let output = '';
      child.stdout!.on('data', data => { output = (output + String(data)).slice(-32000); });
      child.stderr!.on('data', data => { output = (output + String(data)).slice(-32000); });
      await new Promise<void>((resolveStarted, reject) => {
        const timer = setTimeout(() => { finish(); reject(new Error('T11 shutdown child did not start')); }, 7000);
        const finish = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', error); };
        const message = (value: unknown) => {
          if ((value as { event?: string }).event === 'worker-started') { finish(); resolveStarted(); }
        };
        const exit = () => { finish(); reject(new Error('T11 shutdown child exited before startup: ' + output)); };
        const error = (value: Error) => { finish(); reject(value); };
        child.on('message', message); child.once('exit', exit); child.once('error', error);
      });
      child.disconnect();
      await stop(child);
      assert.equal(child.exitCode, 1);
      assert.equal(child.signalCode, null);
      const shutdownLine = output.split('\n').find(line => line.includes('worker_shutdown_failed'));
      assert.ok(shutdownLine);
      const event = JSON.parse(shutdownLine) as Record<string, unknown>;
      assert.equal(event.diagnostic, 'unexpected_error:Error');
      assert.doesNotMatch(output, /t11-shutdown-private-sentinel/);
      const after = (await s.observer.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname=current_database() AND application_name='listing-moderation'`)).rows[0].count;
      assert.equal(after, baseline);
    });
  });
