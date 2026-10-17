import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeCoverage } from './lib/coverage.mjs';
const root = process.cwd(),
  directory = resolve('.quality/v8');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
/** @type {NodeJS.ProcessEnv} */
const env = { ...process.env, PXV_CHILD_V8_COVERAGE_DIRECTORY: directory };
// Vitest terminates pool supervisors after their stop acknowledgement. Their
// native exit dumps can be interrupted; the V8 provider covers those isolates.
delete env['NODE_V8_COVERAGE'];
const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--coverage',
    '--reporter=default',
    '--reporter=json',
    '--outputFile.json=.quality/tests.json',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env },
);
const code = await new Promise((done, reject) => {
  child.once('error', reject);
  child.once('close', done);
});
if (code !== 0) process.exitCode = 1;
else {
  const result = await completeCoverage(root, directory);
  process.stdout.write(
    `Merged worker/subprocess coverage: ${result.total.lines.pct}% lines / ${result.total.branches.pct}% branches.\n`,
  );
  if (result.failures.length) {
    process.stderr.write(result.failures.join('\n') + '\n');
    process.exitCode = 1;
  }
}
