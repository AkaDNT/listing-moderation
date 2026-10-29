import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isLosslessNumber } from 'lossless-json';
import { test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { Database } from '../src/db/database';
import { DATABASE } from '../src/db/database.module';
import { loadBootstrapAssets } from '../src/db/assets';
import { createApi } from '../src/api';
import { parseJson } from '../src/http/json-codec';
import { SubmissionRepository } from '../src/submission/submission.repository';
import { ModerationJobRepository } from '../src/worker/moderation-job.repository';
import { createTestDatabase } from './helpers/postgres';

interface HttpFixture { app: INestApplication; database: Database; baseUrl: string; close(): Promise<void> }

async function withHttp(run: (fixture: HttpFixture) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  let app: INestApplication | undefined;
  let primary: unknown;
  try {
    app = await createApi({ DATABASE_URL: fixture.url, PORT: '8080', POLL_INTERVAL_MS: '10', LISTING_TTL_DAYS: '30' }, await loadBootstrapAssets());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('T09 actual API did not bind a TCP port');
    await run({ app, database: app.get(DATABASE), baseUrl: `http://127.0.0.1:${address.port}`, close: async () => app!.close() });
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (app) try { await app.close(); } catch (error) { cleanup.push(error); }
  try { await fixture.dispose(); } catch (error) { cleanup.push(error); }
  if (primary !== undefined || cleanup.length) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanup];
    throw new AggregateError(errors,
      `T09 actual HTTP/cleanup failed:\n${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`,
      { cause: primary });
  }
}

async function createEscalated(database: Database, overrides: { title?: string; price?: bigint } = {}): Promise<string> {
  const created = await new SubmissionRepository(database).submit({ sellerId: 's-1004', categoryId: 'c-phones',
    title: overrides.title ?? `T09 HTTP ${randomUUID()}`, description: 'ordinary item', priceVnd: overrides.price ?? 6000000n });
  const repository = new ModerationJobRepository(database);
  const claim = await repository.claimNext();
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') throw new Error('T09 actual HTTP fixture did not obtain job claim');
  assert.equal(claim.claim.listingId, created.id);
  assert.equal((await repository.processClaim(claim.claim)).kind, 'completed');
  return created.id;
}

