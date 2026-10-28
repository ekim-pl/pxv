import type * as FileSystem from 'node:fs/promises';
import type * as Promotion from '../../packages/release/src/promotion-snapshot.js';
import { afterEach, expect, importModule, it, vi } from '../test-api.js';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
globalThis.__pxvTestFile = import.meta.url;
const faults = vi.hoisted(() => ({ cleanup: undefined as Error | undefined, changed: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.cleanup && String(args[0]).includes('pxv-promotion-')) throw faults.cleanup;
      return actual.rm(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (faults.changed && String(args[0]).endsWith('package.tgz')) {
        const stat = file.stat.bind(file);
        let count = 0;
        file.stat = (async () => {
          const value = await stat();
          if (count++ > 0) value.mtimeMs++;
          return value;
        }) as typeof file.stat;
      }
      return file;
    },
  };
});
const fs = await importModule<typeof FileSystem>('node:fs/promises', import.meta.url);
const { withPromotionSnapshot } = await importModule<typeof Promotion>(
  '../../packages/release/src/promotion-snapshot.js',
  import.meta.url,
);
const roots: string[] = [];
afterEach(async () => {
  faults.cleanup = undefined;
  faults.changed = false;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp('/tmp/pxv-snapshot-fixture-');
  roots.push(root);
  for (const file of ['SHA256SUMS', 'SHA256SUMS.sig', 'provenance.json', 'package.tgz'])
    await fs.writeFile(join(root, file), 'retained original');
  return root;
}
for (const kind of ['success', 'operation', 'cleanup', 'both'])
  it(`cleans private snapshots and preserves ${kind} outcomes`, async () => {
    const root = await fixture();
    const primary = new Error('Primary promotion failed'),
      secondary = new Error('Snapshot removal failed');
    let snapshot = '';
    const action = withPromotionSnapshot(root, join(root, 'package.tgz'), (directory) => {
      snapshot = directory;
      roots.push(directory);
      if (kind === 'cleanup' || kind === 'both') faults.cleanup = secondary;
      return kind === 'operation' || kind === 'both' ? Promise.reject(primary) : Promise.resolve('verified');
    });
    if (kind === 'success') expect(await action).toBe('verified');
    else if (kind === 'both')
      await expect(action).rejects.toMatchObject({
        errors: [primary, secondary],
        cause: primary,
        message: 'Primary promotion failed; snapshot cleanup failed: Snapshot removal failed',
      });
    else await expect(action).rejects.toBe(kind === 'operation' ? primary : secondary);
    if (kind === 'success' || kind === 'operation')
      await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect((await fs.stat(snapshot)).isDirectory()).toBe(true);
  });
for (const kind of ['symlink', 'directory', 'fifo', 'oversized', 'changing'])
  it(`rejects ${kind} inputs while constructing a publication snapshot`, async () => {
    const root = await fixture();
    const name = kind === 'oversized' ? 'SHA256SUMS' : 'package.tgz';
    const path = join(root, name);
    if (kind !== 'changing') await fs.unlink(path);
    if (kind === 'symlink') await fs.symlink(join(root, 'provenance.json'), path);
    if (kind === 'directory') await fs.mkdir(path);
    if (kind === 'fifo') await promisify(execFile)('mkfifo', [path]);
    if (kind === 'oversized') await fs.writeFile(path, Buffer.alloc(1048577));
    if (kind === 'changing') faults.changed = true;
    const publish = vi.fn(() => Promise.resolve());
    await expect(withPromotionSnapshot(root, join(root, 'package.tgz'), publish)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(await fs.readFile(join(root, 'provenance.json'), 'utf8')).toBe('retained original');
  });
