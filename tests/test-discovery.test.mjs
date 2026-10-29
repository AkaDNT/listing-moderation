import assert from 'node:assert/strict';
import { rmSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { discoverTests } from '../scripts/discover-tests.mjs';

test('discovery is deterministic, excludes fixtures and discovers a newly added test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-test-discovery-'));
  try {
    await mkdir(join(root, 'tests', 'fixtures'), { recursive: true });
    await writeFile(join(root, 'tests', 'z.test.mjs'), '');
    await writeFile(join(root, 'tests', 'a.test.mjs'), '');
    await writeFile(join(root, 'tests', 'fixtures', 'ignored.fixture.test.mjs'), '');
    await writeFile(join(root, 'tests', 'fixtures', 'ordinary.test.mjs'), 'throw new Error("fixture must not run");');
    await mkdir(join(root, 'dist', 'tests', 'fixtures'), { recursive: true });
    await writeFile(join(root, 'dist', 'tests', 'fixtures', 'ordinary.test.js'), 'throw new Error("compiled fixture must not run");');
    assert.deepEqual((await discoverTests(root)).map((file) => file.split(/[\\/]/).at(-1)), ['a.test.mjs', 'z.test.mjs']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the registered runner executes a new test file and rejects an empty suite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-runner-contract-'));
  const marker = join(root, 'ran.marker');
  try {
    const testDir = join(root, 'tests');
    await mkdir(testDir);
    await writeFile(join(testDir, 'created-during-test.test.mjs'),
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DISCOVERY_MARKER, 'executed');\n");
    const runner = resolve('scripts/test-runner.mjs');
    const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
    // This positive child contract must not inherit the outer smoke's fault flag.
    const childEnv = { ...parentEnv, TEST_FORCE_FAILURE: '0' };
    const result = spawnSync(process.execPath, [runner], {
      env: { ...childEnv, TEST_DISCOVERY_ROOT: root, DISCOVERY_MARKER: marker }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /created-during-test\.test\.mjs/);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(marker, 'utf8'), 'executed');

    const empty = await mkdtemp(join(tmpdir(), 'listing-empty-suite-'));
    try {
      const emptyResult = spawnSync(process.execPath, [runner], {
        env: { ...childEnv, TEST_DISCOVERY_ROOT: empty }, encoding: 'utf8',
      });
      assert.equal(emptyResult.status, 1);
      assert.match(emptyResult.stderr, /No supported test files/);
    } finally { await rm(empty, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a forced assertion failure marker reaches the outer test runner exit code', () => {
  const runner = resolve('scripts/test-runner.mjs');
  const root = mkdtempSync(join(tmpdir(), `listing-forced-test-${process.pid}`));
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'pass.test.mjs'), "import { test } from 'node:test'; test('pass',()=>{});\n");
  const marker = join(tmpdir(), `listing-failure-marker-${process.pid}`);
  rmSync(marker, { force: true });
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
    const result = spawnSync(process.execPath, [runner], {
      env: { ...parentEnv, TEST_DISCOVERY_ROOT: root, TEST_FORCE_FAILURE: '1', TEST_FAILURE_MARKER: marker }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'assertion reached');
  } finally { rmSync(marker, { force: true }); rmSync(root, { recursive: true, force: true }); }
});
