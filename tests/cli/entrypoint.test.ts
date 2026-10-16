import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { startCli } from '../../packages/cli/src/entrypoint.js';
const execute = promisify(execFile);
const roots: string[] = [];
const saved = process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = saved;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('executable entrypoint', () => {
  it('retains command exit status and renders safe failures', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await startCli(() => Promise.resolve(4), []);
    expect(process.exitCode).toBe(4);
    await startCli(() => Promise.reject(new Error('Operator confirmation required')), []);
    expect(process.exitCode).toBe(2);
    expect(write).toHaveBeenLastCalledWith('Operator confirmation required\n');
    const untyped = vi.fn<() => Promise<number>>().mockRejectedValue('untyped internal failure');
    await startCli(untyped, []);
    expect(process.exitCode).toBe(2);
    expect(write).toHaveBeenLastCalledWith('pxv failed\n');
  });
  it('runs the compiled executable outside the checkout and reports parser failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pxv-entrypoint-'));
    roots.push(root);
    const entry = resolve('packages/cli/dist/main.js'),
      resources = resolve('.');
    const version = await execute(process.execPath, [entry, 'version', '--resource-root', resources], {
      cwd: root,
      timeout: 10_000,
    });
    expect(version.stdout).toBe('0.1.0\n');
    expect(version.stderr).toBe('');
    const failure: unknown = await execute(
      process.execPath,
      [entry, '--unknown-flag', '--resource-root', resources],
      { cwd: root, timeout: 10_000 },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 2 });
    expect(failure).toHaveProperty('stderr', expect.stringContaining('unknown-flag'));
  });
});
