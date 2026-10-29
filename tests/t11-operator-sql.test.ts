import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { scope } from './helpers/t08';
import { randomUUID } from 'node:crypto';

test('T11 published inspection SQL classifies due, live, expired and failed jobs without writes', async () => {
  const sql = await readFile(resolve('ops/inspect-jobs.sql'), 'utf8');
  await scope(async s => {
    const listingId = await s.add('T11 inspect job');
    const inspect = async () => {
      const before = await s.snapshot(listingId);
      const result = (await s.observer.query(sql)).rows.find(row => row.listing_id === listingId);
      assert.ok(result);
      assert.deepEqual(await s.snapshot(listingId), before, 'inspection SQL must not mutate listing, job, or history');
      return result;
    };
    const initial = await inspect();
    assert.equal(initial.operational_state, 'queued_due');
    const claim = await s.claim();
    const live = await inspect();
    assert.equal(live.operational_state, 'running_live');
    assert.equal(live.attempts, 1);
    await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [claim.jobId]);
    const expired = await inspect();
    assert.equal(expired.operational_state, 'expired_lease_recoverable');
    for (const attempts of [4, 5]) {
      await s.database.query("UPDATE moderation_jobs SET attempts=$2,lease_until=clock_timestamp()+interval '10 minutes' WHERE id=$1", [claim.jobId, attempts]);
      assert.equal((await inspect()).operational_state, 'running_live');
      await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [claim.jobId]);
      assert.equal((await inspect()).operational_state, attempts === 5 ? 'exhausted_due' : 'expired_lease_recoverable');
    }
    await s.database.query("UPDATE moderation_jobs SET state='failed',last_error='database_error:P0001' WHERE id=$1", [claim.jobId]);
    const failed = await inspect();
    assert.equal(failed.operational_state, 'failed_needs_inspection');
    assert.equal(failed.last_error, 'database_error:P0001');
    assert.equal(failed.listing_status, 'pending');
    assert.equal(failed.phase_history_count, 0);
    await s.database.query("UPDATE moderation_jobs SET state='queued',attempts=2,available_at=clock_timestamp()+interval '10 minutes' WHERE id=$1", [claim.jobId]);
    assert.equal((await inspect()).operational_state, 'queued_backoff');
    await s.database.query("UPDATE moderation_jobs SET state='queued',attempts=5,available_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [claim.jobId]);
    assert.equal((await inspect()).operational_state, 'exhausted_due');
    await s.database.query("UPDATE moderation_jobs SET state='running',claim_token=NULL,lease_until=NULL WHERE id=$1", [claim.jobId]);
    assert.equal((await inspect()).operational_state, 'invalid_running_metadata');
    await s.database.query("UPDATE moderation_jobs SET state='completed',completed_at=clock_timestamp(),claim_token=NULL,lease_until=NULL WHERE id=$1", [claim.jobId]);
    assert.equal((await inspect()).operational_state, 'completed');
  });
});

