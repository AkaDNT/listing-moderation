import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocked, scope, stop, until } from './helpers/t08';
import { sanitizeWorkerError } from '../src/worker/job-policy';
import { randomUUID } from 'node:crypto';

test('T11 compiled worker completion event contains committed phase, outcome and rule IDs', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 worker diagnostic normal listing');
    const child = await s.child('20');
    const line = await until(async () => child.logs().split('\n').find(value => value.includes('worker_job_completed')),
      value => value !== undefined);
    assert.ok(line);
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(event.listing_id, listingId);
    assert.equal(event.attempt, 1);
    assert.equal(event.phase, 'auto');
    assert.equal(event.outcome, 'approved');
    assert.deepEqual(event.rule_ids, []);
    assert.equal('token' in event, false);
    assert.equal('title' in event, false);
    const row = (await s.observer.query('SELECT status,decision->>\'outcome\' AS outcome FROM listings WHERE id=$1', [listingId])).rows[0];
    assert.equal(row.outcome, 'approved');
    assert.ok(row.status === 'auto_approved' || row.status === 'published');
  });
});

test('T11 real PostgreSQL claim reports lease recovery and quarantine identifiers', async () => {
  await scope(async s => {
    const recoveredId = await s.add('T11 recovered claim');
    const first = await s.jobs.claimNext();
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;
    await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [first.claim.jobId]);
    const second = await s.jobs.claimNext();
    assert.equal(second.kind, 'claimed');
    if (second.kind !== 'claimed') return;
    assert.equal(second.claim.listingId, recoveredId);
    assert.equal((second.claim as typeof second.claim & { recovered?: boolean }).recovered, true);
    const invalidId = await s.add('T11 malformed running metadata');
    await s.database.query("UPDATE moderation_jobs SET state='running',attempts=2,claim_token=NULL,lease_until=NULL WHERE listing_id=$1", [invalidId]);
    const invalid = await s.jobs.claimNext();
    assert.equal(invalid.kind, 'quarantined');
    if (invalid.kind !== 'quarantined') return;
    assert.equal((invalid as typeof invalid & { listingId?: string }).listingId, invalidId);
    assert.equal((invalid as typeof invalid & { attempt?: number }).attempt, 2);
    assert.equal((invalid as typeof invalid & { diagnostic?: string }).diagnostic, 'invalid_running_metadata');
  });
});

test('T11 compiled worker logs the nonpending quarantine diagnostic and preserves committed phase', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 nonpending quarantine event', 's-1004');
    assert.equal((await s.jobs.processClaim(await s.claim())).kind, 'completed');
    // Schema-valid inconsistent job fixture; committed listing and auto history remain real production outputs.
    await s.database.query(`UPDATE moderation_jobs SET state='queued',attempts=0,completed_at=NULL,
      claim_token=NULL,lease_until=NULL,last_error=NULL WHERE listing_id=$1`, [listingId]);
    const before = await s.snapshot(listingId) as { listing: string; history: string };
    const control = await s.control();
    await control.query('BEGIN');
    await control.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE', [listingId]);
    const blocker = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const child = await s.child('20');
    await blocked(s.observer, blocker, 'FROM listings WHERE id=$1 FOR UPDATE');
    await control.query('COMMIT');
    const line = await until(async () => child.errors().split('\n').find(value => {
      try { const event = JSON.parse(value); return event.event === 'worker_job_quarantined' && event.listing_id === listingId; }
      catch { return false; }
    }), value => value !== undefined);
    assert.ok(line);
    await stop(child.process);
    const event = JSON.parse(line) as Record<string, unknown>;
    const after = await s.snapshot(listingId) as { listing: string; history: string };
    assert.equal(after.listing, before.listing);
    assert.equal(after.history, before.history);
    assert.deepEqual((await s.observer.query(`SELECT state,attempts,last_error,claim_token,lease_until,completed_at
      FROM moderation_jobs WHERE listing_id=$1`, [listingId])).rows[0], {
      state: 'failed', attempts: 1, last_error: 'unexpected_nonpending_listing', claim_token: null, lease_until: null, completed_at: null,
    });
    assert.doesNotMatch(child.logs(), /worker_job_completed/);
    assert.equal(event.phase, 'auto');
    assert.equal(event.attempt, 1);
    assert.equal(event.diagnostic, 'unexpected_nonpending_listing');
  });
});

