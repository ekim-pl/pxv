import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:path';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
import { afterEach, beforeEach, expect, it, vi } from './../test-api.js';
// Module exports are called without a receiver.

const { mkdtemp, readdir, rm } = await importModule<typeof TestModule0>('node:fs/promises', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { resolve } = await importModule<typeof TestModule1>('node:path', import.meta.url);

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
    // Exercise the error path with the exact fixture rejection.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const runRelease = vi.fn(() => Promise.reject(error));
    vi.doMock('../../packages/release/src/release-service.js', () => ({ runRelease }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = [process.execPath, resolve('packages/release/src/cli.ts'), '--formats', 'portable'];
    await importModule('../../packages/release/src/cli.js', import.meta.url);
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
    await importModule('../../packages/release/src/docs.js', import.meta.url);
    expect(stdout).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  },
);
