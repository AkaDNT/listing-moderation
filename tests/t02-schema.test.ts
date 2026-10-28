import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

const decision = { outcome: 'approved', reasons: [] };

async function databaseWithSchema() {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    const { migrations, seeds } = await loadBootstrapAssets();
    for (const migration of migrations) await pool.query(migration.sql);
    const seller = seeds.sellers[0];
    const category = seeds.categories[0];
    await pool.query('INSERT INTO sellers(id,name,trust_score,verified,note) VALUES($1,$2,$3,$4,$5)', [seller.id, seller.name, seller.trust_score, seller.verified, seller.note]);
    await pool.query('INSERT INTO categories(id,name,median_price_vnd) VALUES($1,$2,$3)', [category.id, category.name, String(category.median_price_vnd)]);
    return { database, pool };
  } catch (error) {
    await pool.end();
    await database.dispose();
    throw error;
  }
}

async function insertListing(pool: Pool, id: string, fields: Record<string, unknown> = {}) {
  const values = {
    seller_id: 's-1001', category_id: 'c-phones', title: `Listing ${id}`, description: '', price_vnd: '0',
    status: 'pending', decision: null, decided_at: null, normalized_fingerprint: null, ...fields,
  };
  return pool.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,normalized_fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, values.seller_id, values.category_id, values.title, values.description, values.price_vnd, values.status, values.decision, values.decided_at, values.normalized_fingerprint],
  );
}

test('initial migration creates all domain tables and enforces statuses, JSON shape and exact BIGINT bounds', async () => {
  const { database, pool } = await databaseWithSchema();
  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map(({ table_name }) => table_name), [
      'banned_keywords', 'categories', 'listings', 'moderation_history', 'moderation_jobs', 'sellers', 'submission_keys',
    ]);

    const outcomes = ['pending', 'auto_approved', 'auto_rejected', 'needs_human', 'published', 'rejected', 'expired'];
    for (const [index, status] of outcomes.entries()) {
      await insertListing(pool, `valid-${index}`, status === 'pending' ? {} : {
        status, decision, decided_at: '2026-01-01T00:00:00Z',
      });
    }
    await assert.rejects(insertListing(pool, 'bad-status', { status: 'draft' }), { code: '23514' });
    await assert.rejects(insertListing(pool, 'null-status', { status: null }), { code: '23502' });
    await assert.rejects(insertListing(pool, 'negative-price', { price_vnd: '-1' }), { code: '23514' });
    await assert.rejects(insertListing(pool, 'null-price', { price_vnd: null }), { code: '23502' });
    await assert.rejects(insertListing(pool, 'missing-decision', { status: 'auto_approved', decision: null, decided_at: null }), { code: '23514' });
    await assert.rejects(insertListing(pool, 'json-null-outcome', {
      status: 'auto_approved', decision: { outcome: null, reasons: [] }, decided_at: '2026-01-01T00:00:00Z',
    }), { code: '23514' });
    await assert.rejects(insertListing(pool, 'missing-reasons', {
      status: 'auto_approved', decision: { outcome: 'approved' }, decided_at: '2026-01-01T00:00:00Z',
    }), { code: '23514' });

    await insertListing(pool, 'exact-unsafe-js', { price_vnd: '9007199254740993' });
    await insertListing(pool, 'exact-max', { price_vnd: '9223372036854775807' });
    const exact = await pool.query<{ id: string; price: string }>(
      "SELECT id, price_vnd::text AS price FROM listings WHERE id IN ('exact-unsafe-js','exact-max') ORDER BY id",
    );
    assert.deepEqual(exact.rows, [
      { id: 'exact-max', price: '9223372036854775807' },
      { id: 'exact-unsafe-js', price: '9007199254740993' },
    ]);
    await assert.rejects(insertListing(pool, 'overflow-price', { price_vnd: '9223372036854775808' }), { code: '22003' });
  } finally {
    await pool.end();
    await database.dispose();
  }
});