test('T11 compiled worker publication failure identifies the selected listing without leaking SQL text', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 publication diagnostic');
    assert.equal((await s.jobs.processClaim(await s.claim())).kind, 'completed');
    await s.database.query(`CREATE FUNCTION t11_fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='t11-publication-private-sentinel'; END $$`);
    await s.database.query("CREATE TRIGGER t11_fail_publication BEFORE UPDATE ON listings FOR EACH ROW WHEN (NEW.status='published') EXECUTE FUNCTION t11_fail_publication()");
    const child = await s.child('30');
    const line = await until(async () => child.errors().split('\n').find(value => value.includes('worker_publication_failed')),
      value => value !== undefined);
    assert.ok(line);
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(event.listing_id, listingId);
    assert.equal(event.phase, 'publication');
    assert.equal(event.diagnostic, 'database_error:P0001');
    assert.doesNotMatch(child.errors(), /t11-publication-private-sentinel/);
    const row = (await s.observer.query('SELECT status,version::text AS version FROM listings WHERE id=$1', [listingId])).rows[0];
    assert.deepEqual(row, { status: 'auto_approved', version: '1' });
  });
});

test('T11 compiled worker emits recovered claim and quarantined-job metadata from real rows', { timeout: 20000 }, async () => {
  await scope(async s => {
    const recoveredId = await s.add('T11 compiled recovered lease');
    const oldClaim = await s.claim();
    await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [oldClaim.jobId]);
    const quarantinedId = await s.add('T11 compiled invalid metadata');
    await s.database.query("UPDATE moderation_jobs SET state='running',attempts=2,claim_token=NULL,lease_until=NULL WHERE listing_id=$1", [quarantinedId]);
    const child = await s.child('20');
    const quarantineLine = await until(async () => child.errors().split('\n').find(line => line.includes('worker_job_quarantined')),
      line => line !== undefined);
    assert.ok(quarantineLine);
    const quarantine = JSON.parse(quarantineLine) as Record<string, unknown>;
    assert.equal(quarantine.listing_id, quarantinedId);
    assert.equal(quarantine.attempt, 2);
    assert.equal(quarantine.diagnostic, 'invalid_running_metadata');
    const recoveryLine = await until(async () => child.logs().split('\n').find(line => line.includes('worker_claim_recovered')),
      line => line !== undefined);
    assert.ok(recoveryLine);
    const recovery = JSON.parse(recoveryLine) as Record<string, unknown>;
    assert.equal(recovery.listing_id, recoveredId);
    assert.equal(recovery.attempt, 2);
    assert.equal(recovery.phase, 'auto');
    const rows = (await s.observer.query<{ listing_id: string; state: string; attempts: number }>(
      'SELECT listing_id,state,attempts FROM moderation_jobs WHERE listing_id=ANY($1::text[])', [[recoveredId, quarantinedId]])).rows;
    assert.deepEqual(rows.find(row => row.listing_id === quarantinedId),
      { listing_id: quarantinedId, state: 'failed', attempts: 2 });
  });
});

test('T11 publication mapper failure after selecting a valid listing ID keeps that ID in safe event', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 corrupt publication mapper event');
    assert.equal((await s.jobs.processClaim(await s.claim())).kind, 'completed');
    await s.database.query(`UPDATE listings SET decision='{"outcome":"approved","reasons":[{"rule_id":"R2"}]}'::jsonb WHERE id=$1`, [listingId]);
    const child = await s.child('30');
    const line = await until(async () => child.errors().split('\n').find(value => value.includes('worker_publication_failed')),
      value => value !== undefined);
    assert.ok(line);
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(event.listing_id, listingId);
    assert.equal(event.phase, 'publication');
    assert.doesNotMatch(line, /rule_id|R2|T11 corrupt publication mapper event/);
    assert.equal((await s.observer.query('SELECT status FROM listings WHERE id=$1', [listingId])).rows[0].status, 'auto_approved');
  });
});

test('T11 compiled worker exhaustion event carries the real failed job and attempt count', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 exhausted job event');
    await s.database.query("UPDATE moderation_jobs SET attempts=5,available_at=clock_timestamp()-interval '1 millisecond' WHERE listing_id=$1", [listingId]);
    const child = await s.child('30');
    const line = await until(async () => child.errors().split('\n').find(value => value.includes('worker_job_exhausted')),
      value => value !== undefined);
    assert.ok(line);
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(event.listing_id, listingId);
    assert.equal(event.attempt, 5);
    assert.equal(event.phase, 'auto');
    assert.equal(event.diagnostic, 'max_claims_exhausted');
    const state = (await s.observer.query(`SELECT j.state,l.status FROM moderation_jobs j
      JOIN listings l ON l.id=j.listing_id WHERE j.listing_id=$1`, [listingId])).rows[0];
    assert.deepEqual(state, { state: 'failed', status: 'pending' });
  });
});

