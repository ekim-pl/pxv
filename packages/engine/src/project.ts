import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  parseDocument,
  resolvePolicy,
  validateInventory,
  validatePolicy,
  validatePolicyDocument,
  validateProduct,
  validateProject,
  type Inventory,
  type ExecutionPolicy,
  type PolicyDocument,
  type ProductDescriptor,
  type ProjectConfig,
  type ResolvedPolicy,
} from '@pxv/contracts';
import { atomicWritePrivate, commitProjectFile, hashFile, readBounded } from '@pxv/runtime';
import { fileURLToPath } from 'node:url';
import { engineIntegrity } from './integrity.js';

export interface ProjectContext {
  readonly root: string;
  readonly codeRoot?: string;
  readonly config: ProjectConfig;
  readonly product: ProductDescriptor;
  readonly policy: ExecutionPolicy;
  readonly inventory: Inventory;
  readonly resolved: ResolvedPolicy;
  readonly revisions: { config: string; policy: string; inventory: string };
}

async function readProjectValue<T>(
  base: string,
  path: string,
  limit: number,
  validate: (value: unknown) => T,
): Promise<{ value: T; revision: string }> {
  const bytes = await readBounded(await containedPath(base, path), limit);
  return {
    value: validate(parseDocument(bytes.toString('utf8'))),
    revision: createHash('sha256').update(bytes).digest('hex'),
  };
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
  const configFile = await readProjectValue(base, 'pxv.project.json', 1024 * 1024, validateProject);
  const config = configFile.value;
  if (config.productId !== product.id) throw new Error('Project belongs to a different product fork');
  const policyFile = await readProjectValue(base, config.policyFile, 4 * 1024 * 1024, validatePolicy);
  const inventoryFile = await readProjectValue(
    base,
    config.inventoryFile,
    4 * 1024 * 1024,
    validateInventory,
  );
  const policy = policyFile.value;
  const inventory = inventoryFile.value;
  return Object.freeze({
    root: base,
    codeRoot,
    config,
    product,
    policy,
    inventory,
    resolved: resolvePolicy(policy, config, product, await engineIntegrity(codeRoot)),
    revisions: {
      config: configFile.revision,
      policy: policyFile.revision,
      inventory: inventoryFile.revision,
    },
  });
}

export async function assertProjectFresh(project: ProjectContext): Promise<void> {
  const sources = [
    { path: 'pxv.project.json', expected: project.revisions.config },
    { path: project.config.policyFile, expected: project.revisions.policy },
    { path: project.config.inventoryFile, expected: project.revisions.inventory },
  ];
  for (const source of sources)
    if ((await hashFile(await containedPath(project.root, source.path))) !== source.expected)
      throw new Error('Project source changed; reload and prepare a new reviewed plan');
  const codeRoot = project.codeRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  if ((await engineIntegrity(codeRoot)) !== project.resolved.engineDigest)
    throw new Error('Executable build changed; reload and prepare a new reviewed plan');
}

export async function createProject(
  root: string,
  product: ProductDescriptor,
  policy: PolicyDocument,
  codeRoot?: string,
): Promise<ProjectContext> {
  validateProduct(product);
  const policyDocument = validatePolicyDocument(policy);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  for (const name of [
    'pxv.project.json',
    'policy.json',
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
    policyFile: 'policy.json',
    inventoryFile: 'inventory.json',
    extensions: [],
  };
  await atomicWritePrivate(resolve(base, 'policy.json'), JSON.stringify(policyDocument, null, 2));
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
  await commitProjectFile({
    projectId: project.config.id,
    path: await containedPath(project.root, project.config.inventoryFile),
    expectedSha256: project.revisions.inventory,
    expectedSources: [
      { path: await containedPath(project.root, 'pxv.project.json'), sha256: project.revisions.config },
    ],
    data: JSON.stringify(validateInventory(inventory), null, 2),
  });
}

export async function writePolicyLock(project: ProjectContext): Promise<void> {
  const path = await containedPath(project.root, 'policy.lock.json', false);
  const expectedSha256 = await hashFile(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  await commitProjectFile({
    projectId: project.config.id,
    path,
    expectedSha256,
    expectedSources: [
      { path: await containedPath(project.root, 'pxv.project.json'), sha256: project.revisions.config },
      {
        path: await containedPath(project.root, project.config.policyFile),
        sha256: project.revisions.policy,
      },
      {
        path: await containedPath(project.root, project.config.inventoryFile),
        sha256: project.revisions.inventory,
      },
    ],
    data: JSON.stringify(project.resolved, null, 2),
  });
}
