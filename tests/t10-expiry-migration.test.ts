import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { PublicationRepository } from '../src/lifecycle/publication.repository';
import { SubmissionRepository } from '../src/submission/submission.repository';
import { ModerationJobRepository } from '../src/worker/moderation-job.repository';
import { createTestDatabase } from './helpers/postgres';

test('expiry index migration upgrades a populated 001 database without changing listing data', async () => {
  const fixture = await createTestDatabase();
  let oldDatabase: Database | undefined;
  let upgradedDatabase: Database | undefined;
  let failure: unknown;
  try {
    const assets = await loadBootstrapAssets();
    oldDatabase = await Database.open(fixture.url, { ...assets, migrations: assets.migrations.slice(0, 1) });
    const created = await new SubmissionRepository(oldDatabase).submit({ sellerId: 's-1002', categoryId: 'c-phones',
      title: 'T10 pre-migration published row', description: 'clean migration fixture', priceVnd: 6000000n });
    const jobs = new ModerationJobRepository(oldDatabase);
    const claim = await jobs.claimNext();
    assert.equal(claim.kind, 'claimed');
    if (claim.kind !== 'claimed') throw new Error('Expected a moderation claim');
    assert.equal((await jobs.processClaim(claim.claim)).kind, 'completed');
    assert.equal((await new PublicationRepository(oldDatabase, 30).publishNext()).kind, 'published');
    const before = await oldDatabase.query(
      `SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=$1`, [created.id]);
    await oldDatabase.close();
    oldDatabase = undefined;

    upgradedDatabase = await Database.open(fixture.url, await loadBootstrapAssets());
    const index = await upgradedDatabase.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='listings_published_expiry_idx'`);
    assert.equal(index.rowCount, 1, 'T10 expiry migration must install the partial deadline index');
    assert.match(index.rows[0].indexdef, /\(expires_at, id\)/);
    assert.match(index.rows[0].indexdef, /WHERE \(status = 'published'::text\)/i);
    const after = await upgradedDatabase.query(
      `SELECT id,status,decision::text AS decision,decided_at::text AS decided_at,published_at::text AS published_at,
       expires_at::text AS expires_at,version::text AS version FROM listings WHERE id=$1`, [created.id]);
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual((await upgradedDatabase.query('SELECT id FROM schema_migrations ORDER BY id')).rows,
      [{ id: '001_initial' }, { id: '002_listing_expiry' }]);
  } catch (error) { failure = error; }
  const cleanup: unknown[] = [];
  if (upgradedDatabase) try { await upgradedDatabase.close(); } catch (error) { cleanup.push(error); }
  if (oldDatabase) try { await oldDatabase.close(); } catch (error) { cleanup.push(error); }
  try { await fixture.dispose(); } catch (error) { cleanup.push(error); }
  if (failure !== undefined || cleanup.length) {
    const errors = [...(failure === undefined ? [] : [failure]), ...cleanup];
    throw new AggregateError(errors, `T10 migration integration/cleanup failed: ${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`, { cause: failure });
  }
});
