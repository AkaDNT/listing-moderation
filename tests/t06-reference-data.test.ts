import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

interface ReferenceSnapshot {
  seller: { id: string; trustScore: number; verified: boolean };
  category: { id: string; medianPriceVnd: bigint };
  bannedKeywords: string[];
}
interface ReferenceDataModule {
  ReferenceDataRepository?: new (database: Database) => {
    load(sellerId: string, categoryId: string): Promise<ReferenceSnapshot | undefined>;
  };
}
interface PolicyModule {
  screenModeration?: (listing: unknown, references: unknown) => any;
  finalizeNormalModeration?: (screening: unknown, duplicate: unknown) => any;
}

function loadProductionModules() {
  let repository: ReferenceDataModule = {};
  let policy: PolicyModule = {};
  try { repository = require('../src/moderation/reference-data.repository') as ReferenceDataModule; } catch { /* asserted below */ }
  try { policy = require('../src/moderation/moderation-policy') as PolicyModule; } catch { /* asserted below */ }
  return { repository, policy };
}

async function withProductionDatabase<T>(work: (database: Database) => Promise<T>): Promise<T> {
  const fixture = await createTestDatabase();
  let database: Database | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  try {
    database = await Database.open(fixture.url, await loadBootstrapAssets());
    result = await work(database);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (database) {
    try { await database.close(); } catch (error) { cleanupErrors.push(error); }
  }
  try { await fixture.dispose(); } catch (error) { cleanupErrors.push(error); }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    const diagnostics = errors.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join('\n');
    throw new AggregateError(
      errors,
      `T06 PostgreSQL integration and cleanup failed:\n${diagnostics}`,
      { cause: primaryError },
    );
  }
  return result as T;
}

test('production reference repository reads persisted starter seeds and feeds the production evaluator', async () => {
  const { repository: repositoryModule, policy } = loadProductionModules();
  assert.equal(typeof repositoryModule.ReferenceDataRepository, 'function', 'production reference repository must be available');
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation policy must be available');
  assert.equal(typeof policy.finalizeNormalModeration, 'function', 'production moderation finalizer must be available');
  const assets = await loadBootstrapAssets();

  await withProductionDatabase(async database => {
    const repository = new repositoryModule.ReferenceDataRepository!(database);
    const before = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`,
    );

    for (const seller of assets.seeds.sellers) {
      for (const category of assets.seeds.categories) {
        const loaded = await repository.load(seller.id, category.id);
        assert.ok(loaded, `persisted snapshot missing for ${seller.id}/${category.id}`);
        assert.deepEqual(loaded.seller, { id: seller.id, trustScore: seller.trust_score, verified: seller.verified });
        assert.deepEqual(loaded.category, { id: category.id, medianPriceVnd: BigInt(category.median_price_vnd) });
        assert.deepEqual(loaded.bannedKeywords, [...assets.seeds.banned_keywords].sort());

        const banned = policy.screenModeration!({
          sellerId: seller.id, categoryId: category.id, title: 'REPLICA', description: '', priceVnd: 0n,
        }, loaded);
        assert.equal(banned.kind, 'terminal');
        assert.equal(banned.proposal.status, 'auto_rejected');
        assert.deepEqual(banned.proposal.decision.reasons.map((reason: any) => reason.rule_id), ['R1']);
        assert.ok(banned.proposal.decision.reasons[0].message.includes('replica'));

        const abnormal = policy.screenModeration!({
          sellerId: seller.id, categoryId: category.id, title: 'Ordinary listing', description: '', priceVnd: 0n,
        }, loaded);
        if (seller.trust_score >= 80) {
          assert.equal(abnormal.kind, 'terminal');
          assert.deepEqual(abnormal.proposal.decision.reasons.map((reason: any) => reason.rule_id), ['R4']);
        } else {
          assert.equal(abnormal.kind, 'requires_duplicate');
          const rejected = policy.finalizeNormalModeration!(abnormal, { kind: 'duplicate', listingId: 'explicit-t07-fact' });
          assert.equal(rejected.status, 'auto_rejected');
          assert.deepEqual(rejected.decision.reasons.map((reason: any) => reason.rule_id),
            seller.verified ? ['R2', 'R3'] : ['R2', 'R3', 'R5']);
        }

        const screening = policy.screenModeration!({
          sellerId: seller.id, categoryId: category.id, title: 'Ordinary listing', description: '',
          priceVnd: loaded.category.medianPriceVnd,
        }, loaded);
        if (screening.kind === 'requires_duplicate') {
          const proposal = policy.finalizeNormalModeration!(screening, { kind: 'clear' });
          assert.equal(proposal.status, seller.verified ? 'auto_approved' : 'needs_human');
          assert.equal(proposal.decision.outcome, seller.verified ? 'approved' : 'escalated');
          assert.deepEqual(proposal.decision.reasons.map((reason: any) => reason.rule_id), seller.verified ? [] : ['R5']);
        } else {
          assert.equal(screening.proposal.status, 'auto_approved');
          assert.equal(screening.proposal.decision.outcome, 'approved');
          assert.deepEqual(screening.proposal.decision.reasons.map((reason: any) => reason.rule_id), ['R4']);
        }
      }
    }

    assert.equal(await repository.load("s-1001' OR 1=1 --", 'c-phones'), undefined);
    assert.equal(await repository.load('s-1001', 'missing-category'), undefined);
    const after = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`,
    );
    assert.deepEqual(after.rows[0], before.rows[0], 'reference loading and pure evaluation must not write domain data');

    await database.query('INSERT INTO categories(id,name,median_price_vnd) VALUES($1,$2,$3::bigint)',
      ['t06-max-median', 'Exact median fixture', '9223372036854775807']);
    const exact = await repository.load('s-1007', 't06-max-median');
    assert.equal(exact?.category.medianPriceVnd, 9223372036854775807n);

    await database.query('DELETE FROM banned_keywords');
    await assert.rejects(repository.load('s-1007', 'c-phones'), /reference data is invalid/i);
  });
});
