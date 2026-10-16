import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CommandRunner } from '@pxv/runtime';
const runner = new CommandRunner();
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
});
it('runs the compiled release entrypoint for help and invalid flags without creating a candidate', async () => {
  const help = await runner.run([process.execPath, resolve('packages/release/dist/cli.js'), '--help']);
  expect(help.stdout).toContain('Build preview');
  const invalid = await runner.run(
    [process.execPath, resolve('packages/release/dist/cli.js'), '--unsupported'],
    { check: false },
  );
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('Unsupported release argument');
});
it('runs compiled documentation generation and surfaces source errors without opening a browser', async () => {
  const directory = await mkdtemp('/tmp/pxv-docs-entry-');
  temporary.push(directory);
  await writeFile(join(directory, 'product.json'), await readFile('product.json'));
  await mkdir(join(directory, 'guides/source/markdown'), { recursive: true });
  await writeFile(join(directory, 'guides/source/markdown/guide.en.md'), '# Public entry fixture');
  const success = await runner.run(
    [process.execPath, resolve('packages/release/dist/docs.js'), '--html-only'],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', PXV_CHROMIUM: '/not-used-by-html-only' } },
  );
  expect(success.code).toBe(0);
  expect(success.stdout).toContain('guide.en.html');
  await rm(join(directory, 'product.json'));
  const invalid = await runner.run(
    [process.execPath, resolve('packages/release/dist/docs.js'), '--html-only'],
    { cwd: directory, check: false },
  );
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('ENOENT');
});
