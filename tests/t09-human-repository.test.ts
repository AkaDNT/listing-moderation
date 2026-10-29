import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { SubmissionRepository } from '../src/submission/submission.repository';
import { ModerationJobRepository } from '../src/worker/moderation-job.repository';
import { HumanDecisionRepository } from '../src/human/human-decision.repository';
import { createTestDatabase } from './helpers/postgres';

async function withDatabase(run: (database: Database) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  let database: Database | undefined;
  let primary: unknown;
  try {
    database = await Database.open(fixture.url, await loadBootstrapAssets());
    await run(database);
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await fixture.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    throw new AggregateError([...(primary === undefined ? [] : [primary]), ...cleanup], 'T09 real PostgreSQL test/cleanup failed', { cause: primary });
  }
}

async function createEscalated(database: Database, title: string): Promise<string> {
  const submissions = new SubmissionRepository(database);
  const created = await submissions.submit({ sellerId: 's-1004', categoryId: 'c-phones', title,
    description: 'ordinary item', priceVnd: 6000000n });
  const jobs = new ModerationJobRepository(database);
  const claim = await jobs.claimNext();
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') throw new Error('T09 setup did not claim submitted listing');
  assert.equal(claim.claim.listingId, created.id);
  assert.equal((await jobs.processClaim(claim.claim)).kind, 'completed');
  const state = (await database.query<{ status: string; decision: { outcome: string } }>(
    'SELECT status,decision FROM listings WHERE id=$1', [created.id])).rows[0];
  assert.equal(state.status, 'needs_human');
  assert.equal(state.decision.outcome, 'escalated');
  return created.id;
}

test('real human decision transaction publishes or rejects once and appends exact human history', async () => {
  await withDatabase(async database => {
    const id = await createEscalated(database, 'T09 human approval');
    const before = (await database.query<{ auto_decision: string; auto_at: Date; job: string }>(
      `SELECT h.decision::text AS auto_decision,h.decided_at AS auto_at,j.state AS job
       FROM moderation_history h JOIN moderation_jobs j ON j.listing_id=h.listing_id
       WHERE h.listing_id=$1 AND h.phase='auto'`, [id])).rows[0];
    const result = await new HumanDecisionRepository(database).resolve(id,
      { decision: 'approve', moderatorId: '  moderator 🧑‍⚖️ ', note: '' }, 2);
    assert.equal(result.kind, 'applied');
    if (result.kind !== 'applied') throw new Error('Expected human approval to apply');
    assert.equal(result.listing.status, 'published');
    assert.equal((result.listing.decision as { outcome: string }).outcome, 'approved');
    assert.deepEqual((result.listing.decision as { reasons: unknown[] }).reasons, [
      { rule_id: 'HUMAN', message: 'Approved by human moderator' },
    ]);
    const rows = await database.query<{
      status: string; version: string; decided_at: Date; published_at: Date; expires_at: Date;
      current_decision: string; auto_decision: string; auto_at: Date; job: string;
      human_decision: string; human_at: Date; moderator_id: string; note: string | null; phases: string[];
    }>(
      `SELECT l.status,l.version::text,l.decided_at,l.published_at,l.expires_at,l.decision::text AS current_decision,
       (SELECT h.decision::text FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS auto_decision,
       (SELECT h.decided_at FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='auto') AS auto_at,
       j.state AS job,
       (SELECT h.decision::text FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='human') AS human_decision,
       (SELECT h.decided_at FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='human') AS human_at,
       (SELECT h.moderator_id FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='human') AS moderator_id,
       (SELECT h.note FROM moderation_history h WHERE h.listing_id=l.id AND h.phase='human') AS note,
       (SELECT array_agg(h.phase ORDER BY h.phase) FROM moderation_history h WHERE h.listing_id=l.id) AS phases
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
    const row = rows.rows[0];
    assert.equal(row.status, 'published');
    assert.equal(row.version, '2');
    assert.equal(row.decided_at.toISOString(), row.published_at.toISOString());
    assert.equal(row.expires_at.getTime() - row.published_at.getTime(), 2 * 24 * 60 * 60 * 1000);
    assert.equal(row.current_decision, row.human_decision);
    assert.equal(row.auto_decision, before.auto_decision);
    assert.equal(row.auto_at.toISOString(), before.auto_at.toISOString());
    assert.equal(row.human_at.toISOString(), row.decided_at.toISOString());
    assert.equal(row.moderator_id, '  moderator 🧑‍⚖️ ');
    assert.equal(row.note, '');
    assert.equal(row.job, before.job);
    assert.deepEqual(row.phases, ['auto', 'human']);
  });
});

test('human reject keeps publication timestamps NULL and absent note NULL', async () => {
  await withDatabase(async database => {
    const id = await createEscalated(database, 'T09 human rejection');
    const result = await new HumanDecisionRepository(database).resolve(id,
      { decision: 'reject', moderatorId: '', note: null }, 30);
    if (result.kind !== 'applied') throw new Error(`Expected applied, got ${result.kind}`);
    assert.equal(result.listing.status, 'rejected');
    const row = (await database.query<{ status: string; outcome: string; message: string; published_at: Date | null; expires_at: Date | null; note: string | null; moderator_id: string }>(
      `SELECT l.status,l.decision->>'outcome' AS outcome,l.decision#>>'{reasons,0,message}' AS message,
         l.published_at,l.expires_at,h.note,h.moderator_id FROM listings l
       JOIN moderation_history h ON h.listing_id=l.id AND h.phase='human' WHERE l.id=$1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'rejected', outcome: 'rejected', message: 'Rejected by human moderator',
      published_at: null, expires_at: null, note: null, moderator_id: '' });
  });
});

