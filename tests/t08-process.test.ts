import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';
import { blocked } from './helpers/t08';

interface ListingFields { sellerId: string; categoryId: string; title: string; description: string; priceVnd: bigint }
interface SubmissionRepository { submit(fields: ListingFields): Promise<{ id: string; status: string }> }

function productionSubmission(database: Database): SubmissionRepository {
  const module = require('../src/submission/submission.repository') as { SubmissionRepository: new (database: Database) => SubmissionRepository };
  return new module.SubmissionRepository(database);
}

function startWorker(databaseUrl: string, pollInterval = '10'): ChildProcess {
  return spawn(process.execPath, [resolve('dist/src/worker.js')], {
    env: { ...process.env, DATABASE_URL: databaseUrl, POLL_INTERVAL_MS: pollInterval, LISTING_TTL_DAYS: '30' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

async function waitForMessage(child: ChildProcess, timeoutMs: number): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  await new Promise<void>((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('worker startup timed out; stderr=' + stderr)), timeoutMs);
    child.once('message', message => {
      clearTimeout(timer);
      if ((message as { event?: string }).event === 'worker-started') resolveMessage();
      else reject(new Error('unexpected worker startup IPC message'));
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('worker exited before startup: ' + code + '; stderr=' + stderr)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function stopWorker(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolveExit, reject) => {
    child.once('exit', () => resolveExit());
    child.once('error', reject);
  });
  child.kill(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exit,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('worker process failed to stop before deadline')), 9000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function pollRows(pool: Pool, ids: string[], expected: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await pool.query<{ completed: number }>(
      "SELECT count(*)::int AS completed FROM moderation_jobs WHERE listing_id=ANY($1::text[]) AND state='completed'", [ids]);
    if (result.rows[0].completed === expected) return;
    last = result.rows[0].completed;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error('timed out waiting for completed jobs; last count=' + String(last));
}

async function pollPublication(pool: Pool, ids: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = -1;
  while (Date.now() < deadline) {
    const result = await pool.query<{ remaining: number }>(
      "SELECT count(*)::int AS remaining FROM listings WHERE id=ANY($1::text[]) AND status='auto_approved'", [ids]);
    remaining = result.rows[0].remaining;
    if (remaining === 0) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for T09 publication; remaining auto_approved=${remaining}`);
}

test('two standalone worker processes drain shared PostgreSQL jobs once and preserve one auto history per listing', { timeout: 30000 }, async () => {
  const fixtureDb = await createTestDatabase();
  let database: Database | undefined;
  const observer = new Pool({ connectionString: fixtureDb.url });
  const children: ChildProcess[] = [];
  let primary: unknown;
  try {
    database = await Database.open(fixtureDb.url, await loadBootstrapAssets());
    const submission = productionSubmission(database);
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const result = await submission.submit({ sellerId: 's-1002', categoryId: 'c-phones',
        title: 'T08 multiworker ' + index, description: 'clean', priceVnd: 6000000n });
      ids.push(result.id);
    }
    const duplicatePairs: string[][] = [];
    for (let pair = 0; pair < 10; pair += 1) {
      const pairIds: string[] = [];
      for (let copy = 0; copy < 2; copy += 1) {
        const result = await submission.submit({ sellerId: 's-1002', categoryId: 'c-phones',
          title: `T08 worker R3 pair ${pair}`, description: 'same normalized identity', priceVnd: 6000000n });
        pairIds.push(result.id);
        ids.push(result.id);
      }
      duplicatePairs.push(pairIds);
    }
    for (let index = 0; index < 2; index += 1) children.push(startWorker(fixtureDb.url));
    await Promise.all(children.map(child => waitForMessage(child, 7000)));
    await pollRows(observer, ids, ids.length, 12000);
    await pollPublication(observer, ids, 12000);
    const persisted = await observer.query<{
      id: string; status: string; outcome: string; has_r3: boolean; job_state: string; attempts: number; version: string; history_count: number;
    }>(
      "SELECT l.id,l.status,l.decision->>'outcome' AS outcome," +
      "EXISTS (SELECT 1 FROM jsonb_array_elements(l.decision->'reasons') r WHERE r->>'rule_id'='R3') AS has_r3," +
      "j.state AS job_state,j.attempts,l.version::text AS version," +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      "FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=ANY($1::text[]) ORDER BY l.id", [ids]);
    assert.equal(persisted.rowCount, ids.length);
    for (const row of persisted.rows) {
      assert.ok(row.status === 'published' || row.status === 'auto_rejected'); assert.equal(row.job_state, 'completed');
      assert.equal(row.attempts, 1); assert.equal(row.version, row.status === 'published' ? '2' : '1'); assert.equal(row.history_count, 1);
    }
    const byId = new Map(persisted.rows.map(row => [row.id, row]));
    for (const [firstId, secondId] of duplicatePairs) {
      const pair = [byId.get(firstId)!, byId.get(secondId)!];
      assert.equal(pair.filter(row => row.status === 'published' && row.outcome === 'approved' && !row.has_r3).length, 1);
      assert.equal(pair.filter(row => row.status === 'auto_rejected' && row.outcome === 'rejected' && row.has_r3).length, 1);
    }
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const child of children) try { await stopWorker(child); } catch (error) { child.kill('SIGKILL'); cleanup.push(error); }
  try { await observer.end(); } catch (error) { cleanup.push(error); }
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await fixtureDb.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, 'T08 multiworker process test/cleanup failure:\n' +
      errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
  }
});

test('process death inside the listing transaction leaves no partial result and an expired lease is reclaimed after restart', { timeout: 40000 }, async () => {
  const fixtureDb = await createTestDatabase();
  let database: Database | undefined;
  const observer = new Pool({ connectionString: fixtureDb.url, max: 2 });
  let controlClient: PoolClient | undefined;
  let first: ChildProcess | undefined;
  let restarted: ChildProcess | undefined;
  let controlPid: number | undefined;
  let primary: unknown;
  try {
    database = await Database.open(fixtureDb.url, await loadBootstrapAssets());
    const created = await productionSubmission(database).submit({ sellerId: 's-1002', categoryId: 'c-phones',
      title: 'T08 crash before commit', description: 'clean', priceVnd: 6000000n });
    controlClient = await observer.connect();
    const backend = await controlClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    controlPid = backend.rows[0].pid;
    await controlClient.query('SELECT pg_advisory_lock($1,$2)', [82754, 1]);
    await observer.query(
      "CREATE FUNCTION block_t08_listing_update() RETURNS trigger LANGUAGE plpgsql AS $$ " +
      "BEGIN IF NEW.id='" + created.id + "' AND NEW.status<>'pending' THEN PERFORM pg_advisory_xact_lock(82754,1); END IF; RETURN NEW; END $$");
    await observer.query('CREATE TRIGGER t08_block_listing BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION block_t08_listing_update()');
    first = startWorker(fixtureDb.url);
    await waitForMessage(first, 7000);
    const deadline = Date.now() + 8000;
    let observedBlock = false;
    let lastBlockers: unknown;
    while (Date.now() < deadline) {
      const state = await observer.query<{ job_state: string; token: string | null }>(
        'SELECT state AS job_state,claim_token AS token FROM moderation_jobs WHERE listing_id=$1', [created.id]);
      const blockers = await observer.query<{ pid: number; blockers: number[]; query: string; wait_event: string | null }>(
        "SELECT pid,pg_blocking_pids(pid) AS blockers,query,wait_event FROM pg_stat_activity " +
        "WHERE datname=current_database() AND wait_event_type='Lock' AND position('UPDATE listings' in query)>0");
      lastBlockers = blockers.rows;
      const blockedByControl = blockers.rows.some(row => row.blockers.includes(controlPid!));
      if (state.rows[0].job_state === 'running' && state.rows[0].token && blockedByControl) {
        observedBlock = true;
        break;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.equal(observedBlock, true, 'worker must persist claim and block at the synchronized listing UPDATE; last blockers=' + JSON.stringify(lastBlockers));
    await stopWorker(first, 'SIGKILL');
    first = undefined;
    await controlClient.query('SELECT pg_advisory_unlock($1,$2)', [82754, 1]);
    await observer.query('DROP TRIGGER t08_block_listing ON listings');
    await observer.query('DROP FUNCTION block_t08_listing_update()');
    const rolledBack = await observer.query<{ status: string; decision: unknown; version: string; state: string; attempts: number; token: string | null; history_count: number }>(
      "SELECT l.status,l.decision,l.version::text AS version,j.state,j.attempts,j.claim_token AS token," +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count " +
      "FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1", [created.id]);
    assert.deepEqual({ ...rolledBack.rows[0], token: undefined }, {
      status: 'pending', decision: null, version: '0', state: 'running', attempts: 1,
      token: undefined, history_count: 0,
    });
    assert.match(rolledBack.rows[0].token ?? '', /^[0-9a-f-]{36}$/i);
    await observer.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE listing_id=$1", [created.id]);
    restarted = startWorker(fixtureDb.url);
    await waitForMessage(restarted, 7000);
    await pollRows(observer, [created.id], 1, 9000);
    await pollPublication(observer, [created.id], 9000);
    const recovered = await observer.query<{ attempts: number; status: string; version: string; history_count: number }>(
      "SELECT j.attempts,l.status,l.version::text AS version," +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      "FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1", [created.id]);
    assert.deepEqual(recovered.rows[0], { attempts: 2, status: 'published', version: '2', history_count: 1 });
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const child of [first, restarted]) if (child) try { await stopWorker(child); } catch (error) { child.kill('SIGKILL'); cleanup.push(error); }
  if (controlClient) {
    if (controlPid !== undefined) try { await controlClient.query('SELECT pg_advisory_unlock($1,$2)', [82754, 1]); } catch (error) { cleanup.push(error); }
    try { controlClient.release(); } catch (error) { cleanup.push(error); }
  }
  try { await observer.query('DROP TRIGGER IF EXISTS t08_block_listing ON listings'); await observer.query('DROP FUNCTION IF EXISTS block_t08_listing_update()'); } catch (error) { cleanup.push(error); }
  try { await observer.end(); } catch (error) { cleanup.push(error); }
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await fixtureDb.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, 'T08 crash recovery test/cleanup failure:\n' +
      errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
  }
});

test('process death after the committed phase and restart do not append a second auto event', { timeout: 30000 }, async () => {
  const fixtureDb = await createTestDatabase();
  let database: Database | undefined;
  const observer = new Pool({ connectionString: fixtureDb.url });
  let first: ChildProcess | undefined;
  let restarted: ChildProcess | undefined;
  let control: PoolClient | undefined;
  let controlPid: number | undefined;
  let primary: unknown;
  try {
    database = await Database.open(fixtureDb.url, await loadBootstrapAssets());
    const created = await productionSubmission(database).submit({ sellerId: 's-1002', categoryId: 'c-phones',
      title: 'T08 crash after committed phase', description: 'clean', priceVnd: 6000000n });
    control = await observer.connect();
    controlPid = (await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await control.query('SELECT pg_advisory_lock(82755,2)');
    await observer.query(`CREATE FUNCTION t09_block_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.status='auto_approved' AND NEW.status='published' THEN PERFORM pg_advisory_xact_lock(82755,2); END IF;
      RETURN NEW; END $$`);
    await observer.query('CREATE TRIGGER t09_block_publication BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION t09_block_publication()');
    first = startWorker(fixtureDb.url);
    await waitForMessage(first, 7000);
    await blocked(observer, controlPid, 'UPDATE listings AS l');
    const committed = await observer.query<{ status: string; version: string; state: string; attempts: number; history_count: number;
      decision: string; decided_at: Date; published_at: Date | null }>(
      "SELECT l.status,l.version::text AS version,j.state,j.attempts,l.decision::text AS decision,l.decided_at,l.published_at," +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [created.id]);
    assert.equal(committed.rows[0].status, 'auto_approved');
    assert.equal(committed.rows[0].version, '1');
    assert.equal(committed.rows[0].state, 'completed');
    assert.equal(committed.rows[0].attempts, 1);
    assert.equal(committed.rows[0].history_count, 1);
    assert.ok(committed.rows[0].decided_at instanceof Date);
    assert.equal(committed.rows[0].published_at, null);
    await stopWorker(first, 'SIGKILL');
    first = undefined;
    await control.query('SELECT pg_advisory_unlock(82755,2)');
    await observer.query('DROP TRIGGER t09_block_publication ON listings');
    await observer.query('DROP FUNCTION t09_block_publication()');
    restarted = startWorker(fixtureDb.url);
    await waitForMessage(restarted, 7000);
    await pollPublication(observer, [created.id], 9000);
    const afterRestart = await observer.query<{ status: string; version: string; state: string; attempts: number; history_count: number;
      decision: string; decided_at: Date; published_at: Date }>(
      "SELECT l.status,l.version::text AS version,j.state,j.attempts,l.decision::text AS decision,l.decided_at,l.published_at," +
      "(SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS history_count " +
      'FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1', [created.id]);
    const row = afterRestart.rows[0];
    assert.equal(row.status, 'published'); assert.equal(row.version, '2'); assert.equal(row.state, 'completed');
    assert.equal(row.attempts, 1); assert.equal(row.history_count, 1);
    assert.equal(row.decision, committed.rows[0].decision);
    assert.equal(row.decided_at.toISOString(), committed.rows[0].decided_at.toISOString());
    assert.ok(row.published_at instanceof Date);
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const child of [first, restarted]) if (child) try { await stopWorker(child); } catch (error) { child.kill('SIGKILL'); cleanup.push(error); }
  if (control) {
    try { await control.query('SELECT pg_advisory_unlock_all()'); } catch (error) { cleanup.push(error); }
    try { control.release(); } catch (error) { cleanup.push(error); }
  }
  try { await observer.query('DROP TRIGGER IF EXISTS t09_block_publication ON listings'); await observer.query('DROP FUNCTION IF EXISTS t09_block_publication()'); } catch (error) { cleanup.push(error); }
  try { await observer.end(); } catch (error) { cleanup.push(error); }
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await fixtureDb.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, 'T08 post-commit crash/restart test/cleanup failure:\n' +
      errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n'), { cause: primary });
  }
});
