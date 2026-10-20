import { validatePolicySourceDocument, type PolicyDocument } from '@pxv/contracts';
import { containedPath } from '@pxv/engine';
import { readBounded } from '@pxv/runtime';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { confirmation, type CliContext } from './arguments.js';
import {
  policyInput,
  openFreshnessStore,
  updateServices,
  appCompatibility,
  writeUpdatedPolicy,
  withAppCommandSignal,
  type PolicyInput,
} from './policy-app-command.js';
import { planAppResolutions } from './policy-app-resolutions.js';

async function outputTarget(
  context: CliContext,
  input: PolicyInput<unknown>,
): Promise<{
  path: string;
  revision: string | undefined;
}> {
  if (context.values['output'] === undefined) return input;
  const requested = resolve(context.value('output'));
  const path = join(await realpath(dirname(requested)), basename(requested));
  if (input.project) {
    for (const name of ['pxv.project.json', input.project.config.inventoryFile, 'policy.lock.json'])
      if (path === (await containedPath(input.project.root, name, false)))
        throw new Error('--output cannot replace project configuration, inventory, or policy lock');
  }
  const bytes = await readBounded(path, 4 * 1024 * 1024).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return {
    path,
    revision: bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex'),
  };
}

function resolutionNextSteps(lockRequired: boolean, separate: boolean): object {
  if (lockRequired)
    return {
      nextSteps: [
        {
          description: 'Validate and lock the resolved policy, then prepare and review a fresh plan.',
          command: ['policy', 'validate'],
        },
        { command: ['policy', 'lock'] },
      ],
    };
  if (separate)
    return {
      nextSteps: [
        {
          description:
            'Use or adopt the resolved policy file; validate and lock it before preparing a fresh plan.',
        },
      ],
    };
  return {};
}

function needsWrite(
  inputPath: string,
  destination: { path: string; revision: string | undefined },
  policy: PolicyDocument,
  resolutions: number,
): boolean {
  const data = `${JSON.stringify(policy, null, 2)}\n`;
  const outputRevision = createHash('sha256').update(data).digest('hex');
  const changed = destination.path === inputPath ? resolutions > 0 : outputRevision !== destination.revision;
  if (changed && Buffer.byteLength(data) > 4 * 1024 * 1024)
    throw new Error('Resolved policy exceeds the 4 MiB policy file limit');
  return changed;
}

async function resolveApps(context: CliContext, signal: AbortSignal): Promise<number> {
  const input = await policyInput(context, validatePolicySourceDocument);
  const destination = await outputTarget(context, input);
  const store = await openFreshnessStore(input.project);
  try {
    const services = await updateServices(context, store);
    const device = await appCompatibility(context, input, services, signal);
    const { policy, ...changes } = await planAppResolutions(
      input.document,
      input.project?.root ?? dirname(input.path),
      services,
      device,
      signal,
    );
    const changed = needsWrite(input.path, destination, policy, changes.resolutions.length);
    const dryRun = context.flag('dry-run');
    const written = changed && !dryRun;
    if (changed) context.io.out(`Proposed app resolutions:\n${JSON.stringify(changes, null, 2)}`);
    if (written) {
      await confirmation(
        context.io,
        `Write verified pinned policy to ${destination.path}?`,
        context.flag('yes'),
        signal,
      );
      signal.throwIfAborted();
      await writeUpdatedPolicy(input, policy, signal, destination);
    } else signal.throwIfAborted();
    const policyLockRequired = written && input.project !== undefined && destination.path === input.path;
    context.output({
      policyFile: input.path,
      destination: destination.path,
      dryRun,
      written,
      ...changes,
      policyLockRequired,
      ...resolutionNextSteps(policyLockRequired, destination.path !== input.path),
    });
    return 0;
  } finally {
    await store?.close();
  }
}

export async function policyResolveCommand(context: CliContext): Promise<number> {
  return withAppCommandSignal(context, (signal) => resolveApps(context, signal));
}
