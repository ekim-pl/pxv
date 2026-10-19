import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from '../test-api.js';

const roots: string[] = [];
const runner = resolve('tools/run-tests.mjs');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runFixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'pxv-test-runner-'));
  roots.push(root);
  const file = join(root, 'fixture.test.mjs');
  await writeFile(file, `import { describe, it } from 'node:test';\n${source}`);
  const env = { ...process.env };
  // Run an independent test harness rather than inheriting the parent test worker context.
  delete env['NODE_TEST_CONTEXT'];
  const result = spawnSync(process.execPath, [runner, file], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return {
    result,
    evidence: JSON.parse(await readFile(join(root, '.quality/tests.json'), 'utf8')) as unknown,
  };
}

describe('real test runner evidence', () => {
  it('counts passing leaves without counting suites', async () => {
    const { result, evidence } = await runFixture(`
      describe('outer', () => {
        it('passes', () => {});
        describe('inner', () => { it('also passes', () => {}); });
      });
    `);
    expect(result.status).toBe(0);
    expect(evidence).toEqual({
      success: true,
      numPassedTests: 2,
      numFailedTests: 0,
      numSkippedTests: 0,
      numTotalTests: 2,
      numFailedTestSuites: 0,
    });
  });

  it('keeps diagnostic runs successful while reporting static and dynamic skips separately', async () => {
    const { result, evidence } = await runFixture(`
      describe('suite', () => {
        it('passes', () => {});
        it.skip('static skip', () => { throw Error('must not run'); });
        it('dynamic skip', (context) => { context.skip('missing optional dependency'); });
      });
    `);
    expect(result.status).toBe(0);
    expect(evidence).toEqual({
      success: true,
      numPassedTests: 1,
      numFailedTests: 0,
      numSkippedTests: 2,
      numTotalTests: 3,
      numFailedTestSuites: 0,
    });
  });

  it('reports a failed leaf alongside passes and skips and exits unsuccessfully', async () => {
    const { result, evidence } = await runFixture(`
      describe('suite', () => {
        it('passes', () => {});
        it('fails', () => { throw Error('fixture failure'); });
        it('skips', { skip: 'optional' }, () => {});
      });
    `);
    expect(result.status).toBe(1);
    expect(evidence).toEqual({
      success: false,
      numPassedTests: 1,
      numFailedTests: 1,
      numSkippedTests: 1,
      numTotalTests: 3,
      numFailedTestSuites: 1,
    });
  });
});
