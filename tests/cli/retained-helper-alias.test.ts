import type * as Files from 'node:fs/promises';
import type * as Helper from '../../packages/cli/src/retained-helper.js';
import { importModule, expect, it, vi } from '../test-api.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mount = vi.hoisted(() => ({ root: '', directory: true, symlink: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Files>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] !== '/project') return actual.lstat(...args);
      const stat = await actual.lstat(mount.root);
      return { ...stat, isDirectory: () => mount.directory, isSymbolicLink: () => mount.symlink };
    },
  };
});
const { retainedHelperPath } = await importModule<typeof Helper>(
  '../../packages/cli/src/retained-helper.js',
  import.meta.url,
);

it('accepts only a directory alias with the same filesystem identity as the selected Docker project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-helper-alias-'));
  const previous = process.env['PXV_DOCKER_MODE'];
  try {
    process.env['PXV_DOCKER_MODE'] = 'direct';
    await mkdir(join(root, 'state/plans/run'), { recursive: true });
    const helper = join(root, 'state/plans/run/helper.apk');
    await writeFile(helper, 'EXACT');
    mount.root = root;
    expect(await retainedHelperPath(root, '/project/state/plans/run/helper.apk')).toBe(helper);
    mount.symlink = true;
    await expect(retainedHelperPath(root, '/project/state/plans/run/helper.apk')).rejects.toThrow('differs');
    mount.symlink = false;
    mount.directory = false;
    await expect(retainedHelperPath(root, '/project/state/plans/run/helper.apk')).rejects.toThrow('differs');
    mount.directory = true;
    mount.root = join(root, 'state');
    await expect(retainedHelperPath(root, '/project/state/plans/run/helper.apk')).rejects.toThrow('differs');
  } finally {
    if (previous === undefined) delete process.env['PXV_DOCKER_MODE'];
    else process.env['PXV_DOCKER_MODE'] = previous;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
