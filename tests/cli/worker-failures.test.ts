import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { SqliteStore } from '@pxv/runtime';
import type { RunRecord, WorkerLaunchClaim } from '@pxv/engine';
import { internalWorker } from '../../packages/cli/src/run-command.js';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';
let root: string, store: SqliteStore, claim: WorkerLaunchClaim;
const run: RunRecord = {
  id: 'run',
  planId: 'plan',
  status: 'queued',
  operator: 'Reviewer',
  createdAt: '2026-10-21T10:00:00Z',
};
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-worker-failures-');
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  claim = { claimedAt: new Date().toISOString(), attemptToken: randomUUID() };
  await store.set('runs', run.id, run);
  await store.set('worker-launch', run.id, claim);
  vi.stubEnv('PXV_WORKER_ATTEMPT', claim.attemptToken);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
const context = (execute: () => Promise<unknown>) =>
  ({
    value: () => run.id,
    app: { store, engine: { execute } },
    signal: new AbortController().signal,
  }) as unknown as ApplicationCliContext;
it('keeps the engine conflict error and newer completed evidence', async () => {
  const error = new Error('Run evidence changed; inspect before retrying');
  const changed = { ...run, status: 'completed', cursor: 3 };
  await expect(
    internalWorker(
      context(async () => {
        await store.set('runs', run.id, changed);
        throw error;
      }),
    ),
  ).rejects.toBe(error);
  expect(await store.get('runs', run.id)).toEqual(changed);
  expect(await store.events(run.id)).toEqual([]);
  expect(await store.get('worker-launch', run.id)).toBeUndefined();
});
it('aggregates recording and cleanup errors without discarding the original failure', async () => {
  const original = new Error('Original failure'),
    secondary = new Error('Storage unavailable');
  vi.spyOn(store, 'transition').mockRejectedValue(secondary);
  const error = await internalWorker(context(() => Promise.reject(original))).catch(
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([original, secondary, secondary]);
});
it('leaves a newer launch claim intact during late cleanup', async () => {
  const newer = { ...claim, attemptToken: randomUUID() };
  expect(
    await internalWorker(
      context(async () => {
        await store.set('worker-launch', run.id, newer);
        return { ...run, status: 'completed' };
      }),
    ),
  ).toBe(0);
  expect(await store.get('worker-launch', run.id)).toEqual(newer);
});
