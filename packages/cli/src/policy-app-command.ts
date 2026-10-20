import {
  AndroidAdapter,
  ArtifactService,
  HostTools,
  RepositoryService,
  type CandidateDevice,
} from '@pxv/adapters';
import { parseDocument, type PolicyDocument } from '@pxv/contracts';
import { containedPath, loadProjectSources, type ProjectSources } from '@pxv/engine';
import { CommandRunner, SqliteStore, commitProjectFile, readBounded } from '@pxv/runtime';
import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type CliContext } from './arguments.js';
import { type AppUpdateServices } from './policy-app-updates.js';
import { explicitAppCompatibility } from './policy-update-options.js';
import { selectedTargets } from './selection.js';

export interface PolicyInput<T> {
  path: string;
  document: T;
  revision: string;
  project?: ProjectSources;
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

export async function policyInput<T>(
  context: CliContext,
  validate: (value: unknown) => T,
): Promise<PolicyInput<T>> {
  const standalone = typeof context.values['policy'] === 'string';
  const project = standalone
    ? undefined
    : await loadProjectSources(context.projectRoot, context.product, context.resources);
  const requested = standalone
    ? resolve(context.value('policy'))
    : await containedPath(project!.root, project!.config.policyFile);
  const path = join(await realpath(dirname(requested)), basename(requested));
  const bytes = await readBounded(path, 4 * 1024 * 1024);
  const revision = hash(bytes);
  if (project && revision !== project.revisions.policy)
    throw new Error('Project policy changed; reload before updating');
  const document = parseDocument(bytes.toString('utf8'));
  validate(document);
  // Keep authored omissions and ordering rather than inserting the validator's defaults.
  return { path, revision, document: document as T, ...(project ? { project } : {}) };
}

export async function openFreshnessStore(
  project: ProjectSources | undefined,
): Promise<SqliteStore | undefined> {
  if (!project) return undefined;
  const path = await containedPath(project.root, 'state/pxv.sqlite3', false);
  const exists = await access(path).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
  return exists ? SqliteStore.open(path, { readOnly: true }) : undefined;
}

export async function updateServices(
  context: CliContext,
  store: SqliteStore | undefined,
): Promise<AppUpdateServices> {
  const runner = new CommandRunner();
  const tools = new HostTools({ runner });
  const pathFor = async (name: 'aapt' | 'apksigner' | 'java'): Promise<string> =>
    (await tools.discover(name)) ?? name;
  const artifacts = new ArtifactService({
    runner,
    aapt: await pathFor('aapt'),
    apksigner: await pathFor('apksigner'),
  });
  const repositories = new RepositoryService({
    runner,
    java: await pathFor('java'),
    verifierPath: join(context.resources, 'resources/VerifyRepositoryIndex.java'),
    freshness: {
      read: (key) => (store ? store.get('repository-freshness', key) : Promise.resolve(undefined)),
      advance: () => {
        throw new Error('Policy discovery cannot advance execution freshness state');
      },
    },
  });
  return { runner, tools, artifacts, repositories };
}

export async function appCompatibility(
  context: CliContext,
  input: PolicyInput<unknown>,
  services: AppUpdateServices,
  signal: AbortSignal,
): Promise<CandidateDevice> {
  if (context.values['asset'] === undefined)
    return explicitAppCompatibility(context.value('sdk'), context.value('abi'));
  if (!input.project) throw new Error('Device selection requires a project');
  const [target] = selectedTargets(context, input.project.inventory);
  if (!target) throw new Error('Select one enrolled asset');
  const android = new AndroidAdapter({ runner: services.runner, adb: await services.tools.require('adb') });
  await android.guardTarget(target, signal);
  const sdk = await android.shell(target, ['getprop', 'ro.build.version.sdk'], { signal });
  const abi = await android.shell(target, ['getprop', 'ro.product.cpu.abilist'], { signal });
  return explicitAppCompatibility(sdk.trim(), abi.trim());
}

export async function writeUpdatedPolicy(
  input: PolicyInput<unknown>,
  policy: PolicyDocument,
  signal: AbortSignal,
  destination: { path: string; revision: string | undefined } = input,
): Promise<void> {
  const data = `${JSON.stringify(policy, null, 2)}\n`;
  if (Buffer.byteLength(data) > 4 * 1024 * 1024)
    throw new Error('Updated policy exceeds the 4 MiB policy file limit');
  const project = input.project;
  const expectedSources = project
    ? [
        { path: await containedPath(project.root, 'pxv.project.json'), sha256: project.revisions.config },
        {
          path: await containedPath(project.root, project.config.inventoryFile),
          sha256: project.revisions.inventory,
        },
      ]
    : [];
  if (destination.path !== input.path) expectedSources.push({ path: input.path, sha256: input.revision });
  await commitProjectFile({
    signal,
    projectId: project?.config.id ?? hash(input.path),
    path: destination.path,
    expectedSha256: destination.revision,
    expectedSources,
    data,
  });
}

export async function withAppCommandSignal(
  context: CliContext,
  action: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  if (context.dockerMode !== undefined) throw new Error('Policy app discovery requires local host execution');
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Operator interrupted policy app discovery'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await action(controller.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
