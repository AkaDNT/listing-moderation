import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLosslessNumber } from 'lossless-json';
import { Pool } from 'pg';
import { createApi } from '../src/api';
import { parseJson } from '../src/http/json-codec';
import { ExpiryRepository } from '../src/lifecycle/expiry.repository';
import { PublicationRepository } from '../src/lifecycle/publication.repository';
import { scope, until } from './helpers/t08';

async function expirySnapshot(observer: Pool, id: string): Promise<{
  listing: Record<string, unknown>;
  job: Record<string, unknown>;
  history: Record<string, unknown>[];
}> {
  const listing = (await observer.query(
    `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,decision::text AS decision,
      decided_at::text AS decided_at,published_at::text AS published_at,expires_at::text AS expires_at,
      normalized_fingerprint,version::text AS version,created_at::text AS created_at FROM listings WHERE id=$1`, [id])).rows[0];
  const job = (await observer.query(
    `SELECT id,listing_id,state,attempts,available_at::text AS available_at,lease_until::text AS lease_until,
      claim_token::text AS claim_token,last_error,completed_at::text AS completed_at,created_at::text AS created_at
     FROM moderation_jobs WHERE listing_id=$1`, [id])).rows[0];
  const history = (await observer.query(
    `SELECT id::text AS id,listing_id,phase,decision::text AS decision,moderator_id,note,decided_at::text AS decided_at
     FROM moderation_history WHERE listing_id=$1 ORDER BY id`, [id])).rows;
  assert.ok(listing, 'T10 snapshot requires the persisted listing');
  assert.ok(job, 'T10 snapshot requires the persisted job');
  return { listing, job, history };
}

test('actual GET maps expired status and serializes preserved decision, date and int64 through production wiring', { timeout: 12000 }, async () => {
  await scope(async s => {
    // The large exact int64 intentionally trips R2 for ordinary sellers; use the trusted
    // seller so the production moderation path reaches auto_approved and publication.
    const id = await s.add('T10 actual expired GET', 's-1005', 9007199254740993n);
    const claim = await s.claim();
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    assert.equal((await new PublicationRepository(s.database, 30).publishNext()).kind, 'published');
    const before = (await s.observer.query<{ decided_at: Date; decision: string }>(
      'SELECT decided_at,decision::text AS decision FROM listings WHERE id=$1', [id])).rows[0];
    await s.database.query("UPDATE listings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const worker = await s.child('10');
    await until(async () => (await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [id])).rows[0], row => row.status === 'expired');

    const app = await createApi({ DATABASE_URL: s.url, POLL_INTERVAL_MS: '1000' });
    try {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/listings/${id}`, { headers: { connection: 'close' } });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /"price_vnd":9007199254740993/);
      const body = parseJson(text) as Record<string, unknown>;
      assert.equal(body.status, 'expired');
      assert.ok(isLosslessNumber(body.price_vnd));
      assert.equal(body.price_vnd.toString(), '9007199254740993');
      assert.equal(body.decided_at, before.decided_at.toISOString());
      assert.deepEqual(body.decision, parseJson(before.decision));
      const list = await fetch(`http://127.0.0.1:${address.port}/v1/listings?status=expired`, { headers: { connection: 'close' } });
      assert.equal(list.status, 200);
      const listed = parseJson(await list.text()) as { items: Array<{ id: string; status: string }> };
      assert.ok(listed.items.some(item => item.id === id && item.status === 'expired'));
    } finally { await app.close(); }
    assert.ok(worker.process.exitCode === null);
  });
});

