import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
it.each([false, true])(
  'keeps the documentation API read-only with executable arguments=%s',
  async (executable) => {
    process.argv = executable
      ? [process.execPath, resolve('packages/release/src/docs.ts'), '--html-only']
      : [process.execPath];
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await import('../../packages/release/src/docs.js');
    expect(stdout).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  },
);
