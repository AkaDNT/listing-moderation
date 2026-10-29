import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { ModerationJobRepository } from '../src/worker/moderation-job.repository';
import { scope, blocked, pending, until } from './helpers/t08';

test('T08 takeover fences old finish and failure writers before and after completed phase', async () => {
  await scope(async s => {
    const id = await s.add('T08 takeover fencing');
    const old = await s.claim();
    await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [old.jobId]);
    const current = await s.claim();
    assert.equal(current.attempt, 2); assert.notEqual(current.token, old.token);
    const before = await s.snapshot(id);
    assert.equal((await s.jobs.processClaim(old)).kind, 'stale');
    assert.equal(await s.jobs.recordFailure(old, new Error('private'), 0), 'stale');
    assert.deepEqual(await s.snapshot(id), before);
    assert.equal((await s.jobs.processClaim(current)).kind, 'completed');
    const committed = await s.snapshot(id);
    for (const claim of [old, current]) {
      assert.equal((await s.jobs.processClaim(claim)).kind, 'stale');
      assert.equal(await s.jobs.recordFailure(claim, new Error('private'), 0), 'stale');
    }
    assert.deepEqual(await s.snapshot(id), committed);
  });
});

test('T08 simultaneous completion of one current claim commits one phase only', async () => {
  await scope(async s => {
    const id = await s.add('T08 one current claim race');
    const claim = await s.claim();
    const results = await Promise.all([s.jobs.processClaim(claim), new ModerationJobRepository(s.database).processClaim(claim)]);
    assert.deepEqual(results.map(result => result.kind).sort(), ['completed', 'stale']);
    const row = (await s.observer.query(
      `SELECT l.version::text AS version,j.state,(SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
    assert.deepEqual(row, { version: '1', state: 'completed', history_count: 1 });
  });
});

test('T08 lease expiring while waiting for listing or retry job lock cannot mutate state', async () => {
  await scope(async s => {
    const id = await s.add('T08 lease after listing wait');
    const claim = await s.claim();
    const control = await s.control();
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    for (const mode of ['finish', 'failure']) {
      await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()+interval '700 milliseconds' WHERE id=$1", [claim.jobId]);
      await control.query('BEGIN');
      await control.query(mode === 'finish' ? 'SELECT id FROM listings WHERE id=$1 FOR UPDATE' : 'SELECT id FROM moderation_jobs WHERE listing_id=$1 FOR UPDATE', [id]);
      const operation = mode === 'finish' ? s.jobs.processClaim(claim).then(value => value.kind) : s.jobs.recordFailure(claim, new Error('private'), 0);
      const settled = operation.then(value => ({ value }), error => ({ error }));
      try {
        await blocked(s.observer, pid, mode === 'finish' ? 'SELECT id,status FROM listings' : 'SELECT attempts FROM moderation_jobs');
        await until(async () => (await s.observer.query('SELECT lease_until<=clock_timestamp() AS expired FROM moderation_jobs WHERE id=$1', [claim.jobId])).rows[0].expired,
          value => value === true);
      } finally { await control.query('ROLLBACK'); }
      const result = await settled;
      if ('error' in result) throw result.error;
      assert.equal(result.value, 'stale');
      await pending(s.observer, id);
    }
  });
});

test('T08 live and stale attempts preserve true human results and inconsistent nonpending history', async () => {
  await scope(async s => {
    for (const status of ['published', 'rejected', 'auto_approved']) {
      const id = await s.add('T08 preserve human ' + status);
      const claim = await s.claim();
      const human = status !== 'auto_approved';
      const decision = { outcome: status === 'rejected' ? 'rejected' : 'approved',
        reasons: [{ rule_id: human ? 'HUMAN' : 'R4', message: 'fixture current result' }] };
      await s.database.query(`UPDATE listings SET status=$2,decision=$3::jsonb,decided_at='2026-01-02Z',
        published_at=CASE WHEN $2='published' THEN '2026-01-02Z'::timestamptz END,
        normalized_fingerprint='preserve-me',version=7 WHERE id=$1`, [id, status, JSON.stringify(decision)]);
      await s.database.query(`INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
        VALUES($1,'auto','{"outcome":"escalated","reasons":[{"rule_id":"R5","message":"prior escalation"}]}','2026-01-01Z')`, [id]);
      if (human) await s.database.query(`INSERT INTO moderation_history(listing_id,phase,decision,decided_at,moderator_id)
        VALUES($1,'human',$2::jsonb,'2026-01-02Z','moderator-fixture')`, [id, JSON.stringify(decision)]);
      const before = await s.snapshot(id) as { listing: string; history: string };
      assert.equal((await s.jobs.processClaim({ ...claim, token: '00000000-0000-4000-8000-000000000000' })).kind, 'stale');
      assert.deepEqual(await s.snapshot(id), before);
      assert.equal((await s.jobs.processClaim(claim)).kind, 'quarantined');
      const after = await s.snapshot(id) as { listing: string; history: string };
      assert.equal(after.listing, before.listing); assert.equal(after.history, before.history);
    }
  });
});

test('T08 unexpected existing auto history fails uniqueness and rolls back the pending listing', async () => {
  await scope(async s => {
    const id = await s.add('T08 history uniqueness');
    const claim = await s.claim();
    await s.database.query(`INSERT INTO moderation_history(listing_id,phase,decision)
      VALUES($1,'auto','{"outcome":"approved","reasons":[]}')`, [id]);
    const before = await s.snapshot(id);
    await assert.rejects(s.jobs.processClaim(claim), { code: '23505' });
    assert.deepEqual(await s.snapshot(id), before);
  });
});

test('T08 persisted malformed reason is rejected by production mapper and all phase writes roll back', async () => {
  await scope(async s => {
    const id = await s.add('T08 corrupt persisted reason');
    const claim = await s.claim();
    await s.database.query(`CREATE FUNCTION t08_corrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      NEW.decision=jsonb_set(NEW.decision,'{reasons}','[{"rule_id":"R1"}]'::jsonb); RETURN NEW; END $$`);
    await s.database.query("CREATE TRIGGER t08_corrupt BEFORE UPDATE ON listings FOR EACH ROW WHEN (NEW.status<>'pending') EXECUTE FUNCTION t08_corrupt()");
    await assert.rejects(s.jobs.processClaim(claim), /decision reason has an invalid shape/);
    await pending(s.observer, id);
    await s.database.query('DROP TRIGGER t08_corrupt ON listings');
    assert.equal(await s.jobs.recordFailure(claim, new TypeError('invalid persisted reason'), 0), 'retried');
    assert.equal((await s.jobs.processClaim(await s.claim())).kind, 'completed');
  });
});

test('T08 concurrent observer sees complete phase only after transaction commits', async () => {
  await scope(async s => {
    const id = await s.add('T08 atomic visibility');
    const claim = await s.claim();
    const control = await s.control();
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await control.query('SELECT pg_advisory_lock(82755,1)');
    await s.database.query(`CREATE FUNCTION t08_completion_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='completed' THEN PERFORM pg_advisory_xact_lock(82755,1); END IF; RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t08_completion_barrier BEFORE UPDATE ON moderation_jobs FOR EACH ROW EXECUTE FUNCTION t08_completion_barrier()');
    const operation = s.jobs.processClaim(claim);
    const settled = operation.then(value => ({ value }), error => ({ error }));
    try {
      await blocked(s.observer, pid, 'UPDATE moderation_jobs SET state=');
      await pending(s.observer, id);
    } finally { await control.query('SELECT pg_advisory_unlock(82755,1)'); }
    const result = await settled;
    if ('error' in result) throw result.error;
    assert.equal(result.value.kind, 'completed');
    const row = (await s.observer.query(`SELECT l.status,j.state,l.version::text AS version,
      h.decision=l.decision AS same_decision,h.decided_at=l.decided_at AS same_time
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id JOIN moderation_history h ON h.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'auto_approved', state: 'completed', version: '1', same_decision: true, same_time: true });
  });
});

test('T08 production lock and statement timeouts raise real SQLSTATE and roll back before retry', { timeout: 30000 }, async () => {
  await scope(async s => {
    const id = await s.add('T08 real timeouts');
    let claim = await s.claim();
    const control = await s.control();
    await control.query('BEGIN');
    await control.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE', [id]);
    try { await assert.rejects(s.jobs.processClaim(claim), { code: '55P03' }); }
    finally { await control.query('ROLLBACK'); }
    await pending(s.observer, id);
    assert.equal(await s.jobs.recordFailure(claim, { code: '55P03' }, 0), 'retried');
    claim = await s.claim();
    await s.database.query(`CREATE FUNCTION t08_statement_timeout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_sleep(11); RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t08_statement_timeout BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION t08_statement_timeout()');
    await assert.rejects(s.jobs.processClaim(claim), { code: '57014' });
    await pending(s.observer, id);
    await s.database.query('DROP TRIGGER t08_statement_timeout ON moderation_history');
    assert.equal(await s.jobs.recordFailure(claim, { code: '57014' }, 0), 'retried');
    assert.equal((await s.jobs.processClaim(await s.claim())).kind, 'completed');
  });
});

test('T08 lost acknowledgement after real COMMIT cannot requeue or duplicate the durable phase', async () => {
  await scope(async s => {
    const id = await s.add('T08 lost commit acknowledgement');
    const claim = await s.claim();
    const injected = new Error('simulated lost commit acknowledgement');
    const boundary = Object.create(s.database) as Database;
    boundary.transaction = async work => { await s.database.transaction(work); throw injected; };
    await assert.rejects(new ModerationJobRepository(boundary).processClaim(claim), error => error === injected);
    const committed = await s.snapshot(id);
    assert.equal(await s.jobs.recordFailure(claim, injected, 0), 'stale');
    assert.equal((await s.jobs.processClaim(claim)).kind, 'stale');
    assert.deepEqual(await s.snapshot(id), committed);
    assert.equal((await s.jobs.claimNext()).kind, 'idle');
  });
});

test('T08 exact operator listing/job guard requeues only the inspected pending failed pair', async () => {
  await scope(async s => {
    const first = await s.add('T08 operator first'); const other = await s.add('T08 operator other');
    await s.database.query("UPDATE moderation_jobs SET state='failed',attempts=5,last_error='inspect' WHERE listing_id=ANY($1::text[])", [[first, other]]);
    const jobs = (await s.database.query<{ id: string; listing_id: string }>('SELECT id,listing_id FROM moderation_jobs')).rows;
    const firstJob = jobs.find(row => row.listing_id === first)!.id;
    const otherJob = jobs.find(row => row.listing_id === other)!.id;
    const requeue = (listingId: string, jobId: string) => s.database.transaction(async client => {
      await client.query('SELECT id,status FROM listings WHERE id=$1 FOR UPDATE', [listingId]);
      await client.query('SELECT id,listing_id,state,last_error,attempts FROM moderation_jobs WHERE id=$1 AND listing_id=$2 FOR UPDATE', [jobId, listingId]);
      return client.query(`UPDATE moderation_jobs SET state='queued',attempts=0,available_at=clock_timestamp(),
        lease_until=NULL,claim_token=NULL,completed_at=NULL,last_error='operator_requeue_after_inspection'
        WHERE id=$1 AND listing_id=$2 AND state='failed'
        AND EXISTS (SELECT 1 FROM listings WHERE id=$2 AND status='pending') RETURNING id`, [jobId, listingId]);
    });
    const before = await s.snapshot(first);
    assert.equal((await requeue(first, otherJob)).rowCount, 0);
    assert.deepEqual(await s.snapshot(first), before);
    assert.equal((await requeue(first, firstJob)).rowCount, 1);
    const claim = await s.claim();
    assert.equal(claim.listingId, first); assert.equal(claim.attempt, 1);
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    const completed = await s.snapshot(first);
    assert.equal((await requeue(first, firstJob)).rowCount, 0);
    assert.deepEqual(await s.snapshot(first), completed);
    await s.database.query(`UPDATE listings SET status='published',decision='{"outcome":"approved","reasons":[{"rule_id":"HUMAN","message":"human fixture"}]}',
      decided_at=clock_timestamp() WHERE id=$1`, [other]);
    const human = await s.snapshot(other);
    assert.equal((await requeue(other, otherJob)).rowCount, 0);
    assert.deepEqual(await s.snapshot(other), human);
  });
});
