import { validateObservation } from '@pxv/contracts';
import type { WorkflowState } from './workflow-types.js';

/** Validate retained structure independently of the currently selected policy/build. */
export function validateStoredWorkflow(value: unknown, assetId: string): WorkflowState {
  const state = value as WorkflowState | undefined;
  if (
    !state ||
    state.schemaVersion !== 1 ||
    state.assetId !== assetId ||
    !/^[a-f0-9]{64}$/u.test(state.policyDigest) ||
    !/^[a-f0-9]{64}$/u.test(state.planDigest)
  )
    throw new Error('Fresh provisioning evidence is required');
  validateFlags(state);
  if (state.planId !== undefined && (typeof state.planId !== 'string' || !state.planId))
    throw new Error('Invalid retained workflow plan identifier');
  validateReferences(state.completedSetup, ['check', 'receiptId', 'planDigest']);
  validateReferences(state.capabilityEvidence, [
    'kind',
    'profileId',
    'configurationDigest',
    'evidenceId',
    'status',
  ]);
  if (validateObservation(state.observation).device.assetId !== assetId)
    throw new Error('Stored observation differs from its workflow asset');
  return state;
}

function validateFlags(state: WorkflowState): void {
  if (
    !Array.isArray(state.pending) ||
    state.pending.some((item) => typeof item !== 'string') ||
    typeof state.languageReady !== 'boolean' ||
    !['pending', 'failed', 'verified', 'shutdown-requested', 'completed-custody'].includes(state.status)
  )
    throw new Error('Fresh provisioning evidence is required');
}

function validateReferences(value: unknown, keys: string[]): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        keys.some((key) => typeof (item as Record<string, unknown>)[key] !== 'string'),
    )
  )
    throw new Error('Invalid retained workflow evidence references');
}
