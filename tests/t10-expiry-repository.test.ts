import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { ExpiryRepository } from '../src/lifecycle/expiry.repository';
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
    throw new AggregateError(errors, `T10 expiry PostgreSQL/cleanup failed: ${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`, { cause: primary });
  }
}

async function insertPublished(database: Database, count: number, prefix: string): Promise<string[]> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,
       published_at,expires_at,normalized_fingerprint,version,created_at)
     SELECT $1||lpad(n::text,4,'0'),'s-1002','c-phones','T10 expiry '||n,'fixture',6000000,'published',
       '{"outcome":"approved","reasons":[]}'::jsonb,now()-interval '3 days',now()-interval '2 days',
       now()-interval '1 second','fixture-'||n,2,now()-interval '2 days'
     FROM generate_series(1,$2::int) n RETURNING id`, [prefix, count]);
  const ids = result.rows.map(row => row.id);
  await database.query(
    `INSERT INTO moderation_jobs(id,listing_id,state,attempts,completed_at)
     SELECT 'job-'||id,id,'completed',1,now()-interval '2 days' FROM listings WHERE id=ANY($1::text[])`, [ids]);
  await database.query(
    `INSERT INTO moderation_history(listing_id,phase,decision,decided_at)
     SELECT id,'auto',decision,decided_at FROM listings WHERE id=ANY($1::text[])`, [ids]);
  return ids;
}

test('expiry uses PostgreSQL cutoff at before/equal/after and changes only due published lifecycle state', async () => {
  await withDatabase(async database => {
    const [beforeId, equalId, afterId] = await insertPublished(database, 3, 't10-boundary-');
    await database.transaction(async client => {
      await client.query(`UPDATE listings SET expires_at=CASE id
        WHEN $1 THEN now()-interval '1 microsecond'
        WHEN $2 THEN now()
        ELSE now()+interval '1 microsecond' END WHERE id=ANY($3::text[])`,
      [beforeId, equalId, [beforeId, equalId, afterId]]);
      const listingBefore = await client.query<{ id: string; status: string; version: string } & Record<string, unknown>>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,
          decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
          expires_at::text AS expires_at,normalized_fingerprint,version::text AS version,created_at::text AS created_at
         FROM listings WHERE id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      const jobsBefore = await client.query<{ id: string } & Record<string, unknown>>(
        `SELECT id,listing_id,state,attempts,available_at::text AS available_at,lease_until::text AS lease_until,
          claim_token::text AS claim_token,last_error,completed_at::text AS completed_at,created_at::text AS created_at
         FROM moderation_jobs WHERE listing_id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      const historyBefore = await client.query<{ id: string } & Record<string, unknown>>(
        `SELECT id::text AS id,listing_id,phase,decision::text AS decision,moderator_id,note,decided_at::text AS decided_at
         FROM moderation_history WHERE listing_id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      const changed = await new ExpiryRepository(database).expireDueInTransaction(client);
      assert.deepEqual(changed.sort(), [beforeId, equalId].sort());
      assert.deepEqual(await new ExpiryRepository(database).expireDueInTransaction(client), []);
      const listingAfter = await client.query<{ id: string; status: string; version: string } & Record<string, unknown>>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,
          decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
          expires_at::text AS expires_at,normalized_fingerprint,version::text AS version,created_at::text AS created_at
         FROM listings WHERE id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      for (const row of listingAfter.rows) {
        const prior = listingBefore.rows.find(candidate => candidate.id === row.id)!;
        const { status: afterStatus, version: afterVersion, ...afterPreserved } = row;
        const { status: beforeStatus, version: beforeVersion, ...beforePreserved } = prior;
        assert.deepEqual(afterPreserved, beforePreserved, `${row.id} listing fields outside status/version must be exact`);
        assert.equal(afterStatus, row.id === afterId ? beforeStatus : 'expired');
        assert.equal(afterVersion, row.id === afterId ? beforeVersion : (BigInt(beforeVersion) + 1n).toString());
      }
      const jobsAfter = await client.query<{ id: string } & Record<string, unknown>>(
        `SELECT id,listing_id,state,attempts,available_at::text AS available_at,lease_until::text AS lease_until,
          claim_token::text AS claim_token,last_error,completed_at::text AS completed_at,created_at::text AS created_at
         FROM moderation_jobs WHERE listing_id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      const historyAfter = await client.query<{ id: string } & Record<string, unknown>>(
        `SELECT id::text AS id,listing_id,phase,decision::text AS decision,moderator_id,note,decided_at::text AS decided_at
         FROM moderation_history WHERE listing_id=ANY($1::text[]) ORDER BY id`, [[beforeId, equalId, afterId]]);
      assert.deepEqual(jobsAfter.rows, jobsBefore.rows, 'expiry must preserve every job field');
      assert.deepEqual(historyAfter.rows, historyBefore.rows, 'expiry must preserve every auto history field');
    });
  });
});

