import type * as Fs from 'node:fs/promises';
import type * as Runtime from '@pxv/runtime';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, importModule, it, vi } from '../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
type Fault = 'removed' | 'replaced' | 'stat-error' | 'cleanup-missing' | 'cleanup-error';
let fault: Fault,
  rollingBack = false,
  root: string;
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    link: vi.fn<typeof actual.link>(async (source, destination) => {
      if (String(destination).endsWith('/second') && !fault.startsWith('cleanup')) {
        const first = String(destination).replace(/second$/u, 'first');
        if (fault === 'removed' || fault === 'replaced') await actual.unlink(first);
        if (fault === 'replaced') await actual.writeFile(first, 'OTHER', { mode: 0o600 });
        rollingBack = true;
        throw new Error('Second publication failed');
      }
      return actual.link(source, destination);
    }),
    lstat: vi.fn((path: Parameters<typeof actual.lstat>[0]) => {
      if (fault === 'stat-error' && rollingBack && String(path).endsWith('/first'))
        return Promise.reject(Object.assign(new Error('Cannot inspect destination'), { code: 'EACCES' }));
      return actual.lstat(path);
    }),
    unlink: vi.fn<typeof actual.unlink>(async (path) => {
      if (String(path).includes('/.pxv-export-') && fault.startsWith('cleanup')) {
        if (fault === 'cleanup-error') throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' });
        await actual.unlink(path);
      }
      return actual.unlink(path);
    }),
  };
});
const { writeRegistryPrivatePair } = await importModule<typeof Runtime>('@pxv/runtime', import.meta.url);
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-pair-fault-');
  rollingBack = false;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const publish = () =>
  writeRegistryPrivatePair(
    { path: join(root, 'first'), bytes: Buffer.from('FIRST') },
    { path: join(root, 'second'), bytes: Buffer.from('SECOND') },
  );
for (const race of ['removed', 'replaced'] as const) {
  it(`preserves concurrent destination changes when the published first file is ${race}`, async () => {
    fault = race;
    await expect(publish()).rejects.toThrow('could not be published');
    if (race === 'removed') await expect(stat(join(root, 'first'))).rejects.toThrow();
    else expect(await readFile(join(root, 'first'), 'utf8')).toBe('OTHER');
    expect(await readdir(root)).toEqual(race === 'removed' ? [] : ['first']);
  });
}
it('refuses to remove a destination whose identity cannot be inspected during rollback', async () => {
  fault = 'stat-error';
  await expect(publish()).rejects.toThrow('Cannot inspect destination');
  expect(await readFile(join(root, 'first'), 'utf8')).toBe('FIRST');
  expect(await readdir(root)).toEqual(['first']);
});
it('tolerates staging files already removed during cleanup', async () => {
  fault = 'cleanup-missing';
  await publish();
  expect(await readdir(root)).toEqual(['first', 'second']);
});
it('reports staging cleanup failures while retaining both published files', async () => {
  fault = 'cleanup-error';
  await expect(publish()).rejects.toThrow('Cleanup denied');
  expect(await readFile(join(root, 'first'), 'utf8')).toBe('FIRST');
  expect(await readFile(join(root, 'second'), 'utf8')).toBe('SECOND');
});
