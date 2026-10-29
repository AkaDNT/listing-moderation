import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/http/errors';
import { HumanDecisionRequestPipe, mapHumanDecision } from '../src/human/human-decision.pipe';

const pipe = new HumanDecisionRequestPipe();

test('human request projects only own contract fields and maps exact public HUMAN reasons', () => {
  const input = Object.assign(Object.create({ decision: 'reject', moderator_id: 'inherited' }), {
    decision: 'approve', moderator_id: '  mod 🧑‍⚖️  ', note: '', extension: { private: true },
  });
  assert.deepEqual(pipe.transform(input), { decision: 'approve', moderatorId: '  mod 🧑‍⚖️  ', note: '' });
  assert.deepEqual(mapHumanDecision('approve'), {
    outcome: 'approved', reason: { rule_id: 'HUMAN', message: 'Approved by human moderator' },
  });
  assert.deepEqual(mapHumanDecision('reject'), {
    outcome: 'rejected', reason: { rule_id: 'HUMAN', message: 'Rejected by human moderator' },
  });
});

test('human request requires a JSON object and own required fields with exact action spelling', () => {
  for (const value of [null, [], 'approve', 1, true]) {
    assert.throws(() => pipe.transform(value), error => error instanceof ApiError && error.status === 400);
  }
  for (const value of [
    {}, { decision: 'approve' }, { moderator_id: 'm' },
    Object.assign(Object.create({ decision: 'approve', moderator_id: 'm' }), {}),
    { decision: 'Approve', moderator_id: 'm' }, { decision: 'approved', moderator_id: 'm' },
  ]) {
    assert.throws(() => pipe.transform(value), error => error instanceof ApiError && error.status === 400);
  }
});

test('human metadata accepts empty and Unicode strings but rejects wrong types, NUL and lone surrogates', () => {
  for (const metadata of ['', ' \t ', 'é', '🧑‍⚖️', '\uFFFD']) {
    assert.equal(pipe.transform({ decision: 'reject', moderator_id: metadata }).moderatorId, metadata);
  }
  assert.equal(pipe.transform({ decision: 'approve', moderator_id: '', note: '' }).note, '');
  assert.equal(pipe.transform({ decision: 'approve', moderator_id: 'm' }).note, null);

  for (const value of [undefined, null, 7, false, {}, ['m'], 'bad\u0000id', '\uD800', '\uDC00']) {
    assert.throws(() => pipe.transform({ decision: 'approve', moderator_id: value }),
      error => error instanceof ApiError && error.status === 400);
  }
  for (const value of [null, undefined, 7, false, {}, ['note'], 'bad\u0000note', '\uD800', '\uDC00']) {
    assert.throws(() => pipe.transform({ decision: 'reject', moderator_id: 'm', note: value }),
      error => error instanceof ApiError && error.status === 400);
  }
});