test('actual human approval uses default and override TTL; expiry preserves exact listing, job and both history phases', { timeout: 18000 }, async () => {
  await scope(async s => {
    const id = await s.add('T10 human expiry exact snapshot', 's-1004');
    const claim = await s.claim();
    assert.equal((await s.jobs.processClaim(claim)).kind, 'completed');
    assert.deepEqual((await s.observer.query<{ status: string }>(
      'SELECT status FROM listings WHERE id=$1', [id])).rows[0], { status: 'needs_human' });

    const app = await createApi({ DATABASE_URL: s.url, POLL_INTERVAL_MS: '10' });
    try {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const approval = await fetch(`${base}/v1/listings/${id}/decision`, {
        method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', moderator_id: 't10-moderator', note: 'keep this exact note' }),
      });
      assert.equal(approval.status, 200);
      const approved = parseJson(await approval.text()) as { status: string };
      assert.equal(approved.status, 'published');

      const defaultTtl = (await s.observer.query<{ seconds: string }>(
        'SELECT EXTRACT(EPOCH FROM expires_at-published_at)::text AS seconds FROM listings WHERE id=$1', [id])).rows[0];
      assert.equal(Number(defaultTtl.seconds), 30 * 86400);
      await s.database.query("UPDATE listings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      const before = await expirySnapshot(s.observer, id);
      assert.deepEqual(before.history.map(row => row.phase), ['auto', 'human']);
      assert.equal(before.history[1].moderator_id, 't10-moderator');
      assert.equal(before.history[1].note, 'keep this exact note');

      assert.deepEqual(await new ExpiryRepository(s.database).expireBatch(), [id]);
      const after = await expirySnapshot(s.observer, id);
      const { status: beforeStatus, version: beforeVersion, ...beforeListing } = before.listing;
      const { status: afterStatus, version: afterVersion, ...afterListing } = after.listing;
      assert.equal(beforeStatus, 'published');
      assert.equal(afterStatus, 'expired');
      assert.equal(BigInt(String(afterVersion)), BigInt(String(beforeVersion)) + 1n);
      assert.deepEqual(afterListing, beforeListing);
      assert.deepEqual(after.job, before.job);
      assert.deepEqual(after.history, before.history);

      const one = await fetch(`${base}/v1/listings/${id}`, { headers: { connection: 'close' } });
      assert.equal(one.status, 200);
      const oneBody = parseJson(await one.text()) as { status: string; decision: unknown; decided_at: string };
      assert.equal(oneBody.status, 'expired');
      assert.deepEqual(oneBody.decision, parseJson(String(before.listing.decision)));
      assert.equal(oneBody.decided_at, new Date(String(before.listing.decided_at)).toISOString());
      const expiredList = parseJson(await (await fetch(`${base}/v1/listings?status=expired`, { headers: { connection: 'close' } })).text()) as {
        items: Array<{ id: string; status: string }>;
      };
      assert.ok(expiredList.items.some(item => item.id === id && item.status === 'expired'));
      const publishedList = parseJson(await (await fetch(`${base}/v1/listings?status=published`, { headers: { connection: 'close' } })).text()) as {
        items: Array<{ id: string }>;
      };
      assert.equal(publishedList.items.some(item => item.id === id), false);
      const retry = await fetch(`${base}/v1/listings/${id}/decision`, {
        method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', moderator_id: 'later-moderator' }),
      });
      assert.equal(retry.status, 409);
      assert.deepEqual(await expirySnapshot(s.observer, id), after);
    } finally { await app.close(); }

    const overrideId = await s.add('T10 human expiry explicit TTL override', 's-1004');
    const overrideClaim = await s.claim();
    assert.equal((await s.jobs.processClaim(overrideClaim)).kind, 'completed');
    const overrideApp = await createApi({ DATABASE_URL: s.url, POLL_INTERVAL_MS: '10', LISTING_TTL_DAYS: '2' });
    try {
      await overrideApp.listen(0, '127.0.0.1');
      const address = overrideApp.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/listings/${overrideId}/decision`, {
        method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', moderator_id: 't10-override-moderator' }),
      });
      assert.equal(response.status, 200);
      const ttl = (await s.observer.query<{ seconds: string }>(
        'SELECT EXTRACT(EPOCH FROM expires_at-published_at)::text AS seconds FROM listings WHERE id=$1', [overrideId])).rows[0];
      assert.equal(Number(ttl.seconds), 2 * 86400);
    } finally { await overrideApp.close(); }
  });
});
