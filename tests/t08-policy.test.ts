import assert from 'node:assert/strict';
import { test } from 'node:test';

interface WorkerPolicy {
  MAX_JOB_CLAIMS?: number;
  retryDelayMs?: (attempt: number, random: number) => number;
  sanitizeWorkerError?: (error: unknown) => string;
}

function productionPolicy(): WorkerPolicy {
  try { return require('../src/worker/job-policy') as WorkerPolicy; }
  catch { return {}; }
}

test('worker retry policy applies bounded full jitter for each persisted attempt', () => {
  const policy = productionPolicy();
  assert.equal(typeof policy.retryDelayMs, 'function', 'production retry schedule must be available');
  assert.equal(policy.MAX_JOB_CLAIMS, 5);
  assert.equal(policy.retryDelayMs!(1, 0), 0);
  assert.equal(policy.retryDelayMs!(1, 1), 1000);
  assert.equal(policy.retryDelayMs!(2, 0.5), 1000);
  assert.equal(policy.retryDelayMs!(5, 1), 16000);
  assert.throws(() => policy.retryDelayMs!(0, 0.5), /attempt/i);
  assert.throws(() => policy.retryDelayMs!(6, 0.5), /attempt/i);
  assert.throws(() => policy.retryDelayMs!(1, 1.1), /random/i);
});

test('worker error diagnostics retain only safe category and SQLSTATE, never raw text', () => {
  const policy = productionPolicy();
  assert.equal(typeof policy.sanitizeWorkerError, 'function', 'production error sanitizer must be available');
  const diagnostic = policy.sanitizeWorkerError!({
    name: 'Error', code: '57014',
    message: 'password=hunter2 listing title private body postgres://user:secret@db/listings',
    stack: 'private stack',
  });
  assert.equal(diagnostic, 'database_error:57014');
  assert.doesNotMatch(diagnostic, /hunter2|private|postgres|secret|listing title/i);
  assert.equal(policy.sanitizeWorkerError!(new TypeError('private input')), 'unexpected_error:TypeError');
  assert.equal(policy.sanitizeWorkerError!('private input'), 'unexpected_error:unknown');
});
