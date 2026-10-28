import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

interface Reason { rule_id: string; message: string; detail?: Record<string, unknown>; }
interface BannedTermsModule {
  matchBannedTerms?: (title: string, description: string, terms: string[]) => Reason[];
}

function loadMatcher(): BannedTermsModule {
  try { return require('../src/moderation/banned-terms') as BannedTermsModule; }
  catch { return {}; }
}

const seedTerms = JSON.parse(readFileSync(resolve(__dirname, '../../seed/banned_keywords.json'), 'utf8')) as string[];
const matcher = loadMatcher();

test('production R1 matcher finds every seed term in title and description with original term in message', () => {
  assert.equal(typeof matcher.matchBannedTerms, 'function', 'production R1 matcher must be available');
  for (const term of seedTerms) {
    for (const [title, description, field] of [
      [term.toLocaleUpperCase('en-US'), '', 'title'],
      ['', `This listing mentions ${term}.`, 'description'],
    ] as const) {
      const reasons = matcher.matchBannedTerms!(title, description, seedTerms);
      const reason = reasons.find(candidate => candidate.message.includes(term));
      assert.ok(reason, `R1 must report seed term ${term}`);
      assert.equal(reason.rule_id, 'R1');
      assert.match(reason.message, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
      assert.deepEqual(reason.detail, { fields: [field] });
    }
  }
});

test('production R1 boundaries use NFC and Unicode word characters, with literal phrase spacing', () => {
  assert.equal(typeof matcher.matchBannedTerms, 'function', 'production R1 matcher must be available');
  const matches = (title: string, terms = ['fake']) => matcher.matchBannedTerms!(title, '', terms).length > 0;
  for (const title of ['fake', '(fake)', 'fake!', 'FAKE']) assert.equal(matches(title), true, title);
  for (const title of ['replicas', 'myreplica', 'éfakex', 'fake\u0301', '_fake_', 'fake2']) {
    assert.equal(matches(title, ['fake']), false, title);
  }

  assert.equal(matches('(hang gia)', ['hang gia']), true);
  for (const title of ['hang  gia', 'hang\tgia', 'hang\u00a0gia', 'hang\ngia']) {
    assert.equal(matches(title, ['hang gia']), false, JSON.stringify(title));
  }
  assert.equal(matcher.matchBannedTerms!('hang', 'gia', ['hang gia']).length, 0);
  assert.equal(matches('REPLICA', ['replica']), true);
  assert.equal(matches('cafe\u0301', ['café']), true);
  assert.equal(matches('CAFÉ', ['cafe\u0301']), true);
});

test('production R1 matcher escapes seed metacharacters, emits one ordered reason per term, and does not mutate inputs', () => {
  assert.equal(typeof matcher.matchBannedTerms, 'function', 'production R1 matcher must be available');
  const terms = ['fake', 'replica', 'a+b'];
  const original = [...terms];
  const reasons = matcher.matchBannedTerms!('REPLICA fake fake a+b a+b', 'fake', terms);
  assert.deepEqual(terms, original);
  assert.deepEqual(reasons.map(reason => reason.message.match(/"([^"]+)"/)?.[1]), ['a+b', 'fake', 'replica']);
  assert.deepEqual(reasons.map(reason => reason.detail), [
    { fields: ['title'] },
    { fields: ['title', 'description'] },
    { fields: ['title'] },
  ]);
  assert.deepEqual(matcher.matchBannedTerms!('title', 'cafe\u0301', ['café'])[0].detail, { fields: ['description'] });
});
