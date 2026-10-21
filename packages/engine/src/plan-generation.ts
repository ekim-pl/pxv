import type { Store } from '@pxv/runtime';
import { EvidenceValidationError } from './evidence-validation.js';

/** An asset lifecycle transition retires approvals without changing their historical bytes. */
export async function planGeneration(store: Store, assetId: string): Promise<string | undefined> {
  const value = await store.get<unknown>('plan-generations', assetId);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value))
    throw new EvidenceValidationError('Malformed asset lifecycle generation retained for inspection');
  return value;
}

export async function assertPlanGeneration(
  store: Store,
  assetId: string,
  expected: string | undefined,
): Promise<void> {
  if ((await planGeneration(store, assetId)) !== expected)
    throw new EvidenceValidationError(
      'Reviewed plan predates an asset lifecycle event; prepare a new reviewed operation',
    );
}
