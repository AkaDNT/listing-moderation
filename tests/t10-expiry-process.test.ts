import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicationRepository } from '../src/lifecycle/publication.repository';
import { blocked, scope, stop, until } from './helpers/t08';

async function prepareDue(s: Parameters<Parameters<typeof scope>[0]>[0], title: string): Promise<string> {
  const id = await s.add(title);
  const claim = await s.claim();
  assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
  assert.equal((await new PublicationRepository(s.database, 30).publishNext()).kind, 'published');
  await s.database.query("UPDATE listings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  return id;
}

test('SIGKILL during expiry update rolls back and restart expires persisted overdue listing', { timeout: 16000 }, async () => {
  await scope(async s => {
    const title = 'T10 kill before expiry commit';
    const id = await prepareDue(s, title);
    await s.database.query(`CREATE FUNCTION t10_kill_before_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='expired' AND NEW.title='${title}' THEN PERFORM pg_advisory_xact_lock(81012,1); END IF; RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t10_kill_before_expiry BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION t10_kill_before_expiry()');
    const blocker = await s.control();
    await blocker.query('BEGIN');
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [81012, 1]);
    const first = await s.child('10');
    await blocked(s.observer, pid, 'UPDATE listings AS l');
    const exited = new Promise<NodeJS.Signals | null>(resolve => first.process.once('exit', (_code, signal) => resolve(signal)));
    first.process.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');
    await blocker.query('ROLLBACK');
    await s.database.query('DROP TRIGGER t10_kill_before_expiry ON listings');
    await s.database.query('DROP FUNCTION t10_kill_before_expiry()');
    assert.deepEqual((await s.observer.query<{ status: string; version: string }>(
      'SELECT status,version::text AS version FROM listings WHERE id=$1', [id])).rows[0], { status: 'published', version: '2' });
    const restarted = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [id])).rows[0], row => row.status === 'expired');
    assert.ok(restarted.process.exitCode === null);
  });
});

test('SIGKILL after committed expiry and restart preserves the first lifecycle snapshot', { timeout: 18000 }, async () => {
  await scope(async s => {
    const firstId = await prepareDue(s, 'T10 kill after expiry commit');
    const firstWorker = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [firstId])).rows[0], row => row.status === 'expired');
    const sql = `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,
      l.published_at::text AS published_at,l.expires_at::text AS expires_at,l.normalized_fingerprint,
      l.version::text AS version,j.state,j.attempts,
      (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
       FROM moderation_history h WHERE h.listing_id=l.id) AS history
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`;
    const committed = await s.observer.query(sql, [firstId]);
    const exited = new Promise<NodeJS.Signals | null>(resolve => firstWorker.process.once('exit', (_code, signal) => resolve(signal)));
    firstWorker.process.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');

    const secondId = await prepareDue(s, 'T10 restart overdue backlog');
    const restarted = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [secondId])).rows[0], row => row.status === 'expired');
    assert.deepEqual((await s.observer.query(sql, [firstId])).rows, committed.rows);
    assert.ok(restarted.process.exitCode === null);
  });
});

test('two compiled workers skip a locked first expiry batch, progress on the next row, then catch up', { timeout: 18000 }, async () => {
  await scope(async s => {
    const ids = await s.database.query<{ id: string }>(
      `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,
         published_at,expires_at,normalized_fingerprint,version,created_at)
       SELECT 't10-skip-'||lpad(n::text,4,'0'),'s-1002','c-phones','T10 skip locked '||n,'fixture',6000000,
         'published','{"outcome":"approved","reasons":[]}'::jsonb,now()-interval '3 days',
         now()-interval '2 days',now()-(102-n)*interval '1 second','t10-skip-'||n,2,now()-interval '2 days'
       FROM generate_series(1,101) AS n RETURNING id`);
    const listingIds = ids.rows.map(row => row.id);
    await s.database.query(
      `INSERT INTO moderation_jobs(id,listing_id,state,attempts,completed_at)
       SELECT 'job-'||id,id,'completed',1,now()-interval '2 days' FROM listings WHERE id=ANY($1::text[])`, [listingIds]);
    await s.database.query(
      `INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
       SELECT id,'auto',decision,decided_at FROM listings WHERE id=ANY($1::text[])`, [listingIds]);

    await s.database.query(`CREATE FUNCTION t10_hold_first_expiry_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id='t10-skip-0001' AND NEW.status='expired' THEN PERFORM pg_advisory_xact_lock(81020,1); END IF; RETURN NEW; END $$`);
    await s.database.query(`CREATE TRIGGER t10_hold_first_expiry_row BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t10_hold_first_expiry_row()`);
    const blocker = await s.control();
    await blocker.query('BEGIN');
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [81020, 1]);

    const firstWorker = await s.child('10');
    await blocked(s.observer, blockerPid, 'UPDATE listings AS l');
    const secondWorker = await s.child('10');
    const overflow = await until(async () => (await s.observer.query<{ status: string; version: string }>(
      "SELECT status,version::text AS version FROM listings WHERE id='t10-skip-0101'")).rows[0],
    row => row.status === 'expired', 5000);
    assert.deepEqual(overflow, { status: 'expired', version: '3' });
    assert.deepEqual((await s.observer.query<{ status: string; version: string }>(
      "SELECT status,version::text AS version FROM listings WHERE id='t10-skip-0001'")).rows[0],
    { status: 'published', version: '2' });
    assert.equal(firstWorker.process.exitCode, null);
    assert.equal(secondWorker.process.exitCode, null);

    await blocker.query('ROLLBACK');
    await until(async () => (await s.observer.query<{ expired: number }>(
      "SELECT count(*)::int AS expired FROM listings WHERE id LIKE 't10-skip-%' AND status='expired'")).rows[0],
    row => row.expired === 101, 7000);
    const final = await s.observer.query<{ id: string; status: string; version: string; state: string; attempts: number; history_count: number }>(
      `SELECT l.id,l.status,l.version::text AS version,j.state,j.attempts,
        (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=ANY($1::text[]) ORDER BY l.id`, [listingIds]);
    assert.equal(final.rowCount, 101);
    assert.ok(final.rows.every(row => row.status === 'expired' && row.version === '3' &&
      row.state === 'completed' && row.attempts === 1 && row.history_count === 1));
  });
});

test('compiled worker uses missing TTL default and explicit override without changing stored deadlines', { timeout: 18000 }, async () => {
  await scope(async s => {
    const defaultId = await s.add('T10 worker missing TTL default', 's-1005');
    const defaultWorker = await s.child('10', null);
    const defaultPublished = await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [defaultId])).rows[0], row => row.status === 'published');
    assert.equal(defaultPublished.status, 'published');
    const defaultDeadline = (await s.observer.query<{ published_at: string; expires_at: string; ttl_seconds: string }>(
      `SELECT published_at::text AS published_at,expires_at::text AS expires_at,
        EXTRACT(EPOCH FROM (expires_at-published_at))::text AS ttl_seconds FROM listings WHERE id=$1`, [defaultId])).rows[0];
    assert.equal(Number(defaultDeadline.ttl_seconds), 30 * 86400);
    await stop(defaultWorker.process);

    const overrideId = await s.add('T10 worker TTL override', 's-1005');
    const overrideWorker = await s.child('10', '2');
    const overridePublished = await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [overrideId])).rows[0], row => row.status === 'published');
    assert.equal(overridePublished.status, 'published');
    const overrideDeadline = (await s.observer.query<{ published_at: string; expires_at: string; ttl_seconds: string }>(
      `SELECT published_at::text AS published_at,expires_at::text AS expires_at,
        EXTRACT(EPOCH FROM (expires_at-published_at))::text AS ttl_seconds FROM listings WHERE id=$1`, [overrideId])).rows[0];
    assert.equal(Number(overrideDeadline.ttl_seconds), 2 * 86400);
    await stop(overrideWorker.process);

    assert.deepEqual((await s.observer.query<{ published_at: string; expires_at: string }>(
      'SELECT published_at::text AS published_at,expires_at::text AS expires_at FROM listings WHERE id=$1', [defaultId])).rows[0],
    { published_at: defaultDeadline.published_at, expires_at: defaultDeadline.expires_at });
  });
});
