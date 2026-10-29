import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { SubmissionRepository } from '../src/submission/submission.repository';
import { ModerationJobRepository } from '../src/worker/moderation-job.repository';
import { PublicationRepository, PublicationFailure } from '../src/lifecycle/publication.repository';
import { createTestDatabase } from './helpers/postgres';

async function withDatabase(run: (database: Database) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  let database: Database | undefined;
  let primary: unknown;
  try { database = await Database.open(fixture.url, await loadBootstrapAssets()); await run(database); }
  catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (database) try { await database.close(); } catch (error) { cleanup.push(error); }
  try { await fixture.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors, `T09 publication PostgreSQL/cleanup failed:\n${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`, { cause: primary });
  }
}

async function createAutoApproved(database: Database, title: string): Promise<string> {
  const created = await new SubmissionRepository(database).submit({ sellerId: 's-1002', categoryId: 'c-phones', title,
    description: 'clean publication fixture', priceVnd: 6000000n });
  const jobs = new ModerationJobRepository(database);
  const claim = await jobs.claimNext();
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') throw new Error('T09 publication setup did not obtain claim');
  assert.equal(claim.claim.listingId, created.id);
  assert.equal((await jobs.processClaim(claim.claim)).kind, 'completed');
  const row = (await database.query<{ status: string }>('SELECT status FROM listings WHERE id=$1', [created.id])).rows[0];
  assert.equal(row.status, 'auto_approved');
  return created.id;
}

