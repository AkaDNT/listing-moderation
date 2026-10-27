import assert from 'node:assert/strict';
if (process.env.TEST_FAILURE_MARKER) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TEST_FAILURE_MARKER, 'assertion reached');
}
assert.fail('T01_FORCED_ASSERTION_FAILURE');