test('initial migration enforces foreign keys, unique keys, one job and one history event per phase', async () => {
  const { database, pool } = await databaseWithSchema();
  try {
    await assert.rejects(insertListing(pool, 'bad-seller', { seller_id: 'missing-seller' }), { code: '23503' });
    await assert.rejects(insertListing(pool, 'bad-category', { category_id: 'missing-category' }), { code: '23503' });
    await insertListing(pool, 'constraint-listing');
    await pool.query("INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('same-key','hash-a','constraint-listing')");
    await assert.rejects(pool.query("INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('same-key','hash-b','constraint-listing')"), { code: '23505' });
    await pool.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('job-one','constraint-listing')");
    await assert.rejects(pool.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('job-two','constraint-listing')"), { code: '23505' });
    await pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('constraint-listing','auto',$1)", [decision]);
    await assert.rejects(pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('constraint-listing','auto',$1)", [decision]), { code: '23505' });
    await assert.rejects(pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('constraint-listing','lifecycle',$1)", [decision]), { code: '23514' });
    await pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('constraint-listing','human',$1)", [decision]);
    await assert.rejects(pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('missing-listing','auto',$1)", [decision]), { code: '23503' });
    await assert.rejects(pool.query("INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('orphan-key','hash','missing-listing')"), { code: '23503' });
    await assert.rejects(pool.query("INSERT INTO moderation_jobs(id,listing_id) VALUES('orphan-job','missing-listing')"), { code: '23503' });
  } finally {
    await pool.end();
    await database.dispose();
  }
});

test('history mutation is blocked and duplicate fingerprint index is non-unique', async () => {
  const { database, pool } = await databaseWithSchema();
  try {
    await insertListing(pool, 'history-listing', {
      title: 'same duplicate title', description: 'same description',
      status: 'auto_approved', decision, decided_at: '2026-01-01T00:00:00Z', normalized_fingerprint: 'same-fingerprint',
    });
    await pool.query("INSERT INTO moderation_history(listing_id,phase,decision) VALUES('history-listing','auto',$1)", [decision]);
    await assert.rejects(pool.query("UPDATE moderation_history SET note='changed' WHERE listing_id='history-listing'"), { code: '23514' });
    await assert.rejects(pool.query("DELETE FROM moderation_history WHERE listing_id='history-listing'"), { code: '23514' });
    await assert.rejects(pool.query('TRUNCATE moderation_history'), { code: '23514' });
    await insertListing(pool, 'fingerprint-two', {
      title: 'same duplicate title', description: 'same description',
      status: 'auto_approved', decision, decided_at: '2026-01-01T00:00:00Z', normalized_fingerprint: 'same-fingerprint',
    });
    const fingerprints = await pool.query<{ id: string; normalized_fingerprint: string }>(
      "SELECT id,normalized_fingerprint FROM listings WHERE id IN ('history-listing','fingerprint-two') ORDER BY id",
    );
    assert.deepEqual(fingerprints.rows, [
      { id: 'fingerprint-two', normalized_fingerprint: 'same-fingerprint' },
      { id: 'history-listing', normalized_fingerprint: 'same-fingerprint' },
    ]);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
       AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [[
        'listings_newest_idx', 'listings_seller_newest_idx', 'listings_status_newest_idx',
        'listings_active_duplicate_idx', 'submission_keys_listing_idx', 'jobs_due_idx', 'jobs_recovery_idx',
      ]],
    );
    assert.deepEqual(indexes.rows.map(({ indexname }) => indexname), [
      'jobs_due_idx', 'jobs_recovery_idx', 'listings_active_duplicate_idx', 'listings_newest_idx',
      'listings_seller_newest_idx', 'listings_status_newest_idx', 'submission_keys_listing_idx',
    ]);
    const definitions = Object.fromEntries(indexes.rows.map(({ indexname, indexdef }) => [indexname, indexdef]));
    assert.match(definitions.listings_newest_idx, /created_at DESC, id DESC/);
    assert.match(definitions.listings_seller_newest_idx, /seller_id, created_at DESC, id DESC/);
    assert.match(definitions.listings_status_newest_idx, /status, created_at DESC, id DESC/);
    assert.match(definitions.listings_active_duplicate_idx, /seller_id, normalized_fingerprint/);
    assert.match(definitions.listings_active_duplicate_idx, /auto_approved.*published/);
    assert.doesNotMatch(definitions.listings_active_duplicate_idx, /CREATE UNIQUE INDEX/i);
    assert.match(definitions.submission_keys_listing_idx, /listing_id/);
    assert.match(definitions.jobs_due_idx, /available_at, id/);
    assert.match(definitions.jobs_due_idx, /state = 'queued'/);
    assert.match(definitions.jobs_recovery_idx, /lease_until, id/);
    assert.match(definitions.jobs_recovery_idx, /state = 'running'/);
  } finally {
    await pool.end();
    await database.dispose();
  }
});
