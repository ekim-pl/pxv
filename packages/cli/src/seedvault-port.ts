import { SeedvaultAdapter } from '@pxv/adapters';
import type { SeedvaultWorkflowPort } from '@pxv/engine';
import type { ApplicationDependencies } from './dependencies.js';

/** Construct lazily: read-only reports and ordinary workflows need no Seedvault adapter. */
export function createSeedvaultPort(deps: ApplicationDependencies): SeedvaultWorkflowPort {
  let adapter: SeedvaultAdapter | undefined;
  const current = () => (adapter ??= new SeedvaultAdapter(deps.android));
  return {
    inspect: (target, policy, signal) => current().inspect(target, policy, signal),
    executeProfile: (target, profile, request, context) =>
      current().executeProfile(target, profile, request, context),
  };
}
