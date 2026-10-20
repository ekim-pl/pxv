import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from '../test-api.js';
import { product } from '../contracts/fixtures.js';
import { requirePersonalRecovery } from '../../tools/lib/personal-validation.mjs';
import {
  createPersonalMaster,
  recoverPersonalDevice,
  preflight,
} from '../../tools/lib/personal-workflows.mjs';
import { treeFiles } from '../../tools/lib/personal-files.mjs';

it('rejects disabled products before any direct workflow, dry-run, or preflight side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-capability-'));
  try {
    await writeFile(
      join(root, 'product.json'),
      JSON.stringify({ ...product, features: { seedvault: false, extensions: false } }),
    );
    const session = {
      root,
      bin: '/never-invoke',
      project: join(root, 'project'),
      asset: 'phone',
      operator: 'Self',
      signal: new AbortController().signal,
      prompt: () => Promise.reject(new Error('Unexpected prompt')),
    };
    const before = await treeFiles(root);
    for (const options of [{}, { 'dry-run': true }]) {
      await expect(createPersonalMaster(session, options)).rejects.toThrow('Seedvault-enabled');
      await expect(recoverPersonalDevice(session, options)).rejects.toThrow('Seedvault-enabled');
      await expect(preflight(options, root)).rejects.toThrow('Seedvault-enabled');
    }
    expect(await treeFiles(root)).toEqual(before);
    for (const descriptor of [product, { ...product, features: { seedvault: true, extensions: false } }]) {
      await writeFile(join(root, 'product.json'), JSON.stringify(descriptor));
      await expect(requirePersonalRecovery(root)).resolves.toBeUndefined();
    }
    await writeFile(join(root, 'product.json'), '{}');
    await expect(requirePersonalRecovery(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
