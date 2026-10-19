import { resolveSelection, validateProject } from '@pxv/contracts';
import {
  containedPath,
  recordLifecycle,
  type PreparedOperation,
  type RunRecord,
  type WorkflowEngine,
} from '@pxv/engine';
import { ExtensionManager } from '@pxv/extensions';
import type { AgentBackend } from '@pxv/mcp';
import { commitProjectFile } from '@pxv/runtime';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { application, redact } from './context.js';
import { inspectHost } from './host.js';

function extensionManager(registry?: string): ExtensionManager {
  return new ExtensionManager({
    installRoot:
      process.env['PXV_EXTENSION_ROOT'] ??
      join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share'), 'pxv/extensions'),
    ...(registry ? { registry } : {}),
    ...(process.env['PXV_REGISTRY_TOKEN'] ? { token: process.env['PXV_REGISTRY_TOKEN'] } : {}),
  });
}
function requireExtensions(engine: WorkflowEngine): void {
  if (engine.project.product.features?.extensions === false)
    throw new Error('Extensions are outside this core product; use an extension-enabled product');
}
function backendContext(engine: WorkflowEngine, allowMutations: boolean) {
  const serials = engine.project.inventory.devices.flatMap((value) => [
    value.canonicalSerial,
    ...value.transports.map((transport) => transport.serial),
  ]);
  const publicValue = (value: unknown): unknown => redact(value, serials);
  const select = (assetId: string) => {
    const target = resolveSelection(engine.project.inventory, { kind: 'asset', assetId })[0];
    if (!target) throw new Error('Unknown asset');
    return target;
  };
  const requireMutation = (): void => {
    if (!allowMutations) throw new Error('Reviewed mutations are disabled');
  };
  const requireReview = (reviewed: boolean): void => {
    requireMutation();
    if (reviewed !== true) throw new Error('Explicit review confirmation is required');
  };

  const pinned = (id: string) => {
    const lock = engine.project.config.extensions.find((value) => value.id === id);
    if (!lock) throw new Error('Extension is not pinned in this project');
    return lock;
  };
  const review = (prepared: {
    plan: { id: string };
    reviewSummary: string;
    expiresAt: string;
    capabilities?: PreparedOperation['capabilities'];
  }) => ({
    planId: prepared.plan.id,
    reviewSummary: prepared.reviewSummary,
    expiresAt: prepared.expiresAt,
    ...(prepared.capabilities ? { capabilities: prepared.capabilities } : {}),
  });
  const writeConfig = async (extensions: typeof engine.project.config.extensions): Promise<void> => {
    const config = validateProject({ ...engine.project.config, extensions });
    await commitProjectFile({
      controlRoot: engine.controlRoot,
      projectId: engine.project.config.id,
      path: await containedPath(engine.project.root, 'pxv.project.json'),
      expectedSha256: engine.project.revisions.config,
      data: JSON.stringify(config, null, 2),
    });
  };

  return {
    engine,
    allowMutations,
    publicValue,
    select,
    requireMutation,
    requireReview,
    pinned,
    review,
    writeConfig,
  };
}
type BackendContext = ReturnType<typeof backendContext>;

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  for (const name of [
    'NODE_V8_COVERAGE',
    'HOME',
    'XDG_STATE_HOME',
    'PXV_CONTROL_ROOT',
    'PXV_SUPERVISOR',
    'ANDROID_HOME',
    'PXV_ANDROID_HOME',
    'PXV_JAVA_HOME',
    'JAVA_HOME',
    'XDG_DATA_HOME',
    'PXV_ADB_VENDOR_KEYS',
    'PXV_HOST_ADB_HOST',
    'PXV_HOST_ADB_PORT',
    'PXV_DOCKER_MODE',
    'PXV_ADB_SERVER_SOCKET',
    'PXV_EXTENSION_ROOT',
    'PXV_TOOL_ADB',
    'PXV_TOOL_FASTBOOT',
    'PXV_TOOL_AAPT',
    'PXV_TOOL_APKSIGNER',
    'PXV_TOOL_JAVA',
    'PXV_TOOL_FDROIDCL',
    'PXV_TOOL_SSH_KEYGEN',
    'PXV_BUILD_TOOLS',
    'PXV_TOOLS_DIR',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }

  return env;
}
function acknowledgeStartup(child: ReturnType<typeof spawn>, runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Detached worker did not acknowledge startup'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Detached worker exited before startup'));
    });
    child.on('message', (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'ready' &&
        'runId' in message &&
        message.runId === runId
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
async function launchWorker(
  engine: WorkflowEngine,
  resources: string,
  launcher: string,
  run: RunRecord,
): Promise<void> {
  const env = workerEnvironment();
  const child = spawn(
    process.execPath,
    [
      launcher,
      'internal-worker',
      '--project-root',
      engine.project.root,
      '--resource-root',
      resources,
      '--run',
      run.id,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env },
  );
  try {
    await acknowledgeStartup(child, run.id);
  } catch (error) {
    await engine.store.set('runs', run.id, {
      ...run,
      status: 'needs-inspection',
      error: 'Detached worker startup failed; inspect before a fresh review',
    });
    throw error;
  }
  child.unref();
}

function readBackend(
  context: BackendContext,
  resources: string,
): Pick<AgentBackend, 'inspectHost' | 'listDevices' | 'inspectDevice' | 'getRun' | 'listRuns' | 'guide'> {
  const { engine, publicValue, select } = context;

  return {
    inspectHost,
    listDevices() {
      return Promise.resolve(publicValue({ devices: engine.project.inventory.devices }));
    },
    async inspectDevice(assetId) {
      return publicValue(await engine.observe(select(assetId)));
    },
    async getRun(runId, after) {
      return publicValue(await engine.runStatus(runId, after));
    },
    async listRuns(options) {
      return publicValue(await engine.listRuns(options));
    },
    async guide(name) {
      return readFile(
        join(resources, 'guides/source/markdown', name === 'operator' ? 'operator-en.md' : 'user-en.md'),
        'utf8',
      );
    },
  };
}
function workflowBackend(
  context: BackendContext,
  resources: string,
  launcher: string,
): Pick<
  AgentBackend,
  | 'prepareOperation'
  | 'executePlan'
  | 'cancelRun'
  | 'attestDevice'
  | 'finalizeDevice'
  | 'confirmCustody'
  | 'recoverDevice'
  | 'recordLifecycle'
  | 'refreshReview'
> {
  const { engine, allowMutations, publicValue, select, requireMutation, requireReview, review } = context;

  return {
    async prepareOperation(assetId, operation) {
      const prepared = await engine.prepare(select(assetId), operation);
      return review(prepared);
    },
    async executePlan(planId, reviewSummary, operator) {
      if (!allowMutations) throw new Error('Reviewed mutations are disabled');
      const run = await engine.submit(planId, reviewSummary, operator);
      const retained = await engine.store.get<RunRecord & { manualGate?: string }>('runs', run.id);
      if (run.status === 'queued' || (run.status === 'pending' && retained?.manualGate)) {
        const claimed = await engine.store.compareAndSet('worker-launch', run.id, undefined, {
          claimedAt: new Date().toISOString(),
        });
        if (!claimed) return publicValue(await engine.describeRun(run));
        await launchWorker(engine, resources, launcher, run);
      }
      return publicValue(await engine.describeRun(run));
    },
    async cancelRun(runId) {
      if (!allowMutations) throw new Error('Explicit cancellation requires mutations enabled');
      await engine.cancel(runId);
      return { requested: true, runId };
    },
    async attestDevice(assetId, check, operator, note, evidence) {
      requireMutation();
      return publicValue(await engine.attest(select(assetId), check, operator, note, evidence));
    },
    async finalizeDevice(assetId, operator, locale) {
      requireMutation();
      return publicValue(await engine.finalize(select(assetId), operator, locale));
    },
    async confirmCustody(assetId, recipient, debuggingOff) {
      requireMutation();
      select(assetId);
      return publicValue(await engine.acceptCustody(assetId, recipient, debuggingOff));
    },
    async recoverDevice(assetId, runId, inspected) {
      requireReview(inspected);
      return publicValue(await engine.recover(select(assetId), runId));
    },
    async recordLifecycle(input) {
      requireMutation();
      select(input.assetId);
      return publicValue(
        await recordLifecycle(engine.project, engine.store, input, undefined, engine.controlRoot),
      );
    },
    async refreshReview(runId) {
      requireMutation();
      return review(await engine.refreshReview(runId));
    },
  };
}
function readExtensions(
  context: BackendContext,
): Pick<
  AgentBackend,
  'extensionList' | 'extensionInspect' | 'extensionGuide' | 'extensionAdapter' | 'extensionCommand'
> {
  const { engine, publicValue, select, requireMutation, pinned, review } = context;
  const manager = extensionManager;
  return {
    async extensionList() {
      return publicValue(await manager().list());
    },
    async extensionInspect(id) {
      return publicValue(await manager().inspect(pinned(id)));
    },
    async extensionGuide(id, contribution) {
      return manager().readContribution(pinned(id), 'guides', contribution);
    },
    async extensionAdapter(assetId, id, contribution, input) {
      requireMutation();
      requireExtensions(engine);
      const actions = await manager().invokeAdapter(pinned(id), contribution, input);
      return review(await engine.prepareExtension(select(assetId), actions));
    },
    async extensionCommand(assetId, id, command, input) {
      requireMutation();
      requireExtensions(engine);
      const actions = await manager().invoke(pinned(id), command, input);
      return review(await engine.prepareExtension(select(assetId), actions));
    },
  };
}
function writeExtensions(
  context: BackendContext,
): Pick<AgentBackend, 'extensionInstall' | 'extensionUpdate' | 'extensionRemove' | 'extensionPolicy'> {
  const { engine, publicValue, requireReview, pinned, writeConfig } = context;
  const manager = extensionManager;
  return {
    async extensionInstall(source, reviewed, registry) {
      requireReview(reviewed);
      requireExtensions(engine);
      const installed = await manager(registry).install(source);
      await writeConfig([
        ...engine.project.config.extensions.filter((value) => value.id !== installed.id),
        installed,
      ]);
      return publicValue(installed);
    },
    async extensionUpdate(id, source, reviewed, registry) {
      requireReview(reviewed);
      requireExtensions(engine);
      const installed = await manager(registry).update(pinned(id), source);
      await writeConfig([...engine.project.config.extensions.filter((value) => value.id !== id), installed]);
      return publicValue(installed);
    },
    async extensionRemove(id, reviewed) {
      requireReview(reviewed);
      pinned(id);
      await writeConfig(engine.project.config.extensions.filter((value) => value.id !== id));
      return { removedFromProject: id, retainedInSharedStore: true };
    },
    async extensionPolicy(id, contribution, reviewed) {
      requireReview(reviewed);
      requireExtensions(engine);
      const policy = await manager().readContribution(pinned(id), 'policyPacks', contribution);
      await commitProjectFile({
        projectId: engine.project.config.id,
        path: await containedPath(engine.project.root, engine.project.config.policyFile),
        expectedSha256: engine.project.revisions.policy,
        expectedSources: [
          {
            path: await containedPath(engine.project.root, 'pxv.project.json'),
            sha256: engine.project.revisions.config,
          },
        ],
        data: JSON.stringify(policy, null, 2),
      });
      return { selectedPolicy: policy.id, extension: id, policyLockRequired: true };
    },
  };
}
export function agentBackend(
  engine: WorkflowEngine,
  resources: string,
  launcher: string,
  allowMutations: boolean,
): AgentBackend {
  const context = backendContext(engine, allowMutations);
  return {
    ...readBackend(context, resources),
    ...workflowBackend(context, resources, launcher),
    ...readExtensions(context),
    ...writeExtensions(context),
  };
}

/** A long-lived server reloads executable identity, policy and extension integrity for every tool. */
export function liveAgentBackend(
  root: string,
  resources: string,
  launcher: string,
  allowMutations: boolean,
): AgentBackend {
  const using = async <T>(
    action: (backend: AgentBackend) => Promise<T>,
    readOnly = false,
    verifyInstalled = true,
    recovery = false,
  ): Promise<T> => {
    const app = recovery
      ? await application(root, resources, readOnly, true)
      : await application(root, resources, readOnly);
    try {
      if (readOnly && verifyInstalled && app.engine.project.product.features?.extensions !== false)
        for (const extension of app.engine.project.config.extensions)
          await extensionManager().inspect(extension);
      return await action(agentBackend(app.engine, resources, launcher, allowMutations));
    } finally {
      await app.store.close();
    }
  };
  return {
    inspectHost: () => using((backend) => backend.inspectHost(), true),
    listDevices: () => using((backend) => backend.listDevices(), true),
    inspectDevice: (assetId) => using((backend) => backend.inspectDevice(assetId), true),
    prepareOperation: (assetId, operation) =>
      using((backend) => backend.prepareOperation(assetId, operation)),
    executePlan: (planId, summary, operator) =>
      using((backend) => backend.executePlan(planId, summary, operator)),
    getRun: (runId, after) => using((backend) => backend.getRun(runId, after), true),
    listRuns: (options) => using((backend) => backend.listRuns(options), true),
    cancelRun: (runId) => using((backend) => backend.cancelRun(runId), false, false, true),
    attestDevice: (assetId, check, operator, note, evidence) =>
      using((backend) => backend.attestDevice(assetId, check, operator, note, evidence)),
    finalizeDevice: (assetId, operator, locale) =>
      using((backend) => backend.finalizeDevice(assetId, operator, locale)),
    confirmCustody: (assetId, recipient, debuggingOff) =>
      using((backend) => backend.confirmCustody(assetId, recipient, debuggingOff)),
    recoverDevice: (assetId, runId, inspected) =>
      using((backend) => backend.recoverDevice(assetId, runId, inspected), false, false, true),
    recordLifecycle: (input) => using((backend) => backend.recordLifecycle(input)),
    refreshReview: (runId) => using((backend) => backend.refreshReview(runId)),
    extensionList: () => using((backend) => backend.extensionList(), true, false),
    extensionInspect: (id) => using((backend) => backend.extensionInspect(id), true, false),
    extensionInstall: (source, reviewed, registry) =>
      using((backend) => backend.extensionInstall(source, reviewed, registry), true, false),
    extensionUpdate: (id, source, reviewed, registry) =>
      using((backend) => backend.extensionUpdate(id, source, reviewed, registry), true, false),
    extensionRemove: (id, reviewed) => using((backend) => backend.extensionRemove(id, reviewed), true, false),
    extensionPolicy: (id, contribution, reviewed) =>
      using((backend) => backend.extensionPolicy(id, contribution, reviewed), true, false),
    extensionGuide: (id, contribution) =>
      using((backend) => backend.extensionGuide(id, contribution), true, false),
    extensionAdapter: (assetId, id, contribution, input) =>
      using((backend) => backend.extensionAdapter(assetId, id, contribution, input)),
    extensionCommand: (assetId, id, command, input) =>
      using((backend) => backend.extensionCommand(assetId, id, command, input)),
    guide: (name) => using((backend) => backend.guide(name), true),
  };
}