test('T11 requeue SQL checks its pending, history, attempts, diagnostic, pair and state guards independently', async () => {
  const sql = await readFile(resolve('ops/requeue-failed-job.sql'), 'utf8');
  const steps = sql.split(/-- T11 STEP \d:[^\n]*\n/).slice(1).map(part => part.trim());
  const parameterized = steps.map(step => step
    .replaceAll(":'listing_id'", '$1').replaceAll(":'job_id'", '$2')
    .replaceAll(":'expected_attempts'", '$3').replaceAll(":'expected_error'", '$4'));
  await scope(async s => {
    const expectedError = 'database_error:P0001';
    const make = async (name: string, options: { listingStatus?: 'pending' | 'auto_approved'; history?: boolean;
      attempts?: number; storedError?: string; state?: 'failed' | 'queued' | 'running' | 'completed' } = {}) => {
      const listingId = await s.add('T11 requeue guard ' + name);
      const jobId = (await s.observer.query<{ id: string }>('SELECT id FROM moderation_jobs WHERE listing_id=$1', [listingId])).rows[0].id;
      if (options.listingStatus === 'auto_approved') {
        await s.database.query(`UPDATE listings SET status='auto_approved',decision='{"outcome":"approved","reasons":[]}'::jsonb,
          decided_at=clock_timestamp() WHERE id=$1`, [listingId]);
      }
      if (options.history) {
        await s.database.query(`INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
          VALUES($1,'auto','{"outcome":"approved","reasons":[]}'::jsonb,clock_timestamp())`, [listingId]);
      }
      const state = options.state ?? 'failed';
      await s.database.query(`UPDATE moderation_jobs SET state=$2,attempts=$3,last_error=$4,
        claim_token=$5::uuid,lease_until=CASE WHEN $2='running' THEN clock_timestamp()+interval '1 minute' ELSE NULL END,
        completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
        [jobId, state, options.attempts ?? 2, options.storedError ?? expectedError, state === 'running' ? randomUUID() : null]);
      return { listingId, jobId };
    };
    const runScript = async (listingId: string, jobId: string, attempts: number, error: string, expectedRows: number,
      expectedStep2Rows = 1) => {
      const before = await s.snapshot(listingId);
      const client = await s.control();
      await client.query('BEGIN');
      assert.equal((await client.query(parameterized[0], [listingId])).rowCount, 1);
      assert.equal((await client.query(parameterized[1], [listingId, jobId])).rowCount, expectedStep2Rows);
      const result = await client.query(parameterized[2], [listingId, jobId, attempts, error]);
      assert.equal(result.rowCount, expectedRows);
      await client.query('COMMIT');
      if (expectedRows === 0) {
        assert.deepEqual(await s.snapshot(listingId), before, 'a rejected guard combination must commit without mutation');
      }
      return result;
    };

    const pending = await make('happy');
    const happy = await runScript(pending.listingId, pending.jobId, 2, expectedError, 1);
    assert.deepEqual(happy.rows[0], { id: pending.jobId, listing_id: pending.listingId, state: 'queued', attempts: 0 });

    const nonpending = await make('nonpending-only', { listingStatus: 'auto_approved' });
    await runScript(nonpending.listingId, nonpending.jobId, 2, expectedError, 0);

    const history = await make('history-only', { history: true });
    await runScript(history.listingId, history.jobId, 2, expectedError, 0);

    const attempts = await make('stale-attempt-count', { attempts: 3 });
    await runScript(attempts.listingId, attempts.jobId, 2, expectedError, 0);

    const diagnostic = await make('stale-diagnostic', { storedError: 'database_error:40001' });
    await runScript(diagnostic.listingId, diagnostic.jobId, 2, expectedError, 0);

    const wrongListing = await make('wrong-pair-listing-a');
    const wrongJob = await make('wrong-pair-listing-b');
    await runScript(wrongListing.listingId, wrongJob.jobId, 2, expectedError, 0, 0);

    for (const state of ['queued', 'running', 'completed'] as const) {
      const otherState = await make('wrong-state-' + state, { state });
      await runScript(otherState.listingId, otherState.jobId, 2, expectedError, 0);
    }
  });
});

test('T11 published guarded requeue SQL rejects stale inspection and requeues exact pending job', async () => {
  const sql = await readFile(resolve('ops/requeue-failed-job.sql'), 'utf8');
  assert.match(sql, /^BEGIN;\r?$/m);
  assert.doesNotMatch(sql, /^COMMIT;/m);
  const steps = sql.split(/-- T11 STEP \d:[^\n]*\n/).slice(1).map(part => part.trim());
  assert.equal(steps.length, 3);
  const parameterized = steps.map(step => step
    .replaceAll(":'listing_id'", '$1').replaceAll(":'job_id'", '$2')
    .replaceAll(":'expected_attempts'", '$3').replaceAll(":'expected_error'", '$4'));
  await scope(async s => {
    const listingId = await s.add('T11 requeue exact pending job');
    const job = (await s.observer.query<{ id: string }>('SELECT id FROM moderation_jobs WHERE listing_id=$1', [listingId])).rows[0];
    await s.database.query("UPDATE moderation_jobs SET state='failed',attempts=2,last_error='database_error:P0001' WHERE id=$1", [job.id]);
    const client = await s.control();
    await client.query('BEGIN');
    const values = [listingId, job.id, 2, 'stale-diagnostic'];
    assert.equal((await client.query(parameterized[0], values.slice(0, 1))).rowCount, 1);
    assert.equal((await client.query(parameterized[1], values.slice(0, 2))).rowCount, 1);
    assert.equal((await client.query(parameterized[2], values)).rowCount, 0);
    await client.query('ROLLBACK');
    values[3] = 'database_error:P0001';
    await client.query('BEGIN');
    assert.equal((await client.query(parameterized[0], values.slice(0, 1))).rowCount, 1);
    assert.equal((await client.query(parameterized[1], values.slice(0, 2))).rowCount, 1);
    const updated = await client.query(parameterized[2], values);
    assert.equal(updated.rowCount, 1);
    assert.deepEqual(updated.rows[0], { id: job.id, listing_id: listingId, state: 'queued', attempts: 0 });
    await client.query('COMMIT');
    const next = await s.jobs.claimNext();
    assert.equal(next.kind, 'claimed');
    if (next.kind !== 'claimed') return;
    assert.equal(next.claim.listingId, listingId);
    assert.equal((await s.jobs.processClaim(next.claim)).kind, 'completed');
    const state = (await s.observer.query(`SELECT j.state,l.status,
      (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=l.id) AS history_count
      FROM moderation_jobs j JOIN listings l ON l.id=j.listing_id WHERE j.id=$1`, [job.id])).rows[0];
    assert.equal(state.state, 'completed');
    assert.equal(state.history_count, 1);
    await s.database.query("UPDATE moderation_jobs SET state='failed',attempts=2,last_error='database_error:P0001' WHERE id=$1", [job.id]);
    await client.query('BEGIN');
    assert.equal((await client.query(parameterized[0], values.slice(0, 1))).rowCount, 1);
    assert.equal((await client.query(parameterized[1], values.slice(0, 2))).rowCount, 1);
    assert.equal((await client.query(parameterized[2], values)).rowCount, 0);
    await client.query('ROLLBACK');
    const otherId = await s.add('T11 wrong pair guard');
    const otherJob = (await s.observer.query<{ id: string }>('SELECT id FROM moderation_jobs WHERE listing_id=$1', [otherId])).rows[0];
    await s.database.query("UPDATE moderation_jobs SET state='failed',attempts=2,last_error='database_error:P0001' WHERE id=$1", [otherJob.id]);
    await client.query('BEGIN');
    const wrongPair = [listingId, otherJob.id, 2, 'database_error:P0001'];
    assert.equal((await client.query(parameterized[1], wrongPair.slice(0, 2))).rowCount, 0);
    assert.equal((await client.query(parameterized[2], wrongPair)).rowCount, 0);
    await client.query('ROLLBACK');
  });
});
