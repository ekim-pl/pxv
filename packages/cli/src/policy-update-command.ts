import {
  AndroidAdapter,
  ArtifactService,
  HostTools,
  RepositoryService,
  type CandidateDevice,
} from '@pxv/adapters';
import { parseDocument, validatePolicyDocument, type PolicyDocument } from '@pxv/contracts';
import { containedPath, loadProject, type ProjectContext } from '@pxv/engine';
import { CommandRunner, SqliteStore, commitProjectFile, readBounded } from '@pxv/runtime';
import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { confirmation, type CliContext } from './arguments.js';
import { planAppUpdates, type AppUpdateServices } from './policy-app-updates.js';
import { explicitAppCompatibility } from './policy-update-options.js';
import { selectedContext } from './selection.js';

interface PolicyInput {
  path: string;
  document: PolicyDocument;
  revision: string;
  project?: ProjectContext;
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function policyInput(context: CliContext): Promise<PolicyInput> {
  const standalone = typeof context.values['policy'] === 'string';
  const project = standalone
    ? undefined
    : await loadProject(context.projectRoot, context.product, context.resources);
  const requested = standalone
    ? resolve(context.value('policy'))
    : await containedPath(project!.root, project!.config.policyFile);
  const path = join(await realpath(dirname(requested)), basename(requested));
  const bytes = await readBounded(path, 4 * 1024 * 1024);
  const revision = hash(bytes);
  if (project && revision !== project.revisions.policy)
    throw new Error('Project policy changed; reload before updating');
  const document = parseDocument(bytes.toString('utf8'));
  validatePolicyDocument(document);
  // Keep authored omissions and ordering rather than inserting the validator's defaults.
  return { path, revision, document: document as PolicyDocument, ...(project ? { project } : {}) };
}

async function openFreshnessStore(project: ProjectContext | undefined): Promise<SqliteStore | undefined> {
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

async function updateServices(
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

async function appCompatibility(
  context: CliContext,
  input: PolicyInput,
  services: AppUpdateServices,
  signal: AbortSignal,
): Promise<CandidateDevice> {
  if (context.values['asset'] === undefined)
    return explicitAppCompatibility(context.value('sdk'), context.value('abi'));
  if (!input.project) throw new Error('Device selection requires a project');
  const [target] = selectedContext(context, input.project).targets();
  if (!target) throw new Error('Select one enrolled asset');
  const android = new AndroidAdapter({ runner: services.runner, adb: await services.tools.require('adb') });
  await android.guardTarget(target, signal);
  const sdk = await android.shell(target, ['getprop', 'ro.build.version.sdk'], { signal });
  const abi = await android.shell(target, ['getprop', 'ro.product.cpu.abilist'], { signal });
  return explicitAppCompatibility(sdk.trim(), abi.trim());
}

async function writeUpdatedPolicy(
  input: PolicyInput,
  policy: PolicyDocument,
  signal: AbortSignal,
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
  await commitProjectFile({
    signal,
    projectId: project?.config.id ?? hash(input.path),
    path: input.path,
    expectedSha256: input.revision,
    expectedSources,
    data,
  });
}

async function updateApps(context: CliContext, signal: AbortSignal): Promise<number> {
  const input = await policyInput(context);
  const store = await openFreshnessStore(input.project);
  try {
    const services = await updateServices(context, store);
    const compatibility = await appCompatibility(context, input, services, signal);
    const { policy, ...changes } = await planAppUpdates(input.document, services, compatibility, signal);
    validatePolicyDocument(policy);
    const dryRun = context.flag('dry-run');
    const written = changes.updates.length > 0 && !dryRun;
    if (written) {
      context.io.out(`Proposed app updates:\n${JSON.stringify(changes, null, 2)}`);
      await confirmation(
        context.io,
        `Write ${changes.updates.length} verified app update(s) to ${input.path}?`,
        context.flag('yes'),
        signal,
      );
      signal.throwIfAborted();
      await writeUpdatedPolicy(input, policy, signal);
    }
    if (!written) signal.throwIfAborted();
    context.output({
      policyFile: input.path,
      dryRun,
      written,
      ...changes,
      policyLockRequired: written && input.project !== undefined,
      ...(written && input.project
        ? {
            nextSteps: [
              {
                description: 'Validate and lock the edited policy, then prepare and review a fresh plan.',
                command: ['policy', 'validate'],
              },
              { command: ['policy', 'lock'] },
            ],
          }
        : {}),
    });
    return 0;
  } finally {
    await store?.close();
  }
}

export async function policyUpdateCommand(context: CliContext): Promise<number> {
  if (context.dockerMode !== undefined) throw new Error('Policy app updates require local host execution');
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Operator interrupted policy app update'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await updateApps(context, controller.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