test('needs_human with a schema-valid non-escalated persisted outcome is integrity failure with no mutation', async () => {
  await withDatabase(async database => {
    const id = await createEscalated(database, 'T09 corrupt human prestate');
    const snapshot = () => database.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
       l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,
       j.state,j.attempts,j.claim_token,j.lease_until::text AS lease_until,
       (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
        FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
    const corruptions = [
      `UPDATE listings SET decision=jsonb_build_object('outcome','approved','reasons','[]'::jsonb) WHERE id=$1`,
      `UPDATE listings SET decision=jsonb_build_object('outcome','rejected','reasons','[]'::jsonb) WHERE id=$1`,
      `UPDATE listings SET published_at=clock_timestamp() WHERE id=$1`,
    ];
    for (const corrupt of corruptions) {
      await database.query(corrupt, [id]);
      const before = await snapshot();
      await assert.rejects(new HumanDecisionRepository(database).resolve(id,
        { decision: 'approve', moderatorId: 'm', note: null }, 30),
      /T09 needs_human listing has inconsistent persisted decision or publication timestamps/);
      assert.deepEqual((await snapshot()).rows, before.rows);
      await database.query(`UPDATE listings SET decision=jsonb_build_object('outcome','escalated','reasons','[]'::jsonb),
        published_at=NULL,expires_at=NULL WHERE id=$1`, [id]);
    }
  });
});

test('human history insert failure rolls back the decision and retry succeeds after trigger removal', async () => {
  await withDatabase(async database => {
    const id = await createEscalated(database, 'T09 human history rollback');
    await database.query(`CREATE FUNCTION t09_fail_human_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.phase='human' THEN RAISE EXCEPTION 'forced human history failure'; END IF; RETURN NEW; END $$`);
    await database.query(`CREATE TRIGGER t09_fail_human_history BEFORE INSERT ON moderation_history
      FOR EACH ROW EXECUTE FUNCTION t09_fail_human_history()`);
    const snapshot = () => database.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
    const before = await snapshot();
    await assert.rejects(new HumanDecisionRepository(database).resolve(id,
      { decision: 'approve', moderatorId: 'm', note: 'rollback proof' }, 2), /forced human history failure/);
    assert.deepEqual((await snapshot()).rows, before.rows);
    await database.query('DROP TRIGGER t09_fail_human_history ON moderation_history');
    await database.query('DROP FUNCTION t09_fail_human_history()');
    const retry = await new HumanDecisionRepository(database).resolve(id,
      { decision: 'approve', moderatorId: 'm', note: 'rollback proof' }, 2);
    assert.equal(retry.kind, 'applied');
    const after = await snapshot();
    assert.equal(after.rows[0].status, 'published');
    assert.equal(after.rows[0].version, '2');
    assert.deepEqual((after.rows[0].history as Array<{ phase: string }>).map(row => row.phase), ['auto', 'human']);
  });
});

test('actual human approval remains unchanged when the completed auto claim is replayed', async () => {
  await withDatabase(async database => {
    const submissions = new SubmissionRepository(database);
    const created = await submissions.submit({ sellerId: 's-1004', categoryId: 'c-phones', title: 'T09 human fences old claim',
      description: 'ordinary item', priceVnd: 6000000n });
    const jobs = new ModerationJobRepository(database);
    const claim = await jobs.claimNext();
    assert.equal(claim.kind, 'claimed');
    if (claim.kind !== 'claimed') throw new Error('Expected T08 auto escalation claim');
    assert.equal(claim.claim.listingId, created.id);
    assert.equal((await jobs.processClaim(claim.claim)).kind, 'completed');
    const human = await new HumanDecisionRepository(database).resolve(created.id,
      { decision: 'approve', moderatorId: 'moderator', note: null }, 30);
    assert.equal(human.kind, 'applied');
    const before = await database.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [created.id]);
    assert.equal((await jobs.processClaim(claim.claim)).kind, 'stale');
    const after = await database.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [created.id]);
    assert.deepEqual(after.rows, before.rows);
  });
});

