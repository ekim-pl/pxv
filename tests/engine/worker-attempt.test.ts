import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from '../test-api.js';
import { SqliteStore } from '@pxv/runtime';
import {
  ownedWorkerClaim,
  recordWorkerFailure,
  releaseWorkerClaim,
  type RunRecord,
  type WorkerLaunchClaim,
} from '@pxv/engine';
let root: string, store: SqliteStore;
const run: RunRecord = {
  id: 'run',
  planId: 'plan',
  operator: 'Reviewer',
  status: 'queued',
  createdAt: '2026-10-21T10:00:00Z',
  cursor: 2,
  completedSetup: [],
};
let claim: WorkerLaunchClaim;
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-worker-attempt-');
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  claim = { claimedAt: new Date().toISOString(), attemptToken: randomUUID() };
  await store.set('runs', run.id, run);
  await store.set('worker-launch', run.id, claim);
});
afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});
it('atomically marks only the captured run and records the failure audit', async () => {
  expect(await ownedWorkerClaim(store, run.id, claim.attemptToken)).toEqual(claim);
  expect(await recordWorkerFailure(store, run, claim, 'Startup failed')).toBe(true);
  expect(await store.get('runs', run.id)).toEqual({
    ...run,
    status: 'needs-inspection',
    error: 'Startup failed',
  });
  expect(await store.events(run.id)).toMatchObject([{ event: { type: 'worker-failed' } }]);
  await releaseWorkerClaim(store, run.id, claim);
  expect(await store.get('worker-launch', run.id)).toBeUndefined();
});
for (const status of ['completed', 'cancelled', 'superseded', 'running', 'pending'] as const)
  it(`preserves a competing ${status} record without adding an inaccurate audit`, async () => {
    const changed = { ...run, status, cursor: 4 };
    await store.set('runs', run.id, changed);
    expect(await recordWorkerFailure(store, run, claim, 'Failure')).toBe(false);
    expect(await store.get('runs', run.id)).toEqual(changed);
    expect(await store.events(run.id)).toEqual([]);
    if (status !== 'pending') expect(await recordWorkerFailure(store, changed, claim, 'Failure')).toBe(false);
  });
it('retains terminal snapshots and supports an unchanged manual pause', async () => {
  const paused = { ...run, status: 'pending' as const, manualGate: 'app_setup' };
  await store.set('runs', run.id, paused);
  expect(await recordWorkerFailure(store, paused, claim, 'Stopped')).toBe(true);
  expect(await recordWorkerFailure(store, undefined, claim, 'Stopped')).toBe(false);
});
it('rolls back the run update if audit storage fails', async () => {
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  try {
    db.exec(
      "CREATE TRIGGER worker_audit_fault BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'worker-audit-fault'); END",
    );
    await expect(recordWorkerFailure(store, run, claim, 'Failure')).rejects.toThrow('worker-audit-fault');
    expect(await store.get('runs', run.id)).toEqual(run);
  } finally {
    db.close();
  }
});
it('does not clear legacy or newer claims and rejects foreign attempt tokens', async () => {
  await expect(ownedWorkerClaim(store, run.id, randomUUID())).rejects.toThrow('ownership changed');
  expect(await ownedWorkerClaim(store, run.id, undefined)).toBeUndefined();
  for (const value of [{ claimedAt: claim.claimedAt }, { ...claim, attemptToken: randomUUID() }]) {
    await store.set('worker-launch', run.id, value);
    await releaseWorkerClaim(store, run.id, claim);
    await releaseWorkerClaim(store, run.id, undefined);
    expect(await store.get('worker-launch', run.id)).toEqual(value);
    expect(await recordWorkerFailure(store, run, claim, 'Failure')).toBe(false);
  }
});
