import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocked, scope, until } from './helpers/t08';

test('compiled worker publishes a committed backlog row even when no moderation job is queued', { timeout: 16000 }, async () => {
  await scope(async s => {
    const id = await s.add('T09 worker backlog without queued job');
    const claim = await s.claim();
    assert.equal(claim.listingId, id);
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    const before = await s.observer.query<{ status: string; state: string; attempts: number; history_count: number; version: string; decided_at: Date; decision: string }>(
      `SELECT l.status,j.state,j.attempts,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count,l.version::text AS version,
        l.decided_at,l.decision::text AS decision
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
    assert.deepEqual({ status: before.rows[0].status, state: before.rows[0].state, attempts: before.rows[0].attempts,
      history_count: before.rows[0].history_count, version: before.rows[0].version },
    { status: 'auto_approved', state: 'completed', attempts: 1, history_count: 1, version: '1' });
    const queued = await s.observer.query("SELECT count(*)::int AS count FROM moderation_jobs WHERE state='queued'");
    assert.equal(queued.rows[0].count, 0);

    const child = await s.child('10');
    const published = await until(async () => (await s.observer.query<{ status: string; state: string; attempts: number;
      history_count: number; version: string; decided_at: Date; published_at: Date; expires_at: Date; outcome: string }>(
      `SELECT l.status,j.state,j.attempts,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count,l.version::text AS version,
        l.decided_at,l.published_at,l.expires_at,l.decision->>'outcome' AS outcome
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0], row => row.status === 'published');
    assert.deepEqual({ status: published.status, state: published.state, attempts: published.attempts,
      history_count: published.history_count, version: published.version, outcome: published.outcome },
    { status: 'published', state: 'completed', attempts: 1, history_count: 1, version: '2', outcome: 'approved' });
    assert.equal(published.decided_at.toISOString(), before.rows[0].decided_at.toISOString());
    assert.equal((await s.observer.query<{ decision: string }>('SELECT decision::text AS decision FROM listings WHERE id=$1', [id])).rows[0].decision,
      before.rows[0].decision);
    assert.equal(published.expires_at.getTime() - published.published_at.getTime(), 30 * 86400000);
    assert.ok(child.process.exitCode === null);
  });
});

test('SIGKILL after committed publication and restart leaves its lifecycle fields unchanged', { timeout: 18000 }, async () => {
  await scope(async s => {
    const publishedId = await s.add('T09 restart after committed publication');
    const firstWorker = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [publishedId])).rows[0], row => row.status === 'published');
    const committed = await s.observer.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [publishedId]);
    assert.equal(committed.rows[0].status, 'published');
    assert.equal(committed.rows[0].version, '2');
    assert.equal(committed.rows[0].state, 'completed');
    assert.equal(committed.rows[0].attempts, 1);
    assert.deepEqual((committed.rows[0].history as Array<{ phase: string }>).map(row => row.phase), ['auto']);

    const firstExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit =>
      firstWorker.process.once('exit', (code, signal) => resolveExit({ code, signal })));
    firstWorker.process.kill('SIGKILL');
    const killed = await firstExit;
    assert.equal(killed.signal, 'SIGKILL');

    const backlogId = await s.add('T09 restart scan proves worker is active');
    const claim = await s.claim();
    assert.equal(claim.listingId, backlogId);
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    const restarted = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [backlogId])).rows[0], row => row.status === 'published');
    const after = await s.observer.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [publishedId]);
    assert.deepEqual(after.rows, committed.rows);
    assert.ok(restarted.process.exitCode === null);
  });
});

test('compiled worker logs a sanitized publication failure and retries the committed backlog after repair', { timeout: 18000 }, async () => {
  await scope(async s => {
    const id = await s.add('T09 worker transient publication failure');
    await s.database.query(`CREATE FUNCTION t09_worker_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='auto_approved' AND NEW.status='published' THEN RAISE EXCEPTION 'private publication secret'; END IF; RETURN NEW; END $$`);
    await s.database.query(`CREATE TRIGGER t09_worker_fail_publish BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t09_worker_fail_publish()`);
    const child = await s.child('10');
    const errors = await until(async () => child.errors(), text => text.includes('"event":"worker_publication_failed"'));
    assert.match(errors, /"diagnostic":"database_error:P0001"/);
    assert.equal(errors.includes('private publication secret'), false);
    const committed = await until(async () => (await s.observer.query<{ status: string; job_state: string; attempts: number;
      version: string; history_count: number }>(
      `SELECT l.status,j.state AS job_state,j.attempts,l.version::text AS version,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0],
    row => row.status === 'auto_approved');
    assert.deepEqual(committed, { status: 'auto_approved', job_state: 'completed', attempts: 1, version: '1', history_count: 1 });
    await s.database.query('DROP TRIGGER t09_worker_fail_publish ON listings');
    await s.database.query('DROP FUNCTION t09_worker_fail_publish()');
    const published = await until(async () => (await s.observer.query<{ status: string; job_state: string; attempts: number;
      version: string; history_count: number }>(
      `SELECT l.status,j.state AS job_state,j.attempts,l.version::text AS version,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0],
    row => row.status === 'published');
    assert.deepEqual(published, { status: 'published', job_state: 'completed', attempts: 1, version: '2', history_count: 1 });
  });
});

test('SIGTERM waits for an active publication transaction and then exits without duplicate phase work', { timeout: 18000 }, async () => {
  await scope(async s => {
    const id = await s.add('T09 worker active publication shutdown');
    const claim = await s.claim();
    assert.equal(claim.listingId, id);
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    const control = await s.control();
    const blocker = (await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await control.query('SELECT pg_advisory_lock(82756,2)');
    await s.observer.query(`CREATE FUNCTION t09_block_publish_for_shutdown() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='auto_approved' AND NEW.status='published' THEN PERFORM pg_advisory_xact_lock(82756,2); END IF; RETURN NEW; END $$`);
    await s.observer.query(`CREATE TRIGGER t09_block_publish_for_shutdown BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t09_block_publish_for_shutdown()`);
    const child = await s.child('10');
    await blocked(s.observer, blocker, 'UPDATE listings AS l');
    const process = child.process;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit =>
      process.once('exit', (code, signal) => resolveExit({ code, signal })));
    process.kill('SIGTERM');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    assert.equal(process.exitCode, null, 'worker must await the in-flight publication before closing');
    await control.query('SELECT pg_advisory_unlock(82756,2)');
    const outcome = await Promise.race([exited, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('worker did not exit after active publication completed')), 7000))]);
    assert.equal(outcome.code, 0);
    const final = (await s.observer.query<{ status: string; state: string; attempts: number; version: string; history_count: number }>(
      `SELECT l.status,j.state,j.attempts,l.version::text AS version,
        (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
    assert.deepEqual(final, { status: 'published', state: 'completed', attempts: 1, version: '2', history_count: 1 });
  });
});
