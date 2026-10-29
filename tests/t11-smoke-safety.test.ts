import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';

async function runCase(scenario: string, signal?: NodeJS.Signals) {
  const root = await mkdtemp(join(tmpdir(), 't11-smoke-contract-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const command of ['docker', 'curl', 'timeout']) {
    const path = join(bin, command);
    await copyFile(resolve('tests/fixtures/t11-smoke-command.sh'), path);
    await chmod(path, 0o755);
  }
  const child = spawn('sh', [resolve('tests/t11-health-smoke.sh')], {
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, CASE_ROOT: root, SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('exit', done); child.once('error', reject);
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 6000);
  try {
    if (signal) {
      const end = Date.now() + 3000;
      while (true) {
        try { await access(join(root, 'barrier')); break; } catch {}
        assert.ok(Date.now() < end, 'signal barrier was not reached: ' + output);
        await new Promise(done => setTimeout(done, 10));
      }
      child.kill(signal);
    }
    const code = await exited;
    assert.equal(timedOut, false, 'smoke contract exceeded its deadline: ' + output);
    assert.equal(child.signalCode, null, 'smoke shell must handle the signal and exit normally');
    const trace = await readFile(join(root, 'trace'), 'utf8');
    return { code, trace, output };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}

for (const stage of ['container', 'network', 'volume']) {
  test(`T11 smoke refuses startup when ${stage} inventory is indeterminate`, async () => {
    const result = await runCase('preflight_' + stage);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.trace, / up --build/);
    assert.doesNotMatch(result.trace, / down -v/);
  });
}
for (const stage of ['container', 'network', 'volume', 'label', 'foreign_label']) {
  test(`T11 smoke refuses destructive cleanup when ${stage} ownership cannot be established`, async () => {
    const result = await runCase('cleanup_' + stage);
    assert.notEqual(result.code, 0);
    assert.match(result.trace, / up --build/);
    assert.doesNotMatch(result.trace, / down -v/);
  });
}
for (const resource of ['volume', 'network']) {
  test(`T11 smoke refuses an existing exact-name foreign ${resource}`, async () => {
    const result = await runCase('foreign_' + resource);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.trace, / up --build| down -v/);
  });
}
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`T11 smoke preserves ${signal} failure status and cleans owned resources once`, async () => {
    const result = await runCase('signal_' + signal, signal);
    assert.equal(result.code, code, result.output);
    assert.equal(result.trace.split('\n').filter(line => line.includes(' down -v')).length, 1);
  });
}
test('T11 smoke cleans proven owned resources after a later command fails', async () => {
  const result = await runCase('owned');
  assert.notEqual(result.code, 0);
  assert.equal(result.trace.split('\n').filter(line => line.includes(' down -v')).length, 1);
});