test('expiry batch is bounded to 100, catches remaining overdue rows and is idempotent', async () => {
  await withDatabase(async database => {
    await insertPublished(database, 205, 't10-batch-');
    const repository = new ExpiryRepository(database);
    const batches = [await repository.expireBatch(), await repository.expireBatch(), await repository.expireBatch()];
    assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
    assert.equal(new Set(batches.flat()).size, 205);
    assert.deepEqual(await repository.expireBatch(), []);
    const state = await database.query<{ expired: number; published: number; version: string }>(
      `SELECT count(*) FILTER (WHERE status='expired')::int AS expired,
       count(*) FILTER (WHERE status='published')::int AS published,min(version)::text AS version
       FROM listings WHERE id LIKE 't10-batch-%'`);
    assert.deepEqual(state.rows[0], { expired: 205, published: 0, version: '3' });
  });
});

test('concurrent expiry transactions transition every due row exactly once', async () => {
  await withDatabase(async database => {
    const ids = await insertPublished(database, 205, 't10-concurrent-');
    const repository = new ExpiryRepository(database);
    const results = await Promise.all([repository.expireBatch(), repository.expireBatch(), repository.expireBatch()]);
    assert.equal(results.flat().length, 205);
    assert.equal(new Set(results.flat()).size, 205);
    assert.ok(results.every(batch => batch.length <= 100));
    const rows = await database.query<{ status: string; version: string }>(
      'SELECT status,version::text AS version FROM listings WHERE id=ANY($1::text[])', [ids]);
    assert.equal(rows.rows.length, 205);
    assert.ok(rows.rows.every(row => row.status === 'expired' && row.version === '3'));
  });
});

test('expiry leaves every nonpublished status and a published row without deadline unchanged', async () => {
  await withDatabase(async database => {
    const statuses = ['pending', 'needs_human', 'auto_rejected', 'auto_approved', 'rejected', 'expired'] as const;
    const ids: string[] = [];
    for (const status of statuses) {
      const decision = status === 'pending' ? null : JSON.stringify({
        outcome: status === 'needs_human' ? 'escalated' : status === 'auto_rejected' || status === 'rejected' ? 'rejected' : 'approved',
        reasons: [],
      });
      const row = await database.query<{ id: string }>(
        `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,published_at,expires_at,version)
         VALUES($1,'s-1002','c-phones',$1,'fixture',6000000,$2,$3::jsonb,
          CASE WHEN $2='pending' THEN NULL ELSE now()-interval '2 days' END,
          CASE WHEN $2 IN ('published','expired') THEN now()-interval '1 day' END,
          now()-interval '1 second',1) RETURNING id`, [`t10-state-${status}`, status, decision]);
      ids.push(row.rows[0].id);
    }
    const noDeadline = await database.query<{ id: string }>(
      `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,published_at,expires_at,version)
       VALUES('t10-state-published-null','s-1002','c-phones','fixture','fixture',6000000,'published',
        '{"outcome":"approved","reasons":[]}'::jsonb,now()-interval '2 days',now()-interval '1 day',NULL,1) RETURNING id`);
    ids.push(noDeadline.rows[0].id);
    const due = await database.query<{ id: string }>(
      `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,published_at,expires_at,version)
       VALUES('t10-state-published-due','s-1002','c-phones','fixture due','fixture',6000000,'published',
        '{"outcome":"approved","reasons":[]}'::jsonb,now()-interval '2 days',now()-interval '1 day',now()-interval '1 second',1)
       RETURNING id`);
    ids.push(due.rows[0].id);
    const before = await database.query(
      `SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=ANY($1::text[]) ORDER BY id`, [ids]);
    assert.deepEqual((await new ExpiryRepository(database).expireBatch()).sort(), ['t10-state-published-due']);
    const after = await database.query(
      `SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=ANY($1::text[]) ORDER BY id`, [ids]);
    assert.equal(after.rows.find(row => row.id === 't10-state-published-due')?.status, 'expired');
    assert.deepEqual(after.rows.filter(row => row.id !== 't10-state-published-due'), before.rows.filter(row => row.id !== 't10-state-published-due'));
  });
});

test('expiry update failure rolls back every row in a batch and can retry after repair', async () => {
  await withDatabase(async database => {
    const ids = await insertPublished(database, 2, 't10-rollback-');
    await database.query(`CREATE FUNCTION t10_fail_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='expired' AND NEW.id LIKE 't10-rollback-%' THEN RAISE EXCEPTION 'forced expiry failure'; END IF; RETURN NEW; END $$`);
    await database.query(`CREATE TRIGGER t10_fail_expiry BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION t10_fail_expiry()`);
    const before = await database.query(
      'SELECT id,status,version::text AS version,decision::text AS decision,decided_at::text AS decided_at FROM listings WHERE id=ANY($1::text[]) ORDER BY id', [ids]);
    await assert.rejects(new ExpiryRepository(database).expireBatch(), /forced expiry failure/);
    assert.deepEqual((await database.query(
      'SELECT id,status,version::text AS version,decision::text AS decision,decided_at::text AS decided_at FROM listings WHERE id=ANY($1::text[]) ORDER BY id', [ids])).rows,
    before.rows);
    await database.query('DROP TRIGGER t10_fail_expiry ON listings');
    await database.query('DROP FUNCTION t10_fail_expiry()');
    assert.equal((await new ExpiryRepository(database).expireBatch()).length, 2);
  });
});
