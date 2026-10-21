import { randomUUID } from 'node:crypto';
import type { Store } from '@pxv/runtime';
import type { RunRecord } from './workflow-types.js';

/** @internal Only the exact launch attempt may clear its claim or record an unchanged run's failure. */
export interface WorkerLaunchClaim {
  claimedAt: string;
  attemptToken: string;
}
/** @internal Legacy or foreign claims remain available for inspection. */
export async function ownedWorkerClaim(
  store: Store,
  runId: string,
  token: string | undefined,
): Promise<WorkerLaunchClaim | undefined> {
  if (!token) return undefined;
  const claim = await store.get<WorkerLaunchClaim>('worker-launch', runId);
  if (
    !claim ||
    claim.attemptToken !== token ||
    !/^[a-f0-9-]{36}$/u.test(token) ||
    !Number.isFinite(Date.parse(claim.claimedAt))
  )
    throw new Error('Worker launch ownership changed; inspect the retained claim');
  return claim;
}
/** @internal A conflict is not permission to replace a newer record. */
export async function recordWorkerFailure(
  store: Store,
  expected: RunRecord | undefined,
  claim: WorkerLaunchClaim | undefined,
  message: string,
): Promise<boolean> {
  if (
    !expected ||
    !(
      expected.status === 'queued' ||
      (expected.status === 'pending' && expected.manualGate && Number.isSafeInteger(expected.cursor))
    )
  )
    return false;
  const next: RunRecord = { ...expected, status: 'needs-inspection', error: message };
  return store.transition({
    expected: [
      { collection: 'runs', key: expected.id, value: expected },
      { collection: 'worker-launch', key: expected.id, value: claim },
    ],
    changes: [{ kind: 'set', collection: 'runs', key: expected.id, value: next }],
    events: [
      {
        runId: expected.id,
        value: {
          schemaVersion: 1,
          id: randomUUID(),
          runId: expected.id,
          at: new Date().toISOString(),
          type: 'worker-failed',
          data: { status: next.status, error: message },
        },
      },
    ],
  });
}
/** @internal Cleanup never removes another attempt's or a legacy claim. */
export async function releaseWorkerClaim(
  store: Store,
  runId: string,
  claim: WorkerLaunchClaim | undefined,
): Promise<void> {
  if (!claim) return;
  await store.transition({
    expected: [{ collection: 'worker-launch', key: runId, value: claim }],
    changes: [{ kind: 'delete', collection: 'worker-launch', key: runId }],
    events: [],
  });
}
