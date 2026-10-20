import { loadProject } from '@pxv/engine';
import {
  introductoryCommand,
  parseCli,
  workerLauncher,
  type ApplicationCliContext,
  type CliContext,
  type CliIo,
  type ProjectCliContext,
} from './arguments.js';
import { application } from './context.js';
import { deviceCommand } from './device-command.js';
import { runInDocker } from './docker.js';
import { guidesRebuildCommand } from './guide-rebuild-command.js';
import { handoffCommand, lifecycleCommand } from './handoff-command.js';
import { hostCommand } from './host-command.js';
import { inventoryCommand } from './inventory-command.js';
import { mcpCommand } from './mcp-command.js';
import { initializeProject, policyCommand, projectGuide, staticGuide } from './project-command.js';
import { agentCommand, internalWorker } from './run-command.js';
import { selectedContext } from './selection.js';
import { assertExtensionExecution } from './command-registry.js';
export type { CliIo } from './arguments.js';
async function externalCommand(context: CliContext): Promise<number | undefined> {
  const { section, command } = context;
  const guides = await guidesRebuildCommand(context);
  if (guides !== undefined) return guides;
  const delegated = await executionMode(context);
  if (delegated !== undefined) return delegated;
  if (section === 'guide' && command !== 'project') return staticGuide(context);
  if (section === 'host') return hostCommand(context);
  return initializeProject(context);
}
async function projectCommand(context: ProjectCliContext): Promise<number | undefined> {
  const { section } = context;
  if (section === 'guide') return projectGuide(context);
  if (section === 'policy') return policyCommand(context);
  if (section === 'inventory') return inventoryCommand(context);
  if (section === 'registry') return (await import('./registry-command.js')).registryCommand(context);
  if (section === 'extension') return (await import('./extension-command.js')).extensionCommand(context);
  return mcpCommand(context);
}
async function applicationCommand(context: ApplicationCliContext): Promise<number> {
  const { section } = context;
  if (section === 'internal-worker') return internalWorker(context);
  if (section === 'agent') return agentCommand(context);
  if (section === 'seedvault') return (await import('./seedvault-command.js')).seedvaultCommand(context);
  if (section === 'lifecycle') return lifecycleCommand(context);
  if (section === 'handoff') {
    const result = await handoffCommand(context);
    if (result !== undefined) return result;
  }
  return deviceCommand(context);
}
async function usingApplication(context: ProjectCliContext): Promise<number> {
  const { projectRoot, resources } = context;
  const recovery =
    context.command === 'recover' ||
    (context.section === 'agent' && context.command === 'cancel') ||
    (context.section === 'seedvault' && context.command === 'disconnect');
  const app = recovery
    ? await application(projectRoot, resources, readOnlyCommand(context), true)
    : await application(projectRoot, resources, readOnlyCommand(context));
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Operator interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await applicationCommand({
      ...context,
      app,
      signal: controller.signal,
      launcher: await workerLauncher(),
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await app.store.close();
  }
}
function readOnlyCommand({ section, command }: ProjectCliContext): boolean {
  const commands: Record<string, readonly string[]> = {
    agent: ['runs', 'status'],
    device: ['report', 'inspect'],
    fleet: ['report', 'inspect'],
    seedvault: ['inspect', 'report', 'connections'],
    handoff: ['export'],
  };
  return commands[section ?? '']?.includes(command ?? '') ?? false;
}
export async function runCli(argv: string[], io?: CliIo): Promise<number> {
  const context = await parseCli(argv, io);
  try {
    const early = introductoryCommand(context) ?? (await externalCommand(context));
    if (early !== undefined) return early;
    const project = await loadProject(context.projectRoot, context.product, context.resources);
    const selected = selectedContext(context, project);
    return (await projectCommand(selected)) ?? (await usingApplication(selected));
  } finally {
    context.flushOutput();
  }
}

async function executionMode(context: CliContext): Promise<number | undefined> {
  const { argv, value, projectRoot, extensionRoot } = context;
  const execution = value('execution', 'host');
  validateExecutionMode(context, execution);
  assertExtensionExecution(
    [context.section ?? '', context.command ?? ''],
    execution === 'docker' || context.dockerMode !== undefined,
  );
  assertLocalCollection(context, execution);
  if (execution === 'docker') {
    const mode = value('docker-mode', 'host-adb');
    if (mode !== 'direct' && mode !== 'host-adb') throw new Error('Invalid Docker transport mode');
    return runInDocker(argv, projectRoot, value('image'), mode, extensionRoot);
  }
  assertDirectFlash(context);

  return undefined;
}
function validateExecutionMode(context: CliContext, execution: string): void {
  const { dockerMode } = context;
  if (dockerMode !== undefined && dockerMode !== 'direct' && dockerMode !== 'host-adb')
    throw new Error('Invalid Docker worker mode');
  if (execution !== 'host' && execution !== 'docker') throw new Error('Execution must be host or docker');
  const hostOnly: Record<string, string> = {
    seedvault: 'Personal Seedvault workflows require host execution',
    registry: 'The encrypted phone registry requires local host execution',
  };
  const reason = hostOnly[context.section ?? ''];
  if (reason && (execution === 'docker' || dockerMode)) throw new Error(reason);
}

function assertLocalCollection(context: CliContext, execution: string): void {
  if (
    ['collect-oblivion', 'collect-sessionid', 'collect-simcards'].includes(context.command ?? '') &&
    (execution === 'docker' || context.dockerMode)
  )
    throw new Error('Private collection requires local host execution');
}

function assertDirectFlash({ dockerMode, section, command }: CliContext): void {
  if (dockerMode === 'host-adb' && ['device', 'fleet'].includes(section ?? '') && command === 'install-os')
    throw new Error('Fastboot requires direct USB mode');
}
