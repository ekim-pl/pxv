import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { afterEach, expect, test } from 'vitest';
import { completeCoverage } from '../../tools/lib/coverage.mjs';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(): Promise<{ root: string; traces: string }> {
  const root = await mkdtemp('/tmp/pxv-coverage-traces-');
  temporary.push(root);
  const traces = join(root, '.quality/v8');
  await mkdir(traces, { recursive: true });
  await mkdir(join(root, 'coverage'));
  await writeFile(join(root, 'coverage/coverage-final.json'), '{}');
  return { root, traces };
}

test('native coverage starts in application workers without tracing their test harness', async () => {
  const { traces } = await fixture();
  const setup = pathToFileURL(
    fileURLToPath(new URL('../../tools/lib/coverage-setup.mjs', import.meta.url)),
  ).href;
  const contracts = new URL('../../packages/contracts/dist/index.js', import.meta.url).href;
  const policy = new URL('../../packages/contracts/dist/policy.js', import.meta.url).href;
  const workerCode = `import {digest} from ${JSON.stringify(contracts)}; digest({coverage:true});`;
  const code = `import {Worker} from 'node:worker_threads'; await import(${JSON.stringify(setup)}); const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(workerCode)}))); await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',resolve);});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PXV_CHILD_V8_COVERAGE_DIRECTORY: traces },
  });
  const files = await readdir(traces);
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((name) => !name.endsWith('-0.json'))).toBe(true);
  const scripts = await Promise.all(
    files.map(async (name) => {
      const trace = JSON.parse(await readFile(join(traces, name), 'utf8')) as { result: { url: string }[] };
      return trace.result.map((script) => script.url);
    }),
  );
  expect(scripts.flat()).toContain(policy);
});

test.each(['', '{"result":[', '{"result":{}}', '{"result":[{}]}'])(
  'persistent malformed child trace %j produces a named failed report',
  async (contents) => {
    const { root, traces } = await fixture();
    await writeFile(join(traces, 'coverage-worker.json'), contents);
    const result = await completeCoverage(root, traces);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('Coverage trace .quality/v8/coverage-worker.json:');
    const saved = JSON.parse(await readFile(join(root, '.quality/coverage.json'), 'utf8')) as {
      failures: string[];
    };
    expect(saved.failures).toEqual(result.failures);
  },
);

test.each(['', '{"result":['])('child trace %j is retried while its final write settles', async (initial) => {
  const { root, traces } = await fixture();
  const filename = join(traces, 'coverage-delayed.json');
  await writeFile(filename, initial);
  const writer = delay(65).then(() => writeFile(filename, '{"result":[]}'));
  const result = await completeCoverage(root, traces);
  await writer;
  expect(result.children.failures).toEqual([]);
  expect(result.failures).toEqual([]);
});

test('malformed child coverage does not hide missing required application modules', async () => {
  const { root, traces } = await fixture();
  await mkdir(join(root, 'packages/example/src'), { recursive: true });
  await writeFile(join(root, 'packages/example/src/missing.ts'), 'export const required = true;');
  await writeFile(join(traces, 'coverage-bad.json'), '{"result":[{"url":"file:///bad","functions":[{}]}]}');
  const result = await completeCoverage(root, traces);
  expect(result.failures).toHaveLength(2);
  expect(result.failures[1]).toBe('Component omitted from coverage: packages/example/src/missing.ts');
  expect(result.thresholds).toEqual({ lines: 90, branches: 85 });
});
