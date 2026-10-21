import type { Store } from '@pxv/runtime';

/** Inspect the retained intent without requiring its original policy to be current. */
export function hasFinalizationIntent(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    'pending' in value &&
    Array.isArray(value.pending) &&
    value.pending.includes('debugging-shutdown')
  );
}

export function assertFinalizationState(value: unknown): void {
  if (hasFinalizationIntent(value))
    throw new Error(
      'finalization-inspection: inspect incomplete debugging shutdown, complete typed recovery where required, and explicitly record lifecycle maintenance before newly reviewed provisioning',
    );
}

/** @internal Shared operational guard; inspection, recovery and lifecycle remain available. */
export async function assertFinalizationResolved(store: Pick<Store, 'get'>, assetId: string): Promise<void> {
  assertFinalizationState(await store.get('workflow', assetId));
}
