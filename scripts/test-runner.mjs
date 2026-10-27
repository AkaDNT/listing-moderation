import { spawn } from 'node:child_process';
import { discoverTests } from './discover-tests.mjs';

const tests = await discoverTests(process.env.TEST_DISCOVERY_ROOT ?? process.cwd());
if (!tests.length) {
  console.error('No supported test files found.');
  process.exit(1);
}
if (process.env.TEST_FORCE_FAILURE === '1') tests.push('tests/fixtures/intentional-failure.mjs');
const child = spawn(process.execPath, ['--test', ...tests], { stdio: 'inherit', env: process.env });
let requestedSignal = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    requestedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.once('error', (error) => {
  console.error(`Test process failed to start: ${error.message}`);
  process.exitCode = 1;
});
const result = await new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
const { toExitCode } = await import('./test-exit.mjs');
process.exitCode = toExitCode(result.status, result.signal ?? requestedSignal);
