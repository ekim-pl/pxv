import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteStore } from '@pxv/runtime';
import type { ProjectContext, RunRecord, WorkflowPort } from '@pxv/engine';
import { RunQueryService } from '../../packages/engine/src/run-query-service.js';
import { ObservationService } from '../../packages/engine/src/observation-service.js';
import { device } from '../contracts/fixtures.js';

const project = {
  config: { id: 'project' },
  resolved: { digest: 'a'.repeat(64) },
  inventory: { schemaVersion: 1, devices: [device] },
} as ProjectContext;
const run: RunRecord = {
  id: 'run',
  planId: 'plan',
  status: 'pending',
  manualGate: 'normal_credentials',
  createdAt: '2026-10-17T09:00:00Z',
  operator: 'Operator',
};
const plan = {
  schemaVersion: 1,
  plan: {
    schemaVersion: 1,
    id: 'plan',
    projectId: 'project',
    policyDigest: 'a'.repeat(64),
    digest: 'b'.repeat(64),
    device,
    createdAt: '2026-10-17T09:00:00Z',
    actions: [],
  },
  target: { device, transport: device.transports[0]! },
  operation: 'provision',
  expiresAt: '2026-10-17T10:15:00Z',
  reviewSummary: 'retained exact summary',
};

async function fixture(action: (queries: RunQueryService, store: SqliteStore, now: Date) => Promise<void>) {
  const root = await mkdtemp('/tmp/pxv-run-queries-');
  const store = await SqliteStore.open(join(root, 'db'));
  const now = new Date('2026-10-17T10:00:00Z');
  try {
    await store.set('plans', 'plan', plan);
    await store.set('runs', run.id, run);
    await action(
      new RunQueryService(project, store, () => now, new ObservationService(project, {} as WorkflowPort)),
      store,
      now,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('shared retained run queries', () => {
  it('resolves a page of superseded runs with one history scan and enriches only the latest asset run', async () => {
    await fixture(async (queries, store) => {
      for (let index = 0; index < 1001; index++)
        await store.set('runs', `a-${String(index).padStart(4, '0')}`, {
          ...run,
          id: `a-${index}`,
          status: 'superseded',
          supersededBy: 'replacement-plan',
        });
      await store.set('runs', 'z-replacement', { ...run, id: 'z-replacement', planId: 'replacement-plan' });
      const pages = vi.spyOn(store, 'entriesPage');
      const response = await queries.list({ limit: 100 });
      expect(response.items).toHaveLength(100);
      expect(
        response.items.every(({ value }) => value.nextSteps[0]?.command.at(-1) === 'z-replacement'),
      ).toBe(true);
      expect(pages).toHaveBeenCalledTimes(3);
      pages.mockClear();
      const describe = vi.spyOn(queries, 'describe');
      expect((await queries.latest(device.assetId))?.id).toBe('run');
      expect(describe).toHaveBeenCalledTimes(1);
      expect(pages).toHaveBeenCalledTimes(2);
    });
  });
  it('describes checkpoints and review expiry without changing evidence or authorizing confirmation', async () => {
    await fixture(async (queries, store, now) => {
      const set = vi.spyOn(store, 'set');
      await store.appendEvent(run.id, { type: 'first' });
      const first = await store.appendEvent(run.id, { type: 'second' });
      const response = await queries.status(run.id, first);
      expect(response.events).toEqual([]);
      expect(response.run).toMatchObject({
        evidenceSource: 'stored',
        assetId: device.assetId,
        operation: 'provision',
        reviewStatus: 'current',
        reviewExpiresAt: plan.expiresAt,
        pauseReason: { kind: 'manual-step', gate: 'normal_credentials' },
        nextSteps: [
          { kind: 'resume', requiresConfirmation: true, command: ['agent', 'resume', '--run', run.id] },
        ],
      });
      expect(set).not.toHaveBeenCalled();
      expect(await store.get('runs', run.id)).toEqual(run);
      now.setTime(Date.parse('2026-10-17T10:16:00Z'));
      expect(await queries.describe(run)).toMatchObject({
        reviewStatus: 'expired',
        nextSteps: [{ kind: 'refresh-review' }],
      });
      expect(await queries.status('missing')).toEqual({ run: undefined, events: [] });
    });
  });
  it('marks changed policy, project and lifecycle metadata stale and absent or invalid plans unavailable', async () => {
    await fixture(async (queries, store) => {
      for (const changed of [
        { ...plan, plan: { ...plan.plan, policyDigest: 'c'.repeat(64) } },
        { ...plan, plan: { ...plan.plan, projectId: 'other' } },
        { ...plan, lifecycleGeneration: 'prior' },
      ]) {
        await store.set('plans', 'plan', changed);
        expect(await queries.describe(run)).toMatchObject({ reviewStatus: 'stale', nextSteps: [] });
      }
      await store.set('plans', 'plan', { ...plan, expiresAt: 'invalid' });
      expect(await queries.describe(run)).toMatchObject({ reviewStatus: 'unavailable' });
      await store.delete('plans', 'plan');
      expect(await queries.describe(run)).toMatchObject({ reviewStatus: 'unavailable' });
    });
  });
  it('handles ordinary, interrupted and superseded runs and post-flash setup conservatively', async () => {
    await fixture(async (queries, store) => {
      expect(await queries.describe({ ...run, status: 'running' })).toMatchObject({
        nextSteps: [{ kind: 'status', requiresConfirmation: false }],
      });
      expect(await queries.describe({ ...run, status: 'queued' })).toMatchObject({
        nextSteps: [{ kind: 'status' }],
      });
      expect(await queries.describe({ ...run, status: 'completed' })).toMatchObject({ nextSteps: [] });
      expect(await queries.describe({ ...run, status: 'failed' })).toMatchObject({
        pauseReason: { kind: 'inspection' },
        nextSteps: [{ kind: 'inspect' }],
      });
      expect(
        await queries.describe({ ...run, status: 'superseded', supersededBy: 'replacement-plan' }),
      ).toMatchObject({
        nextSteps: [
          {
            kind: 'review-refreshed-plan',
            command: ['agent', 'execute', '--plan', 'replacement-plan', '--help'],
          },
        ],
      });
      const { manualGate: _manualGate, ...withoutGate } = run;
      void _manualGate;
      expect(await queries.describe(withoutGate)).toMatchObject({ nextSteps: [{ kind: 'acceptance' }] });
      await store.set('plans', 'plan', { ...plan, operation: 'install-os' });
      expect(await queries.describe(withoutGate)).toMatchObject({
        pauseReason: { kind: 'reenrollment' },
        nextSteps: [{ kind: 'reenroll', command: ['device', 'inspect', '--asset', device.assetId] }],
      });
    });
  });
  it('withholds resume guidance when retained enrollment or transport no longer matches', async () => {
    await fixture(async (queries, store, now) => {
      const inspect = vi.fn();
      for (const devices of [[], [{ ...device, model: 'Different enrolled model' }]]) {
        const changed = { ...project, inventory: { schemaVersion: 1 as const, devices } };
        const observations = new ObservationService(changed, { inspect } as unknown as WorkflowPort);
        const changedQueries = new RunQueryService(changed, store, () => now, observations);
        expect(await changedQueries.describe(run)).toMatchObject({ reviewStatus: 'stale', nextSteps: [] });
      }
      await store.set('plans', 'plan', {
        ...plan,
        target: { device, transport: { kind: 'usb', serial: 'OTHER' } },
      });
      expect(await queries.describe(run)).toMatchObject({ reviewStatus: 'stale', nextSteps: [] });
      expect(inspect).not.toHaveBeenCalled();
    });
  });
  it('marks malformed or internally inconsistent retained plan metadata unavailable', async () => {
    await fixture(async (queries, store) => {
      for (const malformed of [
        { ...plan, schemaVersion: 0 },
        { ...plan, plan: { ...plan.plan, id: 'different-plan' } },
        { ...plan, plan: { ...plan.plan, actions: [{ kind: 'unknown' }] } },
        { ...plan, target: { ...plan.target, device: { ...device, model: 'Changed target' } } },
        { ...plan, target: null },
        { ...plan, operation: 'unknown' },
        { ...plan, operation: undefined, request: { operation: 'unknown' } },
        { ...plan, reviewSummary: null },
      ]) {
        await store.set('plans', 'plan', malformed);
        expect(await queries.describe(run)).toMatchObject({ reviewStatus: 'unavailable', nextSteps: [] });
      }
    });
  });
  it('resolves a superseding plan to its submitted run across all retained pages', async () => {
    await fixture(async (queries, store) => {
      for (let index = 0; index < 1000; index++)
        await store.set('runs', `a-${String(index).padStart(4, '0')}`, {
          ...run,
          id: `a-${index}`,
          planId: 'unrelated',
        });
      const replacement = { ...run, id: 'z-submitted-run', planId: 'replacement-plan', status: 'queued' };
      await store.set('runs', replacement.id, replacement);
      expect(
        await queries.describe({ ...run, status: 'superseded', supersededBy: replacement.planId }),
      ).toMatchObject({
        nextSteps: [
          { kind: 'follow-superseding-run', command: ['agent', 'status', '--run', replacement.id] },
        ],
      });
    });
  });
  it('reads optional Seedvault metadata without loading its execution service and returns latest asset evidence', async () => {
    await fixture(async (queries, store) => {
      await store.delete('plans', 'plan');
      const { operation: _operation, ...metadata } = plan;
      void _operation;
      await store.set('seedvault-plans', 'plan', { ...metadata, request: { operation: 'backup' } });
      expect(await queries.describe(run)).toMatchObject({ operation: 'backup', reviewStatus: 'current' });
      await store.set('runs', 'later', { ...run, id: 'later', createdAt: '2026-10-17T09:01:00Z' });
      const page = await queries.list({ limit: 1 });
      expect(page.items[0]?.key).toBe('later');
      expect(page.nextCursor).toBe('later');
      expect((await queries.latest(device.assetId))?.id).toBe('later');
      expect(await queries.latest('absent')).toBeUndefined();
    });
  });
});
