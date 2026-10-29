import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApi } from '../src/api';
import { createTestDatabase } from './helpers/postgres';

test('T11 actual POST returns safe 500 on deferred COMMIT failure and same-key retry creates exactly once',
  { timeout: 20000 }, async () => {
    const fixture = await createTestDatabase();
    let app: Awaited<ReturnType<typeof createApi>> | undefined;
    const observer = new Pool({ connectionString: fixture.url, application_name: 't11-http-observer' });
    try {
      app = await createApi({ DATABASE_URL: fixture.url, POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' });
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}`;
      const raw = '{"seller_id":"s-1001","category_id":"c-phones","title":"T11 commit fault candidate","description":"clean","price_vnd":9007199254740993}';
      const key = 't11-definite-commit-failure';
      const counts = async () => (await observer.query(`SELECT
        (SELECT count(*)::text FROM listings) AS listings,
        (SELECT count(*)::text FROM submission_keys) AS keys,
        (SELECT count(*)::text FROM moderation_jobs) AS jobs,
        (SELECT count(*)::text FROM moderation_history) AS history`)).rows[0];
      const before = await counts();

      await observer.query(`CREATE FUNCTION t11_fail_submission_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='t11-commit-private-sentinel'; END $$`);
      await observer.query(`CREATE CONSTRAINT TRIGGER t11_submission_commit_fault
        AFTER INSERT ON moderation_jobs DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION t11_fail_submission_commit()`);

      const post = (body: string) => fetch(url + '/v1/listings', {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key, connection: 'close' },
        body, signal: AbortSignal.timeout(5000),
      });
      const failed = await post(raw);
      const failedBody = await failed.text();
      assert.equal(failed.status, 500);
      assert.match(failed.headers.get('content-type') ?? '', /^application\/json\b/);
      assert.equal(failedBody, '{"error":{"code":"internal_error","message":"Internal server error"}}');
      assert.doesNotMatch(failedBody, /t11-commit-private-sentinel|P0001|moderator|password|9007199254740993/);
      assert.deepEqual(await counts(), before, 'observer connection must see no rows after failed COMMIT');
      assert.equal((await observer.query('SELECT count(*)::int AS n FROM submission_keys WHERE key=$1', [key])).rows[0].n, 0);

      await observer.query('DROP TRIGGER t11_submission_commit_fault ON moderation_jobs');
      await observer.query('DROP FUNCTION t11_fail_submission_commit()');
      const retried = await post(raw);
      assert.equal(retried.status, 202);
      const created = await retried.json() as { id: string; status: string };
      assert.equal(created.status, 'pending');
      const price = await observer.query<{ price_vnd: string }>('SELECT price_vnd::text FROM listings WHERE id=$1', [created.id]);
      assert.deepEqual(price.rows, [{ price_vnd: '9007199254740993' }]);
      const afterCreate = await counts();
      assert.deepEqual(afterCreate, {
        listings: String(BigInt(before.listings) + 1n), keys: String(BigInt(before.keys) + 1n),
        jobs: String(BigInt(before.jobs) + 1n), history: before.history,
      });
      const replay = await post(raw);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), created);
      assert.deepEqual(await counts(), afterCreate);
    } finally {
      if (app) await app.close();
      await observer.end();
      await fixture.dispose();
    }
  });