test('T11 compiled completion events include persisted R4 and R1 rule IDs without listing text', { timeout: 20000 }, async () => {
  await scope(async s => {
    const trustedId = await s.add('T11 trusted clean rule event', 's-1005');
    const bannedId = await s.add('T11 fake trusted rule event', 's-1005');
    const child = await s.child('20');
    const readEvent = async (id: string) => {
      const line = await until(async () => child.logs().split('\n').find(value => {
        if (!value.includes('worker_job_completed') || !value.includes(id)) return false;
        try { return JSON.parse(value).listing_id === id; } catch { return false; }
      }), value => value !== undefined);
      assert.ok(line);
      return JSON.parse(line) as Record<string, unknown>;
    };
    const trustedEvent = await readEvent(trustedId);
    const bannedEvent = await readEvent(bannedId);
    assert.deepEqual(trustedEvent.rule_ids, ['R4']);
    assert.deepEqual(bannedEvent.rule_ids, ['R1']);
    assert.equal(trustedEvent.outcome, 'approved');
    assert.equal(bannedEvent.outcome, 'rejected');
    assert.doesNotMatch(child.logs() + child.errors(), /T11 trusted clean rule event|T11 fake trusted rule event/);
    const rows = (await s.observer.query<{ id: string; status: string; outcome: string; rules: string[]; history_count: number }>(
      `SELECT l.id,l.status,l.decision->>'outcome' AS outcome,
        ARRAY(SELECT r->>'rule_id' FROM jsonb_array_elements(l.decision->'reasons') r) AS rules,
        (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
       FROM listings l WHERE l.id=ANY($1::text[])`, [[trustedId, bannedId]])).rows;
    const trusted = rows.find(row => row.id === trustedId)!;
    const banned = rows.find(row => row.id === bannedId)!;
    assert.deepEqual(trusted.rules, ['R4']);
    assert.equal(trusted.outcome, 'approved');
    assert.ok(trusted.status === 'auto_approved' || trusted.status === 'published');
    assert.equal(trusted.history_count, 1);
    assert.deepEqual(banned.rules, ['R1']);
    assert.equal(banned.status, 'auto_rejected');
    assert.equal(banned.history_count, 1);
  });
});

