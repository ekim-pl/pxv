import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
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
it('runs the canonical guide publisher from outside the checkout without a project or browser', async () => {
  const directory = await mkdtemp('/tmp/pxv-docs-entry-');
  temporary.push(directory);
  const output = join(directory, 'guides');
  const success = await runner.run(
    [
      process.execPath,
      resolve('tools/optional/publishing/rebuild.mjs'),
      '--html-only',
      '--output-dir',
      output,
    ],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', PXV_CHROMIUM: '/not-used-by-html-only' } },
  );
  expect(success.code).toBe(0);
  expect(success.stdout).toContain('4 guide editions built');
  const manifest = JSON.parse(await readFile(join(output, 'qa/manifest.json'), 'utf8')) as {
    outputCount: number;
    editions: { name: string }[];
  };
  expect(manifest.outputCount).toBe(4);
  expect(manifest.editions.map(({ name }) => name)).toEqual([
    'operator-en',
    'operator-pl',
    'user-en',
    'user-pl',
  ]);
});
it('refuses missing browser selection, unknown flags and invalid output before publishing', async () => {
  const directory = await mkdtemp('/tmp/pxv-docs-errors-');
  temporary.push(directory);
  const entry = resolve('tools/optional/publishing/rebuild.mjs');
  const output = join(directory, 'uncreated');
  const missingBrowser = await runner.run([process.execPath, entry, '--output-dir', output], {
    cwd: directory,
    env: { PXV_CHROMIUM: '' },
    check: false,
  });
  expect(missingBrowser.code).toBe(1);
  expect(missingBrowser.stderr).toContain('Select Chromium explicitly');
  await expect(access(output)).rejects.toThrow();
  const unknown = await runner.run([process.execPath, entry, '--unsupported'], { check: false });
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown option');
  const blocked = join(directory, 'file');
  await writeFile(blocked, 'Not an output directory');
  const invalidOutput = await runner.run([process.execPath, entry, '--html-only', '--output-dir', blocked], {
    cwd: directory,
    check: false,
  });
  expect(invalidOutput.code).toBe(1);
  expect(invalidOutput.stderr).toContain('EEXIST');
  expect(await readFile(blocked, 'utf8')).toBe('Not an output directory');
});
