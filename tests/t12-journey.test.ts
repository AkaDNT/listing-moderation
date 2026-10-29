import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLosslessNumber, parse } from 'lossless-json';
import { createApi } from '../src/api';
import { scope, until } from './helpers/t08';

interface Listing {
  id: string; status: string; price_vnd: unknown; created_at: string; decided_at: string | null;
  decision: null | { outcome: string; reasons: Array<{ rule_id: string; message: string }> };
}

test('T12 public POST pending to compiled worker, human approval and expiry preserves exact phases and int64', { timeout: 30000 }, async () => {
  await scope(async s => {
    const app = await createApi({ DATABASE_URL: s.url, POLL_INTERVAL_MS: '10' });
    s.defer(() => app.close());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    async function request(path: string, method = 'GET', body?: string, key?: string) {
      const response = await fetch(base + path, {
        method, body, signal: AbortSignal.timeout(5000),
        headers: { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === undefined ? {} : { 'idempotency-key': key }) },
      });
      const text = await response.text();
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
      return { status: response.status, text, value: parse(text) };
    }
    async function get(id: string): Promise<Listing> {
      const response = await request('/v1/listings/' + id);
      assert.equal(response.status, 200);
      const value = response.value as Listing;
      assert.equal(value.id, id);
      assert.ok(isLosslessNumber(value.price_vnd));
      assert.match(value.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(Number.isFinite(Date.parse(value.created_at)));
      assert.deepEqual(Object.keys(value).sort(), [
        'id', 'seller_id', 'category_id', 'title', 'description', 'price_vnd', 'status', 'created_at', 'decided_at', 'decision',
      ].sort());
      return value;
    }
    const cases = [
      { seller: 's-1005', title: 'T12 trusted unsafe price', price: '9007199254740993', status: 'published', rules: ['R4'] },
      { seller: 's-1005', title: 'T12 trusted maximum price', price: '9223372036854775807', status: 'published', rules: ['R4'] },
      { seller: 's-1001', title: 'T12 replica phone', price: '6000000', status: 'auto_rejected', rules: ['R1'] },
      { seller: 's-1004', title: 'T12 human journey', price: '6000000', status: 'needs_human', rules: ['R5'] },
    ];
    const ids: string[] = [];
    // No worker exists yet, so pending is observed without a race against moderation.
    for (const [index, item] of cases.entries()) {
      const body = `{"seller_id":"${item.seller}","title":${JSON.stringify(item.title)},"description":"ordinary item","price_vnd":${item.price},"category_id":"c-phones"}`;
      const response = await request('/v1/listings', 'POST', body, `t12-journey-${index}`);
      assert.equal(response.status, 202);
      const accepted = response.value as { id: string; status: string };
      assert.equal(accepted.status, 'pending');
      ids.push(accepted.id);
      const pending = await get(accepted.id);
      assert.equal(pending.status, 'pending');
      assert.equal(pending.decision, null);
      assert.equal(pending.decided_at, null);
      assert.equal(String(pending.price_vnd), item.price);
      const persisted = (await s.observer.query(
        `SELECT l.status,l.price_vnd::text AS price,j.state,j.attempts,
          (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [accepted.id])).rows[0];
      assert.deepEqual(persisted, { status: 'pending', price: item.price, state: 'queued', attempts: 0, history_count: 0 });
      const replay = await request('/v1/listings', 'POST', body, `t12-journey-${index}`);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.value, response.value);
    }
    const worker = await s.child('10');
    for (const [index, item] of cases.entries()) {
      const listing = await until(() => get(ids[index]), value => value.status === item.status, 10000);
      assert.deepEqual(listing.decision!.reasons.map(reason => reason.rule_id), item.rules);
      assert.ok(listing.decided_at && Number.isFinite(Date.parse(listing.decided_at)));
      const response = await request('/v1/listings/' + ids[index]);
      assert.ok(response.text.includes('"price_vnd":' + item.price), 'exact unquoted JSON price token');
      const persisted = (await s.observer.query(
        `SELECT l.price_vnd::text AS price,l.version::text AS version,j.state,j.attempts,
          (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id AND phase='auto') AS auto_count
         FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [ids[index]])).rows[0];
      assert.deepEqual(persisted, { price: item.price, version: item.status === 'published' ? '2' : '1',
        state: 'completed', attempts: 1, auto_count: 1 });
    }
    assert.match((await get(ids[2])).decision!.reasons[0].message, /replica/i);
    const publishedList = await request('/v1/listings?seller_id=s-1005&status=published');
    assert.equal(publishedList.status, 200);
    assert.deepEqual((publishedList.value as { items: Listing[] }).items.map(item => item.id).sort(), ids.slice(0, 2).sort());
    for (const item of cases.slice(0, 2)) assert.ok(publishedList.text.includes('"price_vnd":' + item.price));
    const humanId = ids[3];
    const histories = () => s.observer.query(
      `SELECT phase,decision::text AS decision,decided_at::text AS decided_at,moderator_id,note
       FROM moderation_history WHERE listing_id=$1 ORDER BY id`, [humanId]);
    const autoHistoryBefore = (await histories()).rows;
    const approval = await request(`/v1/listings/${humanId}/decision`, 'POST',
      JSON.stringify({ decision: 'approve', moderator_id: 't12-reviewer', note: 't12-private-review-note' }));
    assert.equal(approval.status, 200);
    const approved = approval.value as Listing;
    assert.equal(approved.status, 'published');
    assert.equal(approved.decision!.outcome, 'approved');
    assert.deepEqual(approved.decision!.reasons, [{ rule_id: 'HUMAN', message: 'Approved by human moderator' }]);
    assert.ok(!approval.text.includes('t12-private-review-note'));
    const historyBefore = (await histories()).rows;
    assert.deepEqual(historyBefore.map(row => row.phase), ['auto', 'human']);
    assert.equal(historyBefore[1].moderator_id, 't12-reviewer');
    assert.equal(historyBefore[1].note, 't12-private-review-note');
    assert.deepEqual(historyBefore[0], autoHistoryBefore[0]);
    const ttl = (await s.observer.query(
      'SELECT EXTRACT(EPOCH FROM expires_at-published_at)::text AS seconds FROM listings WHERE id=$1', [humanId])).rows[0];
    assert.equal(Number(ttl.seconds), 30 * 86400);
    // Only the deadline is advanced by fixture SQL; lifecycle processing stays in the compiled worker.
    await s.observer.query("UPDATE listings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [humanId]);
    const expired = await until(() => get(humanId), value => value.status === 'expired', 10000);
    assert.deepEqual(expired, { ...approved, status: 'expired' });
    assert.deepEqual((await histories()).rows, historyBefore);
    const final = (await s.observer.query(
      `SELECT l.version::text AS version,j.state,j.attempts FROM listings l
       JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [humanId])).rows[0];
    assert.deepEqual(final, { version: '3', state: 'completed', attempts: 1 });
    const listing = await request('/v1/listings?seller_id=s-1004&status=expired');
    assert.equal(listing.status, 200);
    assert.deepEqual((listing.value as { items: Listing[] }).items, [expired]);
    const beforeRetry = await s.snapshot(humanId);
    assert.equal((await request(`/v1/listings/${humanId}/decision`, 'POST',
      '{"decision":"reject","moderator_id":"late-reviewer"}')).status, 409);
    assert.deepEqual(await s.snapshot(humanId), beforeRetry);
    assert.equal(worker.process.exitCode, null);
  });
});
