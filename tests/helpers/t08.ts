import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { Database } from '../../src/db/database';
import { loadBootstrapAssets } from '../../src/db/assets';
import { SubmissionRepository } from '../../src/submission/submission.repository';
import { ModerationJobRepository, ModerationJobClaim } from '../../src/worker/moderation-job.repository';
import { createTestDatabase } from './postgres';

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  do {
    last = await read();
    if (ready(last)) return last;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  } while (Date.now() < deadline);
  throw new Error('T08 predicate timed out; last=' + JSON.stringify(last));
}

export async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    let forced: Error | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      forced = new Error('T08 child exit deadline exceeded; SIGKILL required');
      child.kill('SIGKILL');
      reapTimer = setTimeout(() => reject(new Error('T08 SIGKILL child reaping deadline exceeded', { cause: forced })), 3000);
    }, 12000);
    const clear = () => { clearTimeout(timer); if (reapTimer) clearTimeout(reapTimer); };
    child.once('exit', () => { clear(); if (forced) reject(forced); else resolveExit(); });
    child.once('error', error => { clear(); reject(error); });
    child.kill(signal);
  });
}

export async function scope(run: (s: {
  database: Database; observer: Pool; url: string; jobs: ModerationJobRepository;
  add(title: string, seller?: string, price?: bigint): Promise<string>;
  claim(): Promise<ModerationJobClaim>;
  snapshot(id: string): Promise<unknown>;
  control(): Promise<PoolClient>;
  child(interval?: string): Promise<{ process: ChildProcess; errors: () => string }>;
  defer(cleanup: () => Promise<unknown>): void;
}) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  const cleanups: (() => Promise<unknown>)[] = [() => fixture.dispose()];
  let primary: unknown;
  try {
    const database = await Database.open(fixture.url, await loadBootstrapAssets());
    cleanups.push(() => database.close());
    const observer = new Pool({ connectionString: fixture.url, statement_timeout: 3000, connectionTimeoutMillis: 3000 });
    cleanups.push(() => observer.end());
    const jobs = new ModerationJobRepository(database);
    const submissions = new SubmissionRepository(database);
    await run({
      database, observer, url: fixture.url, jobs,
      async add(title, seller = 's-1002', price = 6000000n) {
        return (await submissions.submit({ sellerId: seller, categoryId: 'c-phones', title,
          description: 'clean description', priceVnd: price })).id;
      },
      async claim() {
        const result = await jobs.claimNext();
        assert.equal(result.kind, 'claimed');
        if (result.kind !== 'claimed') throw new Error('Expected claim');
        return result.claim;
      },
      async snapshot(id) {
        return (await observer.query(
          `SELECT row_to_json(l)::text AS listing,row_to_json(j)::text AS job,
           (SELECT COALESCE(json_agg(h ORDER BY h.id),'[]'::json)::text FROM moderation_history h WHERE h.listing_id=l.id) AS history
           FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
      },
      async control() {
        const client = await observer.connect();
        cleanups.push(async () => { try { await client.query('ROLLBACK'); await client.query('SELECT pg_advisory_unlock_all()'); } finally { client.release(); } });
        return client;
      },
      async child(interval = '10') {
        const child = spawn(process.execPath, [resolve('dist/src/worker.js')], {
          env: { ...process.env, DATABASE_URL: fixture.url, POLL_INTERVAL_MS: interval, LISTING_TTL_DAYS: '30' },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-32000); });
        cleanups.push(() => stop(child));
        await new Promise<void>((resolveStarted, reject) => {
          const timer = setTimeout(() => { finish(); reject(new Error('T08 child startup deadline: ' + stderr)); }, 7000);
          const finish = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', error); };
          const message = (value: unknown) => { if ((value as { event?: string }).event === 'worker-started') { finish(); resolveStarted(); } };
          const exit = () => { finish(); reject(new Error('T08 child exited during startup: ' + stderr)); };
          const error = (value: Error) => { finish(); reject(value); };
          child.on('message', message); child.once('exit', exit); child.once('error', error);
        });
        return { process: child, errors: () => stderr };
      },
      defer(cleanup) { cleanups.push(cleanup); },
    });
  } catch (error) { primary = error; }
  const errors: unknown[] = primary === undefined ? [] : [primary];
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors,
    errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
}

export async function blocked(observer: Pool, blocker: number, fragment: string): Promise<number> {
  const rows = await until(async () => (await observer.query<{ pid: number; blockers: number[] }>(
    `SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
     WHERE datname=current_database() AND wait_event_type='Lock' AND position($1 in query)>0`, [fragment])).rows,
    values => values.some(row => row.blockers.includes(blocker)));
  return rows.find(row => row.blockers.includes(blocker))!.pid;
}

export async function pending(observer: Pool, id: string): Promise<void> {
  const row = (await observer.query(
    `SELECT l.status,l.decision,l.decided_at,l.normalized_fingerprint,l.version::text AS version,j.state,
     (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
     FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
  assert.deepEqual(row, { status: 'pending', decision: null, decided_at: null, normalized_fingerprint: null,
    version: '0', state: 'running', history_count: 0 });
}
