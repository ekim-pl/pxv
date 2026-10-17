import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProject, readRegistryAnchor } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import type { ProjectCliContext } from '../../packages/cli/src/arguments.js';
import { registryCommitHooks } from '../../packages/cli/src/registry-commit.js';
import { policy, product } from '../contracts/fixtures.js';

let root: string;
let store: SqliteStore;
let context: ProjectCliContext;
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-registry-hooks-');
  const resources = join(root, 'resources');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  const project = await createProject(join(root, 'project'), product, policy, resources);
  context = { project } as ProjectCliContext;
  store = await SqliteStore.open(join(root, 'state.sqlite3'));
});
afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

it('cannot clear the pending fence before preparation or for a different ciphertext', async () => {
  const [before, after] = registryCommitHooks(context, store, undefined);
  await expect(after('a'.repeat(64))).rejects.toThrow('requires inspection');
  await before('a'.repeat(64));
  await expect(after('b'.repeat(64))).rejects.toThrow('requires inspection');
  expect(await readRegistryAnchor(store, context.project.config.id)).toMatchObject({ state: 'pending' });
  await after('a'.repeat(64));
  expect(await readRegistryAnchor(store, context.project.config.id)).toMatchObject({ state: 'ready' });
});

it('leaves the anchor untouched when the final identity guard fails', async () => {
  const [before] = registryCommitHooks(context, store, undefined, () =>
    Promise.reject(new Error('changed identity')),
  );
  await expect(before('a'.repeat(64))).rejects.toThrow('changed identity');
  expect(await readRegistryAnchor(store, context.project.config.id)).toBeUndefined();
});
