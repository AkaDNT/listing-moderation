import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

test('listing, submission key and initial job commit together or leave no rows', async () => {
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  try {
    await assert.rejects(database.transaction(async (client) => {
      await client.query("INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('atomic-listing','s-1001','c-phones','Atomic','',0)");
      await client.query("INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('atomic-key','hash','atomic-listing')");
      await client.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('atomic-job','atomic-listing')");
      throw new Error('failure-after-job');
    }), /failure-after-job/);
    const rolledBack = await database.query<{ listings: string; keys: string; jobs: string }>(
      `SELECT (SELECT count(*)::text FROM listings WHERE id='atomic-listing') AS listings,
              (SELECT count(*)::text FROM submission_keys WHERE key='atomic-key') AS keys,
              (SELECT count(*)::text FROM moderation_jobs WHERE id='atomic-job') AS jobs`,
    );
    assert.deepEqual(rolledBack.rows[0], { listings: '0', keys: '0', jobs: '0' });

    await database.transaction(async (client) => {
      await client.query("INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('atomic-listing','s-1001','c-phones','Atomic','',0)");
      await client.query("INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('atomic-key','hash','atomic-listing')");
      await client.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('atomic-job','atomic-listing')");
    });
    const committed = await database.query<{ listings: string; keys: string; jobs: string }>(
      `SELECT (SELECT count(*)::text FROM listings WHERE id='atomic-listing') AS listings,
              (SELECT count(*)::text FROM submission_keys WHERE key='atomic-key') AS keys,
              (SELECT count(*)::text FROM moderation_jobs WHERE id='atomic-job') AS jobs`,
    );
    assert.deepEqual(committed.rows[0], { listings: '1', keys: '1', jobs: '1' });
  } finally {
    await database.close();
    await fixture.dispose();
  }
});

test('automated result, phase history and job completion commit as one transaction', async () => {
  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  const decision = { outcome: 'approved', reasons: [] };
  try {
    await database.query("INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('result-listing','s-1001','c-phones','Result','',0)");
    await database.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('result-job','result-listing')");
    const applyResult = async (client: import('pg').PoolClient) => {
      await client.query(
        "UPDATE listings SET status='auto_approved',decision=$1,decided_at='2026-01-01T00:00:00Z' WHERE id='result-listing'",
        [decision],
      );
      await client.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('result-listing','auto',$1)", [decision]);
      await client.query("UPDATE moderation_jobs SET state='completed',completed_at='2026-01-01T00:00:00Z' WHERE id='result-job'");
    };
    await assert.rejects(database.transaction(async (client) => {
      await applyResult(client);
      throw new Error('failure-after-result');
    }), /failure-after-result/);
    const rolledBack = await database.query<{ status: string; decision: null; history: string; job_state: string; completed_at: null }>(
      `SELECT l.status,l.decision,
              (SELECT count(*)::text FROM moderation_history h WHERE h.listing_id=l.id) AS history,
              j.state AS job_state,j.completed_at
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id='result-listing'`,
    );
    assert.deepEqual(rolledBack.rows[0], {
      status: 'pending', decision: null, history: '0', job_state: 'queued', completed_at: null,
    });

    await database.transaction(applyResult);
    const committed = await database.query<{ status: string; outcome: string; history: string; job_state: string; completed_at: Date | null }>(
      `SELECT l.status,l.decision->>'outcome' AS outcome,
              (SELECT count(*)::text FROM moderation_history h WHERE h.listing_id=l.id) AS history,
              j.state AS job_state,j.completed_at
       FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id='result-listing'`,
    );
    assert.equal(committed.rows[0].status, 'auto_approved');
    assert.equal(committed.rows[0].outcome, 'approved');
    assert.equal(committed.rows[0].history, '1');
    assert.equal(committed.rows[0].job_state, 'completed');
    assert.ok(committed.rows[0].completed_at instanceof Date);
  } finally {
    await database.close();
    await fixture.dispose();
  }
});