test('automatic publication uses fixed 24-hour DB TTL, preserves auto decision/history/job and is idempotent', async () => {
  await withDatabase(async database => {
    for (const ttlDays of [1, 2, 30]) {
      const id = await createAutoApproved(database, `T09 publication TTL ${ttlDays}`);
      const before = (await database.query<{ decision: string; decided_at: Date; fingerprint: string | null; job: string; attempts: number }>(
        `SELECT l.decision::text AS decision,l.decided_at,l.normalized_fingerprint AS fingerprint,j.state AS job,j.attempts
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
      const repository = new PublicationRepository(database, ttlDays);
      const result = await repository.publishNext();
      assert.equal(result.kind, 'published');
      if (result.kind !== 'published') throw new Error('Expected one published listing');
      assert.equal(result.listing.id, id);
      assert.equal(result.listing.status, 'published');
      const after = (await database.query<{ status: string; decision: string; decided_at: Date; published_at: Date; expires_at: Date;
        fingerprint: string | null; job: string; attempts: number; history_count: number; version: string }>(
        `SELECT l.status,l.decision::text AS decision,l.decided_at,l.published_at,l.expires_at,
          l.normalized_fingerprint AS fingerprint,j.state AS job,j.attempts,
          (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count,l.version::text AS version
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
      assert.equal(after.status, 'published');
      assert.equal(after.decision, before.decision);
      assert.equal(after.decided_at.toISOString(), before.decided_at.toISOString());
      assert.equal(after.expires_at.getTime() - after.published_at.getTime(), ttlDays * 86400000);
      assert.equal(after.fingerprint, before.fingerprint);
      assert.equal(after.job, before.job);
      assert.equal(after.attempts, before.attempts);
      assert.equal(after.history_count, 1);
      assert.equal(after.version, '2');
      const again = await repository.publishNext();
      assert.deepEqual(again, { kind: 'idle' });
      const unchanged = (await database.query<{ published_at: Date; expires_at: Date; version: string }>(
        'SELECT published_at,expires_at,version::text AS version FROM listings WHERE id=$1', [id])).rows[0];
      assert.equal(unchanged.published_at.toISOString(), after.published_at.toISOString());
      assert.equal(unchanged.expires_at.toISOString(), after.expires_at.toISOString());
      assert.equal(unchanged.version, '2');
    }
  });
});

test('publication update SQL failure rolls back and can be retried after the fault is removed', async () => {
  await withDatabase(async database => {
    const id = await createAutoApproved(database, 'T09 publication trigger retry');
    await database.query(`CREATE FUNCTION t09_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='published' THEN RAISE EXCEPTION 'forced publication failure'; END IF; RETURN NEW; END $$`);
    await database.query(`CREATE TRIGGER t09_fail_publish BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION t09_fail_publish()`);
    const before = await database.query(
      `SELECT status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,normalized_fingerprint,version::text AS version FROM listings WHERE id=$1`, [id]);
    await assert.rejects(new PublicationRepository(database, 30).publishNext(), error => {
      assert.ok(error instanceof PublicationFailure);
      assert.equal(error.listingId, id);
      assert.match(String(error.cause), /forced publication failure/);
      assert.doesNotMatch(error.message, /forced publication failure/);
      return true;
    });
    const after = await database.query(
      `SELECT status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,normalized_fingerprint,version::text AS version FROM listings WHERE id=$1`, [id]);
    assert.deepEqual(after.rows, before.rows);
    await database.query('DROP TRIGGER t09_fail_publish ON listings');
    await database.query('DROP FUNCTION t09_fail_publish()');
    const retried = await new PublicationRepository(database, 30).publishNext();
    assert.equal(retried.kind, 'published');
    if (retried.kind !== 'published') throw new Error('Expected publication retry to succeed');
    assert.equal(retried.listing.id, id);
  });
});

test('publication ignores every non-auto-approved lifecycle status', async () => {
  await withDatabase(async database => {
    const statuses = [
      ['pending', null], ['needs_human', 'escalated'], ['auto_rejected', 'rejected'],
      ['published', 'approved'], ['rejected', 'rejected'], ['expired', 'approved'],
    ] as const;
    const submissions = new SubmissionRepository(database);
    const ids: string[] = [];
    for (const [status, outcome] of statuses) {
      const created = await submissions.submit({ sellerId: 's-1002', categoryId: 'c-phones',
        title: `T09 noneligible ${status}`, description: 'clean item', priceVnd: 6000000n });
      ids.push(created.id);
      if (status !== 'pending') await database.query(
        `UPDATE listings SET status=$2,decision=jsonb_build_object('outcome',$3::text,'reasons','[]'::jsonb),
          decided_at=clock_timestamp(),published_at=CASE WHEN $2 IN ('published','expired') THEN clock_timestamp() END,
          expires_at=CASE WHEN $2='expired' THEN clock_timestamp() END WHERE id=$1`, [created.id, status, outcome]);
    }
    const before = await database.query(
      'SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=ANY($1::text[]) ORDER BY id', [ids]);
    assert.deepEqual(await new PublicationRepository(database, 30).publishNext(), { kind: 'idle' });
    const after = await database.query(
      'SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=ANY($1::text[]) ORDER BY id', [ids]);
    assert.deepEqual(after.rows, before.rows);
  });
});

test('publication rejects a schema-valid but semantically corrupt auto_approved decision without repair', async () => {
  await withDatabase(async database => {
    const id = await createAutoApproved(database, 'T09 corrupt publication decision');
    const snapshot = () => database.query(
      `SELECT status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,normalized_fingerprint,version::text AS version FROM listings WHERE id=$1`, [id]);
    for (const corrupt of [
      `UPDATE listings SET decision=jsonb_build_object('outcome','escalated','reasons','[]'::jsonb) WHERE id=$1`,
      `UPDATE listings SET published_at=clock_timestamp() WHERE id=$1`,
    ]) {
      await database.query(corrupt, [id]);
      const before = await snapshot();
      await assert.rejects(new PublicationRepository(database, 30).publishNext(), error => {
        assert.ok(error instanceof PublicationFailure);
        assert.equal(error.listingId, id);
        assert.match(String(error.cause), /T09 auto_approved listing has inconsistent decision or publication timestamps/);
        return true;
      });
      assert.deepEqual((await snapshot()).rows, before.rows);
      await database.query(`UPDATE listings SET decision=jsonb_build_object('outcome','approved','reasons','[]'::jsonb),
        published_at=NULL,expires_at=NULL WHERE id=$1`, [id]);
    }
  });
});

test('concurrent publication repository transactions publish a single candidate at most once', async () => {
  await withDatabase(async database => {
    const id = await createAutoApproved(database, 'T09 concurrent publication');
    const left = new PublicationRepository(database, 30);
    const right = new PublicationRepository(database, 30);
    const results = await Promise.all([left.publishNext(), right.publishNext()]);
    assert.equal(results.filter(result => result.kind === 'published').length, 1);
    assert.equal(results.filter(result => result.kind === 'idle').length, 1);
    const state = (await database.query<{ status: string; history_count: number; version: string }>(
      `SELECT status,(SELECT count(*)::int FROM moderation_history WHERE listing_id=$1) AS history_count,version::text AS version
       FROM listings WHERE id=$1`, [id])).rows[0];
    assert.deepEqual(state, { status: 'published', history_count: 1, version: '2' });
  });
});
