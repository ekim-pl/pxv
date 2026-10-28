import { assertCommandFeature } from './command-registry.js';
import { parseDocument, validateProject, type ExtensionLock } from '@pxv/contracts';
import { containedPath, assertFinalizationResolved } from '@pxv/engine';
import { ExtensionManager, type ExtensionSource } from '@pxv/extensions';
import { commitProjectFile, readBounded } from '@pxv/runtime';
import { join, resolve } from 'node:path';
import type { ProjectCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { application } from './context.js';
import { usingApplicationStore } from './application-disposal.js';

async function writeExtensions(context: ProjectCliContext, extensions: ExtensionLock[]): Promise<void> {
  const { project } = context;
  const config = validateProject({ ...project.config, extensions });
  await commitProjectFile({
    projectId: project.config.id,
    path: join(project.root, 'pxv.project.json'),
    expectedSha256: project.revisions.config,
    data: JSON.stringify(config, null, 2),
  });
}
async function install(
  context: ProjectCliContext,
  manager: ExtensionManager,
  lock: ExtensionLock | undefined,
): Promise<number> {
  const { values, value, io, flag, command, project, output } = context;
  const source: ExtensionSource = values['file']
    ? { tarball: resolve(value('file')) }
    : { package: value('package'), version: value('version') };
  await confirmation(
    io,
    'Install this trusted extension and invalidate existing policy approvals?',
    flag('yes'),
  );
  if (command === 'update' && !lock) throw new Error('Select an installed extension to update');
  const installed =
    command === 'update' && lock ? await manager.update(lock, source) : await manager.install(source);
  await writeExtensions(context, [
    ...project.config.extensions.filter((item) => item.id !== installed.id),
    installed,
  ]);
  output(installed);
  return 0;
}
async function selectPolicy(
  context: ProjectCliContext,
  manager: ExtensionManager,
  lock: ExtensionLock,
): Promise<number> {
  const { value, io, flag, project, output } = context;
  const policy = await manager.readContribution(lock, 'policyPacks', value('contribution'));
  await confirmation(
    io,
    'Select this extension policy and invalidate existing policy approvals?',
    flag('yes'),
  );
  await commitProjectFile({
    projectId: project.config.id,
    path: await containedPath(project.root, project.config.policyFile),
    expectedSha256: project.revisions.policy,
    expectedSources: [
      { path: await containedPath(project.root, 'pxv.project.json'), sha256: project.revisions.config },
    ],
    data: JSON.stringify(policy, null, 2),
  });
  output({ selectedPolicy: policy.id, extension: lock.id, policyLockRequired: true });
  return 0;
}
async function remove(context: ProjectCliContext, lock: ExtensionLock): Promise<number> {
  await confirmation(context.io, 'Remove this extension from the project lock?', context.flag('yes'));
  await writeExtensions(
    context,
    context.project.config.extensions.filter((item) => item.id !== lock.id),
  );
  context.output({ removedFromProject: lock.id, retainedInSharedStore: true });
  return 0;
}
async function invoke(
  context: ProjectCliContext,
  manager: ExtensionManager,
  lock: ExtensionLock,
): Promise<number> {
  const { values, value, command, projectRoot, resources, targets, output } = context;
  const input: unknown = values['input-file']
    ? parseDocument((await readBounded(value('input-file'), 1024 * 1024)).toString('utf8'))
    : {};
  const app = await application(projectRoot, resources);
  await usingApplicationStore(app.store, async () => {
    const target = targets()[0];
    if (!target) throw new Error('Select an asset');
    await assertFinalizationResolved(app.store, target.device.assetId);
    const actions =
      command === 'adapter'
        ? await manager.invokeAdapter(lock, value('contribution'), input)
        : await manager.invoke(lock, value('command'), input);
    const prepared = await app.engine.prepareExtension(target, actions);
    output({
      planId: prepared.plan.id,
      reviewSummary: prepared.reviewSummary,
      expiresAt: prepared.expiresAt,
    });
  });
  return 0;
}
export async function extensionCommand(context: ProjectCliContext): Promise<number> {
  const { value, command, project, output, io } = context;
  assertCommandFeature(['extension', String(context.command)], context.product);
  const manager = extensionManager(context);
  if (command === 'list') {
    output(await manager.list());
    return 0;
  }
  const lock = project.config.extensions.find((item) => item.id === value('extension', ''));
  if (command === 'install' || command === 'update') return install(context, manager, lock);
  if (!lock) throw new Error('Extension is not pinned in this project');
  if (command === 'guide') {
    io.out(await manager.readContribution(lock, 'guides', value('contribution')));
    return 0;
  }
  if (command === 'inspect') {
    output(await manager.inspect(lock));
    return 0;
  }
  if (command === 'policy') return selectPolicy(context, manager, lock);
  if (command === 'remove') return remove(context, lock);
  if (['invoke', 'adapter'].includes(String(command))) return invoke(context, manager, lock);
  throw new Error('Unknown extension command');
}

function extensionManager(context: ProjectCliContext): ExtensionManager {
  const { extensionRoot, values, value } = context;
  const manager = new ExtensionManager({
    installRoot: extensionRoot,
    ...(values['registry'] ? { registry: value('registry') } : {}),
    ...(process.env['PXV_REGISTRY_TOKEN'] ? { token: process.env['PXV_REGISTRY_TOKEN'] } : {}),
  });

  return manager;
}
