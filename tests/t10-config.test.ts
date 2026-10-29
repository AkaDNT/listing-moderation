import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config';

test('LISTING_TTL_DAYS defaults to 30 days while preserving explicit positive safe integer validation', () => {
  const base = { DATABASE_URL: 'postgres://moderator:secret@db:5432/listings' };
  assert.equal(loadConfig(base).listingTtlDays, 30);
  for (const value of ['1', '2', '365']) assert.equal(loadConfig({ ...base, LISTING_TTL_DAYS: value }).listingTtlDays, Number(value));
  for (const value of ['', '0', '-1', '1.5', '1e2', ' 30', '9007199254740992']) {
    assert.throws(() => loadConfig({ ...base, LISTING_TTL_DAYS: value }), /LISTING_TTL_DAYS/);
  }
});
