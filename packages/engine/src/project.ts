import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  parseDocument,
  resolvePolicy,
  validateInventory,
  validatePolicy,
  validateProduct,
  validateProject,
  type Inventory,
  type PolicyPack,
  type ProductDescriptor,
  type ProjectConfig,
  type ResolvedPolicy,
} from '@pxv/contracts';
import { atomicWritePrivate, readBounded } from '@pxv/runtime';
import { fileURLToPath } from 'node:url';
import { engineIntegrity } from './integrity.js';

export interface ProjectContext {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly product: ProductDescriptor;
  readonly policy: PolicyPack;
  readonly inventory: Inventory;
  readonly resolved: ResolvedPolicy;
}

export async function containedPath(root: string, name: string, mustExist = true): Promise<string> {
  if (isAbsolute(name) || name.split(/[\\/]/u).some((part) => part === '..' || part === '')) {
    throw new Error('Project paths must be contained relative paths');
  }
  const base = await realpath(root);
  const path = resolve(base, name);
  const prefix = relative(base, path);
  if (!prefix || prefix.startsWith(`..${sep}`) || isAbsolute(prefix)) throw new Error('Unsafe project path');
  let current = base;
  for (const part of prefix.split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('Project paths must not traverse symlinks');
  }
  return path;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function loadProject(
  root: string,
  product: ProductDescriptor,
  codeRoot = fileURLToPath(new URL('../../../', import.meta.url)),
): Promise<ProjectContext> {
  const base = await realpath(root);
  const marker = resolve(base, 'pxv.project.json');
  if (!(await exists(marker))) {
    if (
      (await exists(resolve(base, 'config/manifest.yaml'))) ||
      (await exists(resolve(base, 'state/agent/jobs.sqlite3')))
    ) {
      throw new Error(
        'This is a Python pxv project. Create a new TypeScript project; retained state is unchanged.',
      );
    }
    throw new Error('Project marker missing; use project init with a new directory');
  }
  const config = validateProject(
    parseDocument(
      (await readBounded(await containedPath(base, 'pxv.project.json'), 1024 * 1024)).toString('utf8'),
    ),
  );
  if (config.productId !== product.id) throw new Error('Project belongs to a different product fork');
  const policy = validatePolicy(
    parseDocument(
      (await readBounded(await containedPath(base, config.policyFile), 4 * 1024 * 1024)).toString('utf8'),
    ),
  );
  const inventory = validateInventory(
    parseDocument(
      (await readBounded(await containedPath(base, config.inventoryFile), 4 * 1024 * 1024)).toString('utf8'),
    ),
  );
  return Object.freeze({
    root: base,
    config,
    product,
    policy,
    inventory,
    resolved: resolvePolicy(policy, config, product, await engineIntegrity(codeRoot)),
  });
}

export async function createProject(
  root: string,
  product: ProductDescriptor,
  policy: PolicyPack,
  codeRoot?: string,
): Promise<ProjectContext> {
  validateProduct(product);
  validatePolicy(policy);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  for (const name of [
    'pxv.project.json',
    'policy.yaml',
    'inventory.json',
    'config/manifest.yaml',
    'state/agent/jobs.sqlite3',
  ]) {
    if (await exists(resolve(base, name)))
      throw new Error('Initialization refuses existing project files or Python state');
  }
  const config: ProjectConfig = {
    format: 'pxv-ts',
    schemaVersion: 1,
    id: randomUUID(),
    productId: product.id,
    policyFile: 'policy.yaml',
    inventoryFile: 'inventory.json',
    extensions: [],
  };
  await atomicWritePrivate(resolve(base, 'policy.yaml'), JSON.stringify(policy, null, 2));
  await atomicWritePrivate(
    resolve(base, 'inventory.json'),
    JSON.stringify({ schemaVersion: 1, devices: [] }, null, 2),
  );
  // Write the format marker last: an interrupted init is never an executable project.
  await atomicWritePrivate(resolve(base, 'pxv.project.json'), JSON.stringify(config, null, 2));
  return loadProject(base, product, codeRoot);
}

export async function loadProduct(path: string): Promise<ProductDescriptor> {
  return validateProduct(parseDocument(await readFile(path, 'utf8')));
}

export async function saveInventory(project: ProjectContext, inventory: Inventory): Promise<void> {
  await atomicWritePrivate(
    await containedPath(project.root, project.config.inventoryFile),
    JSON.stringify(validateInventory(inventory), null, 2),
  );
}

export async function writePolicyLock(project: ProjectContext): Promise<void> {
  const path = await containedPath(project.root, 'policy.lock.json', false);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWritePrivate(path, JSON.stringify(project.resolved, null, 2));
}