const postDecision = (baseUrl: string, id: string, body: unknown) => fetch(`${baseUrl}/v1/listings/${encodeURIComponent(id)}/decision`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('actual API registration resolves human approval through production mapper, JSON codec and history transaction', async () => {
  await withHttp(async ({ baseUrl, database }) => {
    const id = await createEscalated(database);
    const before = (await database.query<{ decision: string; decided_at: Date }>(
      "SELECT decision::text AS decision,decided_at FROM moderation_history WHERE listing_id=$1 AND phase='auto'", [id])).rows[0];
    const response = await postDecision(baseUrl, id, { decision: 'approve', moderator_id: ' reviewer 🧑‍⚖️ ', note: '', extension: 'must disappear' });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const body = parseJson(raw) as Record<string, unknown>;
    assert.equal(body.status, 'published');
    assert.equal(Number(body.price_vnd), 6000000);
    assert.deepEqual(body.decision, { outcome: 'approved', reasons: [{ rule_id: 'HUMAN', message: 'Approved by human moderator' }] });
    assert.equal(raw.includes('reviewer'), false);
    assert.equal(raw.includes('must disappear'), false);
    assert.equal(Object.hasOwn(body, 'version'), false);
    assert.equal(Object.hasOwn(body, 'published_at'), false);
    const fields = Object.keys(body).sort();
    assert.deepEqual(fields, ['category_id', 'created_at', 'decided_at', 'decision', 'description', 'id', 'price_vnd', 'seller_id', 'status', 'title'].sort());
    const persisted = (await database.query<{ status: string; decision: string; decided_at: Date; published_at: Date;
      expires_at: Date; auto_decision: string; auto_at: Date; human_decision: string; human_at: Date; moderator_id: string; note: string | null;
      history_count: number; job: string; version: string }>(
      `SELECT l.status,l.decision::text AS decision,l.decided_at,l.published_at,l.expires_at,
       (SELECT decision::text FROM moderation_history WHERE listing_id=l.id AND phase='auto') AS auto_decision,
       (SELECT decided_at FROM moderation_history WHERE listing_id=l.id AND phase='auto') AS auto_at,
       (SELECT decision::text FROM moderation_history WHERE listing_id=l.id AND phase='human') AS human_decision,
       (SELECT decided_at FROM moderation_history WHERE listing_id=l.id AND phase='human') AS human_at,
       (SELECT moderator_id FROM moderation_history WHERE listing_id=l.id AND phase='human') AS moderator_id,
       (SELECT note FROM moderation_history WHERE listing_id=l.id AND phase='human') AS note,
       (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count,j.state AS job,l.version::text AS version
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0];
    assert.equal(persisted.status, 'published');
    assert.equal(persisted.version, '2');
    assert.equal(persisted.decided_at.toISOString(), persisted.published_at.toISOString());
    assert.equal(persisted.expires_at.getTime() - persisted.published_at.getTime(), 30 * 86400000);
    assert.equal(persisted.auto_decision, before.decision);
    assert.equal(persisted.auto_at.toISOString(), before.decided_at.toISOString());
    assert.equal(persisted.human_decision, persisted.decision);
    assert.equal(persisted.human_at.toISOString(), persisted.decided_at.toISOString());
    assert.equal(persisted.moderator_id, ' reviewer 🧑‍⚖️ ');
    assert.equal(persisted.note, '');
    assert.equal(persisted.history_count, 2);
    assert.equal(persisted.job, 'completed');

    const again = await postDecision(baseUrl, id, { decision: 'approve', moderator_id: 'reviewer', note: 'retry' });
    assert.equal(again.status, 409);
    const getOne = await fetch(`${baseUrl}/v1/listings/${encodeURIComponent(id)}`);
    assert.equal(getOne.status, 200);
    assert.equal((parseJson(await getOne.text()) as Record<string, unknown>).status, 'published');
  });
});

test('actual HTTP rejects malformed human input, missing IDs, all non-review statuses and later attempts with exact envelopes', async () => {
  await withHttp(async ({ baseUrl, database }) => {
    for (const body of [null, [], { decision: 'Approve', moderator_id: 'm' }, { decision: 'reject', moderator_id: 'm', note: null },
      { decision: 'approve', moderator_id: 'bad\u0000id' }, { decision: 'approve', moderator_id: '\uD800' }]) {
      const response = await postDecision(baseUrl, 'missing', body);
      assert.equal(response.status, 400);
      assert.equal((parseJson(await response.text()) as any).error.code, 'invalid_request');
    }
    const missing = await postDecision(baseUrl, 'no-such-listing', { decision: 'approve', moderator_id: 'm' });
    assert.equal(missing.status, 404);
    assert.deepEqual(parseJson(await missing.text()), { error: { code: 'not_found', message: 'Listing not found' } });

    const statuses = [
      ['pending', null], ['auto_approved', 'approved'], ['auto_rejected', 'rejected'],
      ['published', 'approved'], ['rejected', 'rejected'], ['expired', 'approved'],
    ] as const;
    const submissions = new SubmissionRepository(database);
    for (const [status, outcome] of statuses) {
      const created = await submissions.submit({ sellerId: 's-1002', categoryId: 'c-phones', title: `T09 ${status} ${randomUUID()}`,
        description: 'ordinary item', priceVnd: 6000000n });
      if (outcome) await database.query(
        `UPDATE listings SET status=$2,decision=jsonb_build_object('outcome',$3::text,'reasons','[]'::jsonb),decided_at=clock_timestamp(),
          published_at=CASE WHEN $2 IN ('published','expired') THEN clock_timestamp() END,
          expires_at=CASE WHEN $2='expired' THEN clock_timestamp() END WHERE id=$1`, [created.id, status, outcome]);
      const response = await postDecision(baseUrl, created.id, { decision: 'reject', moderator_id: 'm' });
      assert.equal(response.status, 409, status);
      assert.deepEqual(parseJson(await response.text()), { error: { code: 'conflict', message: 'Listing is not awaiting human review' } });
    }
  });
});

test('actual HTTP catches needs_human outcome corruption as safe 500 and does not mutate listing, history or job', async () => {
  await withHttp(async ({ baseUrl, database }) => {
    const id = await createEscalated(database);
    for (const outcome of ['approved', 'rejected']) {
      await database.query(`UPDATE listings SET decision=jsonb_build_object('outcome',$2::text,'reasons','[]'::jsonb) WHERE id=$1`, [id, outcome]);
      const before = await database.query(
        `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
          l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
          (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
           FROM moderation_history h WHERE h.listing_id=l.id) AS history
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
      const response = await postDecision(baseUrl, id, { decision: 'approve', moderator_id: 'sensitive-metadata' });
      assert.equal(response.status, 500);
      assert.deepEqual(parseJson(await response.text()), { error: { code: 'internal_error', message: 'Internal server error' } });
      const after = await database.query(
        `SELECT l.status,l.decision::text AS decision,l.decided_at::text AS decided_at,l.published_at::text AS published_at,
          l.expires_at::text AS expires_at,l.normalized_fingerprint,l.version::text AS version,j.state,j.attempts,
          (SELECT jsonb_agg(jsonb_build_object('phase',h.phase,'decision',h.decision,'at',h.decided_at) ORDER BY h.phase)
           FROM moderation_history h WHERE h.listing_id=l.id) AS history
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id]);
      assert.deepEqual(after.rows, before.rows);
    }
  });
});

test('actual HTTP races competing human actions: exactly one durable 200 and all other requests conflict', async () => {
  await withHttp(async ({ baseUrl, database }) => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const id = await createEscalated(database);
      const requests = Array.from({ length: 8 }, (_, index) => postDecision(baseUrl, id, {
        decision: index % 2 === 0 ? 'approve' : 'reject', moderator_id: `moderator-${iteration}-${index}`,
        note: `note-${iteration}-${index}`,
      }));
      const responses = await Promise.all(requests);
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      assert.equal(responses.filter(response => response.status === 409).length, 7);
      const winnerIndex = responses.findIndex(response => response.status === 200);
      const returned = parseJson(await responses[winnerIndex].text()) as Record<string, any>;
      const persisted = (await database.query<{ status: string; outcome: string; decision: string; moderator_id: string; note: string; history_count: number }>(
        `SELECT l.status,l.decision->>'outcome' AS outcome,l.decision::text AS decision,
          h.moderator_id,h.note,(SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
         FROM listings l JOIN moderation_history h ON h.listing_id=l.id AND h.phase='human' WHERE l.id=$1`, [id])).rows[0];
      assert.equal(returned.status, persisted.status);
      assert.equal(returned.decision.outcome, persisted.outcome);
      assert.equal(persisted.history_count, 2);
      const winnerBody = { decision: winnerIndex % 2 === 0 ? 'approve' : 'reject',
        moderator_id: `moderator-${iteration}-${winnerIndex}`, note: `note-${iteration}-${winnerIndex}` };
      assert.equal(persisted.moderator_id, winnerBody.moderator_id);
      assert.equal(persisted.note, winnerBody.note);
    }
  });
});

test('human decision response preserves unsafe and maximum int64 as raw JSON number tokens', async () => {
  await withHttp(async ({ baseUrl, database }) => {
    for (const price of [9007199254740993n, 9223372036854775807n]) {
      const id = await createEscalated(database, { price, title: `T09 int64 ${randomUUID()}` });
      const response = await postDecision(baseUrl, id, { decision: 'reject', moderator_id: 'm' });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.match(raw, new RegExp(`"price_vnd":${price}`));
      const body = parseJson(raw) as Record<string, unknown>;
      assert.equal(isLosslessNumber(body.price_vnd), true);
      assert.equal(BigInt(String(body.price_vnd)), price);
      assert.equal((await database.query('SELECT 1 FROM moderation_history WHERE listing_id=$1 AND phase=\'human\'', [id])).rowCount, 1);
    }
  });
});