test('a replaced and expired automated claim cannot overwrite a real human result', async () => {
  await withDatabase(async database => {
    const created = await new SubmissionRepository(database).submit({ sellerId: 's-1004', categoryId: 'c-phones',
      title: 'T09 replaced claim cannot overwrite human', description: 'ordinary item', priceVnd: 6000000n });
    const jobs = new ModerationJobRepository(database);
    const first = await jobs.claimNext();
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') throw new Error('Expected first automated claim');
    assert.equal(first.claim.listingId, created.id);

    await database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [first.claim.jobId]);
    const replacement = await jobs.claimNext();
    assert.equal(replacement.kind, 'claimed');
    if (replacement.kind !== 'claimed') throw new Error('Expected reclaimed automated claim');
    assert.equal(replacement.claim.listingId, created.id);
    assert.equal(replacement.claim.attempt, 2);
    assert.notEqual(replacement.claim.token, first.claim.token);
    assert.equal((await jobs.processClaim(replacement.claim)).kind, 'completed');
    const escalated = (await database.query<{ status: string; outcome: string }>(
      `SELECT status,decision->>'outcome' AS outcome FROM listings WHERE id=$1`, [created.id])).rows[0];
    assert.deepEqual(escalated, { status: 'needs_human', outcome: 'escalated' });

    const human = await new HumanDecisionRepository(database).resolve(created.id,
      { decision: 'reject', moderatorId: 'moderator', note: 'reviewed' }, 30);
    assert.equal(human.kind, 'applied');
    const snapshot = () => database.query(
      `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
        l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
        (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
         FROM moderation_history h WHERE h.listing_id=l.id) AS history
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [created.id]);
    const before = await snapshot();
    assert.equal((await jobs.processClaim(first.claim)).kind, 'stale');
    assert.deepEqual((await snapshot()).rows, before.rows);
    assert.equal(before.rows[0].status, 'rejected');
    assert.equal(before.rows[0].attempts, 2);
    assert.deepEqual((before.rows[0].history as Array<{ phase: string }>).map(row => row.phase), ['auto', 'human']);
  });
});
