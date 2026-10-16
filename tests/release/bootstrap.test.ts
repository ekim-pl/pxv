import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const originalArgs = [...process.argv];
const originalExit = process.exitCode;
let directory: string;
beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp('/tmp/pxv-release-bootstrap-');
});
afterEach(async () => {
  process.argv = originalArgs;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('../../packages/release/src/release-service.js');
  await rm(directory, { force: true, recursive: true });
});
it.each([new Error('Expected release failure')])(
  'handles source release bootstrap failures without leaking arbitrary values',
  async (error) => {
    const runRelease = vi.fn(() => Promise.reject(error));
    vi.doMock('../../packages/release/src/release-service.js', () => ({ runRelease }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = [process.execPath, resolve('packages/release/src/cli.ts'), '--formats', 'portable'];
    await import('../../packages/release/src/cli.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(runRelease).toHaveBeenCalledWith(['--formats', 'portable']);
    expect(stderr).toHaveBeenCalledWith(
      error instanceof Error ? 'Expected release failure\n' : 'Release build failed\n',
    );
  },
);
it('keeps the documentation module read-only when imported without an executable argument', async () => {
  process.argv = [process.execPath];
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await import('../../packages/release/src/docs.js');
  expect(stdout).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});
it.each([true, false])(
  'runs source documentation bootstrap with explicit chromium option=%s',
  async (explicit) => {
    const entry = resolve('packages/release/src/docs.ts');
    const product = await readFile('product.json');
    await writeFile(join(directory, 'product.json'), product);
    await mkdir(join(directory, 'guides/source/markdown'), { recursive: true });
    await writeFile(join(directory, 'guides/source/markdown/public.en.md'), '# Public bootstrap fixture');
    process.argv = [process.execPath, entry, '--html-only'];
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    vi.stubEnv('PXV_CHROMIUM', explicit ? '/approved/chromium' : undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await import('../../packages/release/src/docs.js');
    await vi.waitFor(() => expect(stdout).toHaveBeenCalledWith(expect.stringContaining('public.en.html')));
    expect(await readFile(join(directory, 'dist/guides/public.en.html'), 'utf8')).toContain(
      'Public bootstrap fixture',
    );
  },
);
it('reports source documentation build failure and preserves a nonzero exit status', async () => {
  process.argv = [process.execPath, resolve('packages/release/src/docs.ts'), '--html-only'];
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../../packages/release/src/docs.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
});
