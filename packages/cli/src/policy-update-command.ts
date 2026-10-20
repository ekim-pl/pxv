import { validatePolicyDocument } from '@pxv/contracts';
import { confirmation, type CliContext } from './arguments.js';
import { planAppUpdates } from './policy-app-updates.js';
import {
  policyInput,
  openFreshnessStore,
  updateServices,
  appCompatibility,
  writeUpdatedPolicy,
  withAppCommandSignal,
} from './policy-app-command.js';

async function updateApps(context: CliContext, signal: AbortSignal): Promise<number> {
  const input = await policyInput(context, validatePolicyDocument);
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
  return withAppCommandSignal(context, (signal) => updateApps(context, signal));
}
