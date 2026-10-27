import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toExitCode } from '../scripts/test-exit.mjs';

test('test child exit mapping preserves success and failure', () => {
  assert.equal(toExitCode(0, null), 0);
  assert.equal(toExitCode(3, null), 3);
});

test('test child without an exit code and child terminated by signal fail', () => {
  assert.equal(toExitCode(null, null), 1);
  assert.equal(toExitCode(0, 'SIGTERM'), 1);
});
