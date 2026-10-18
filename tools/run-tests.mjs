import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { globSync, mkdirSync, writeFileSync } from 'node:fs';
const patterns = process.argv.slice(2);
const files = [
  ...new Set((patterns.length ? patterns : ['tests/**/*.test.ts']).flatMap((p) => globSync(p))),
].sort();
if (!files.length) throw new Error('No test files selected');
const stream = run({
  files,
  isolation: 'process',
  forceExit: true,
  concurrency: 4,
  timeout: 120_000,
  execArgv: ['--import', new URL('./test-hooks.mjs', import.meta.url).href],
});
let passed = 0,
  failed = 0;
stream.on('test:pass', (event) => {
  if (event.details.type !== 'suite') passed++;
});
stream.on('test:fail', (event) => {
  if (event.details.type !== 'suite') {
    failed++;
    console.error(event.details.error);
  }
});
stream.on('end', () => {
  mkdirSync('.quality', { recursive: true });
  writeFileSync(
    '.quality/tests.json',
    JSON.stringify(
      {
        success: failed === 0,
        numPassedTests: passed,
        numFailedTests: failed,
        numTotalTests: passed + failed,
        numFailedTestSuites: failed ? 1 : 0,
      },
      null,
      2,
    ) + '\n',
  );
  if (failed) process.exitCode = 1;
});
stream.compose(spec).pipe(process.stdout);
