import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocked, scope, until } from './helpers/t08';

test('compiled worker expires a published listing past its database deadline without client action', { timeout: 10000 }, async () => {
  await scope(async s => {
    const id = await s.add('T10 worker expiry runtime RED');
    const claim = await s.claim();
    assert.equal(claim.listingId, id);
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    await s.database.query(
      `UPDATE listings SET status='published',published_at=clock_timestamp()-interval '2 days',
       expires_at=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1`, [id]);

    const child = await s.child('10');
    const second = await s.child('10');
    const row = await until(async () => (await s.observer.query<{ status: string; version: string }>(
      'SELECT status,version::text AS version FROM listings WHERE id=$1', [id])).rows[0],
    value => value.status === 'expired', 3000);
    assert.deepEqual(row, { status: 'expired', version: '3' });
    assert.ok(child.process.exitCode === null);
    assert.ok(second.process.exitCode === null);
  });
});

test('compiled worker waits for an active expiry transaction on graceful shutdown', { timeout: 15000 }, async () => {
  await scope(async s => {
    const id = await s.add('T10 expiry restart');
    const claim = await s.claim();
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    await s.database.query(
      `UPDATE listings SET status='published',published_at=clock_timestamp()-interval '2 days',
       expires_at=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1`, [id]);
    const blocker = await s.control();
    await blocker.query('BEGIN');
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [81010, 1]);
    await s.database.query(`CREATE FUNCTION t10_block_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='expired' AND NEW.title='T10 expiry restart' THEN PERFORM pg_advisory_xact_lock(81010,1); END IF; RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t10_block_expiry BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION t10_block_expiry()');
    const first = await s.child('10');
    await blocked(s.observer, blockerPid, 'UPDATE listings AS l');
    const exit = new Promise<number | null>(resolve => first.process.once('exit', code => resolve(code)));
    first.process.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(first.process.exitCode, null, 'worker must wait for the expiry transaction');
    await blocker.query('ROLLBACK');
    assert.equal(await exit, 0);
    await s.database.query('DROP TRIGGER t10_block_expiry ON listings');
    await s.database.query('DROP FUNCTION t10_block_expiry()');
    const expired = await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [id])).rows[0], row => row.status === 'expired');
    assert.equal(expired.status, 'expired');
    const row = (await s.observer.query<{ version: string; history_count: number; attempts: number }>(
      `SELECT version::text AS version,(SELECT count(*)::int FROM moderation_history WHERE listing_id=$1) AS history_count,
       (SELECT attempts FROM moderation_jobs WHERE listing_id=$1) AS attempts FROM listings WHERE id=$1`, [id])).rows[0];
    assert.deepEqual(row, { version: '3', history_count: 1, attempts: 1 });
  });
});

test('compiled worker logs sanitized expiry failure and retries without changing moderation attempts', { timeout: 12000 }, async () => {
  await scope(async s => {
    const id = await s.add('T10 worker transient expiry failure');
    const claim = await s.claim();
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    await s.database.query(
      `UPDATE listings SET status='published',published_at=clock_timestamp()-interval '2 days',
       expires_at=clock_timestamp()-interval '1 second',version=version+1 WHERE id=$1`, [id]);
    await s.database.query(`CREATE FUNCTION t10_fail_worker_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='published' AND NEW.status='expired' AND OLD.id='${id}' THEN RAISE EXCEPTION 'private expiry password=secret'; END IF; RETURN NEW; END $$`);
    await s.database.query(`CREATE TRIGGER t10_fail_worker_expiry BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t10_fail_worker_expiry()`);

    const child = await s.child('10');
    const errors = await until(async () => child.errors(), text => text.includes('"event":"worker_expiry_failed"'));
    assert.match(errors, /"diagnostic":"database_error:P0001"/);
    assert.equal(errors.includes('private expiry password=secret'), false);
    const unchanged = await until(async () => (await s.observer.query<{ status: string; state: string; attempts: number;
      version: string; history_count: number }>(
      `SELECT l.status,j.state,j.attempts,l.version::text AS version,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0],
    row => row.status === 'published');
    assert.deepEqual(unchanged, { status: 'published', state: 'completed', attempts: 1, version: '2', history_count: 1 });

    await s.database.query('DROP TRIGGER t10_fail_worker_expiry ON listings');
    await s.database.query('DROP FUNCTION t10_fail_worker_expiry()');
    const retried = await until(async () => (await s.observer.query<{ status: string; state: string; attempts: number;
      version: string; history_count: number }>(
      `SELECT l.status,j.state,j.attempts,l.version::text AS version,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0],
    row => row.status === 'expired');
    assert.deepEqual(retried, { status: 'expired', state: 'completed', attempts: 1, version: '3', history_count: 1 });
  });
});