test('T11 compiled worker observes a stale token after the real processClaim listing lock and leaves state untouched',
  { timeout: 20000 }, async () => {
    await scope(async s => {
      const listingId = await s.add('T11 stale token private listing sentinel');
      const control = await s.control();
      await control.query('BEGIN');
      await control.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE', [listingId]);
      const blockerPid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const child = await s.child('20');
      const processPid = await blocked(s.observer, blockerPid, 'FROM listings WHERE id=$1 FOR UPDATE');
      assert.ok(processPid > 0);
      const old = (await control.query<{ id: string; attempts: number; claim_token: string | null }>(
        'SELECT id,attempts,claim_token FROM moderation_jobs WHERE listing_id=$1', [listingId])).rows[0];
      assert.equal(old.attempts, 1);
      assert.ok(old.claim_token);
      const replacementToken = randomUUID();
      await control.query(`UPDATE moderation_jobs SET claim_token=$2::uuid,
        lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1`, [old.id, replacementToken]);
      const fixtureSnapshot = (await control.query(
        `SELECT row_to_json(l)::text AS listing,row_to_json(j)::text AS job,
         (SELECT COALESCE(json_agg(h ORDER BY h.id),'[]'::json)::text FROM moderation_history h WHERE h.listing_id=l.id) AS history
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [listingId])).rows[0];
      await control.query('COMMIT');

      const staleLine = await until(async () => child.errors().split('\n').find(value => {
        if (!value.includes('worker_job_stale') || !value.includes(listingId)) return false;
        try { return JSON.parse(value).listing_id === listingId; } catch { return false; }
      }), value => value !== undefined);
      assert.ok(staleLine);
      const event = JSON.parse(staleLine) as Record<string, unknown>;
      assert.equal(event.phase, 'auto');
      assert.equal(event.attempt, 1);
      assert.equal('token' in event, false);
      assert.doesNotMatch(child.logs() + child.errors(), /T11 stale token private listing sentinel/);
      assert.equal(child.logs().split('\n').some(line => {
        try { const item = JSON.parse(line); return item.event === 'worker_job_completed' && item.listing_id === listingId; }
        catch { return false; }
      }), false);
      assert.deepEqual(await s.snapshot(listingId), fixtureSnapshot);
      const state = (await s.observer.query(`SELECT l.status,l.decision,l.decided_at,l.normalized_fingerprint,
        l.version::text AS version,j.state,j.attempts,j.claim_token::text AS claim_token,
        (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
        FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [listingId])).rows[0];
      assert.deepEqual(state, { status: 'pending', decision: null, decided_at: null, normalized_fingerprint: null,
        version: '0', state: 'running', attempts: 1, claim_token: replacementToken, history_count: 0 });
      await stop(child.process);
    });
  });
test('T11 worker error sanitizer ignores causes and accepts only safe code and name tokens', () => {
  const nested = new AggregateError([new Error('body password=private')], 'outer private message', {
    cause: { name: 'DatabaseError', code: 'P0001', message: 'https://private.example/password' },
  });
  assert.equal(sanitizeWorkerError(nested), 'unexpected_error:AggregateError');
  assert.equal(sanitizeWorkerError({ code: 'P0001', name: 'ignored' }), 'database_error:P0001');
  assert.equal(sanitizeWorkerError({ code: '40001' }), 'database_error:40001');
  for (const code of ['p0001', 'P00', 'P0001\n', 'https://secret']) {
    assert.equal(sanitizeWorkerError({ code, name: 'Error' }), 'unexpected_error:Error');
  }
  for (const name of ['bad name', 'Bad\nName', 'A'.repeat(41)]) {
    assert.equal(sanitizeWorkerError({ name }), 'unexpected_error:unknown');
  }
  assert.equal(sanitizeWorkerError(new TypeError('private')), 'unexpected_error:TypeError');
  for (const value of [null, 7, 'private', {}]) assert.equal(sanitizeWorkerError(value), 'unexpected_error:unknown');
});

test('T11 compiled worker claim failure logs the auto phase and leaves the queued row unchanged', { timeout: 20000 }, async () => {
  await scope(async s => {
    const listingId = await s.add('T11 claim failure private listing sentinel');
    await s.database.query(`CREATE FUNCTION t11_fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.state='queued' AND NEW.state='running' THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='t11-claim-private-sentinel';
      END IF; RETURN NEW; END $$`);
    await s.database.query(`CREATE TRIGGER t11_claim_failure BEFORE UPDATE ON moderation_jobs
      FOR EACH ROW EXECUTE FUNCTION t11_fail_claim()`);
    const child = await s.child('20');
    const line = await until(async () => child.errors().split('\n').find(value => {
      if (!value.includes('worker_claim_failed')) return false;
      try { return JSON.parse(value).phase === 'auto'; } catch { return false; }
    }), value => value !== undefined);
    assert.ok(line);
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(event.phase, 'auto');
    assert.equal(event.diagnostic, 'database_error:P0001');
    assert.doesNotMatch(child.logs() + child.errors(), /t11-claim-private-sentinel|T11 claim failure private listing sentinel/);
    await stop(child.process);
    const state = (await s.observer.query(`SELECT l.status,l.decision,j.state,j.attempts,
      (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [listingId])).rows[0];
    assert.deepEqual(state, { status: 'pending', decision: null, state: 'queued', attempts: 0, history_count: 0 });
  });
});

test('T11 compiled worker expiry failure logs phase without guessing a listing ID and preserves publication state',
  { timeout: 20000 }, async () => {
    await scope(async s => {
      const listingId = await s.add('T11 expiry failure private listing sentinel');
      const worker = await s.child('20');
      await until(async () => (await s.observer.query<{ status: string }>(
        'SELECT status FROM listings WHERE id=$1', [listingId])).rows[0], row => row.status === 'published');
      await stop(worker.process);
      await s.database.query("UPDATE listings SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [listingId]);
      await s.database.query(`CREATE FUNCTION t11_fail_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status='expired' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='t11-expiry-private-sentinel'; END IF;
        RETURN NEW; END $$`);
      await s.database.query(`CREATE TRIGGER t11_expiry_failure BEFORE UPDATE ON listings
        FOR EACH ROW EXECUTE FUNCTION t11_fail_expiry()`);
      const expirer = await s.child('20');
      const line = await until(async () => expirer.errors().split('\n').find(value => value.includes('worker_expiry_failed')),
        value => value !== undefined);
      assert.ok(line);
      const event = JSON.parse(line) as Record<string, unknown>;
      assert.equal(event.phase, 'expiry');
      assert.equal(event.diagnostic, 'database_error:P0001');
      assert.equal('listing_id' in event, false);
      assert.doesNotMatch(expirer.logs() + expirer.errors(), /t11-expiry-private-sentinel|T11 expiry failure private listing sentinel/);
      await stop(expirer.process);
      const state = (await s.observer.query(`SELECT l.status,l.version::text AS version,j.state,
        (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
        FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [listingId])).rows[0];
      assert.deepEqual(state, { status: 'published', version: '2', state: 'completed', history_count: 1 });
    });
  });
