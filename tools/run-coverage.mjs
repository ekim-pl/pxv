import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeCoverage } from './lib/coverage.mjs';
const root = process.cwd(),
  directory = resolve('.quality/v8');
await rm(resolve('coverage/coverage-final.json'), { force: true });
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const child = spawn(process.execPath, ['tools/run-tests.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_V8_COVERAGE: directory },
});
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
