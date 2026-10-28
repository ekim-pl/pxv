import { type AndroidAdapter } from '@pxv/adapters';
import type { ProductDescriptor } from '@pxv/contracts';
import { loadProduct, loadProject, WorkflowEngine } from '@pxv/engine';
import { type CommandRunner, hostControlRoot, SqliteStore } from '@pxv/runtime';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactPort } from './artifact-port.js';
import { createDependencies } from './dependencies.js';
import { createWorkflowPort } from './workflow-port.js';
import { createSeedvaultPort } from './seedvault-port.js';
import { disposeApplication } from './application-disposal.js';
export async function resourceRoot(explicit?: string): Promise<string> {
  if (explicit) return realpath(resolve(explicit));
  const candidates = [
    process.env['PXV_RESOURCE_ROOT'],
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    dirname(fileURLToPath(import.meta.url)),
  ];
  for (const path of candidates)
    if (
      path &&
      (await access(join(path, 'product.json')).then(
        () => true,
        () => false,
      ))
    )
      return realpath(path);
  throw new Error('Installed product resources are missing');
}

export async function productAt(root: string): Promise<ProductDescriptor> {
  return loadProduct(join(root, 'product.json'));
}
async function verifyExtensions(
  project: Awaited<ReturnType<typeof loadProject>>,
  required: boolean,
): Promise<void> {
  if (!required || !project.config.extensions.length) return;
  if (project.product.features?.extensions === false)
    throw new Error(
      'This core product cannot execute projects with extensions; remove them explicitly or use an extension-enabled product',
    );
  const { ExtensionManager } = await import('@pxv/extensions');
  const manager = new ExtensionManager({
    installRoot:
      process.env['PXV_EXTENSION_ROOT'] ??
      join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share'), 'pxv/extensions'),
  });
  for (const extension of project.config.extensions) await manager.inspect(extension);
}

export interface ApplicationOptions {
  readOnly?: boolean;
  verifyInstalledExtensions?: boolean;
}
export async function application(
  root: string,
  resources: string,
  options: ApplicationOptions = {},
): Promise<{ engine: WorkflowEngine; store: SqliteStore; runner: CommandRunner; android: AndroidAdapter }> {
  const { readOnly = false, verifyInstalledExtensions = !readOnly } = options;
  const product = await productAt(resources);
  const project = await loadProject(root, product, resources);
  await verifyExtensions(project, verifyInstalledExtensions);
  const database = join(project.root, 'state/pxv.sqlite3');
  await access(database); // Only project init may create a database.
  const store = await SqliteStore.open(database, { readOnly });

  try {
    const deps = await createDependencies(project, resources, store);
    return {
      engine: new WorkflowEngine({
        project,
        store,
        port: createWorkflowPort(deps),
        ...(product.features?.seedvault === false ? {} : { seedvault: createSeedvaultPort(deps) }),
        artifacts: createArtifactPort(deps),
        controlRoot: hostControlRoot(),
      }),
      store,
      runner: deps.runner,
      android: deps.android,
    };
  } catch (error) {
    await disposeApplication(store, { error });
    throw error;
  }
}
export function redact(value: unknown, serials: string[]): unknown {
  if (typeof value === 'string')
    return serials.reduce((result, serial) => result.replaceAll(serial, '<device-serial>'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, serials));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['path', 'installPath', 'canonicalSerial'].includes(key))
        .map(([key, item]) => [key, redact(item, serials)]),
    );
  return value;
}
