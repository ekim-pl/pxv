import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { digest, observationDigest, resolvePolicy, type HandoffRecord } from '@pxv/contracts';
import { SqliteStore } from '@pxv/runtime';
import type { RunRecord, WorkflowState } from '@pxv/engine';
import {
  custodyRun,
  custodyCompletionEvent,
  CustodyCompletionSession,
} from '../../packages/engine/src/custody-completion.js';
import { basePolicy } from './fixtures.js';
import { device, observation, product, project, hashA, hashB } from '../contracts/fixtures.js';

const date = '2026-10-20T10:00:00.000Z';
const resolved = resolvePolicy(basePolicy(), project, product);
const prepared = {
  operation: 'provision' as const,
  plan: {
    schemaVersion: 1 as const,
    id: 'plan',
    projectId: project.id,
    device,
    digest: hashA,
    policyDigest: resolved.digest,
    actions: [],
    createdAt: date,
  },
  target: { device, transport: device.transports[0]! },
};
const run: RunRecord = {
  id: digest({ project: project.id, plan: hashA }),
  planId: 'plan',
  status: 'pending',
  cursor: 0,
  createdAt: date,
  operator: 'Reviewer',
  pauseReason: { kind: 'acceptance', instructions: 'Accept' },
};
const state: WorkflowState = {
  schemaVersion: 1,
  assetId: device.assetId,
  planId: 'plan',
  planDigest: hashA,
  policyDigest: resolved.digest,
  observation,
  observedAt: date,
  status: 'completed-custody',
  pending: [],
  languageReady: true,
};
const record: HandoffRecord = {
  schemaVersion: 1,
  id: 'handoff',
  projectId: project.id,
  deviceSerial: device.canonicalSerial,
  policyDigest: resolved.digest,
  observationDigest: observationDigest(observation),
  locale: 'en',
  outcome: 'completed-custody',
  operator: 'Reviewer',
  createdAt: date,
  acceptedAt: date,
  acceptedBy: 'Recipient',
};
const snapshot = { schemaVersion: 1, assetId: device.assetId, recordId: record.id, resolvedPolicy: resolved };
let root: string, store: SqliteStore;
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-custody-completion-');
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  await store.set('plans', 'plan', prepared);
  await store.set('runs', run.id, run);
  await store.set('workflow', device.assetId, state);
  await store.set('handoff', device.assetId, record);
  await store.set('handoff-snapshots', record.id, snapshot);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
const complete = (value = run, plan = prepared) =>
  new CustodyCompletionSession(store, project.id).complete(value, plan);

it('uses exact historical evidence independently of the current policy and never writes query results', async () => {
  const set = vi.spyOn(store, 'set');
  expect(await complete()).toEqual({ ...run, status: 'completed', pauseReason: undefined });
  expect(await store.get('runs', run.id)).toEqual(run);
  expect(set).not.toHaveBeenCalled();
});

it.each([
  ['workflow', { ...state, schemaVersion: 2 }],
  ['workflow', { ...state, planDigest: 'invalid' }],
  ['workflow', { ...state, planId: 'other-plan' }],
  ['workflow', { ...state, assetId: 'other-asset' }],
  ['workflow', { ...state, policyDigest: hashB }],
  ['workflow', { ...state, status: 'verified' }],
  ['workflow', { ...state, observation: null }],
  ['handoff', { ...record, acceptedBy: undefined }],
  ['handoff', { ...record, deviceSerial: 'OTHER' }],
  ['handoff', { ...record, observationDigest: hashB }],
  ['handoff', { ...record, outcome: 'ready-for-handoff' }],
  ['handoff-snapshots', { ...snapshot, assetId: 'other-asset' }],
  ['handoff-snapshots', { ...snapshot, recordId: 'other-record' }],
  ['handoff-snapshots', { ...snapshot, resolvedPolicy: { ...resolved, digest: hashB } }],
] as const)(
  'does not infer completion from mismatched or malformed %s evidence: %j',
  async (collection, value) => {
    const key = collection === 'handoff-snapshots' ? record.id : device.assetId;
    await store.set(collection, key, value);
    expect((await complete()).status).toBe('pending');
    expect(await store.get(collection, key)).toEqual(JSON.parse(JSON.stringify(value)));
  },
);

it('requires a retained snapshot and supports legacy states without the optional plan identifier', async () => {
  const { planId: _planId, ...legacy } = state;
  void _planId;
  await store.set('workflow', device.assetId, legacy);
  expect((await complete()).status).toBe('completed');
  await store.delete('handoff-snapshots', record.id);
  expect((await complete()).status).toBe('pending');
});

it('withholds completion for unrelated, interrupted, unfinished and malformed run metadata', async () => {
  for (const value of [
    { ...run, status: 'needs-inspection' as const },
    { ...run, status: 'completed' as const },
    { ...run, manualGate: 'app_setup' },
    { ...run, pauseReason: { kind: 'inspection' as const, instructions: 'Inspect' } },
    { ...run, cursor: 1 },
    { ...run, id: 'unrelated-run' },
    { ...run, planId: 'unrelated-plan' },
  ])
    expect(await complete(value)).toEqual(value);
  for (const plan of [
    undefined,
    { ...prepared, operation: 'install-os' as const },
    { ...prepared, operation: undefined },
    { ...prepared, target: null },
    { ...prepared, plan: { ...prepared.plan, digest: hashB } },
    { ...prepared, plan: { ...prepared.plan, actions: null } },
    { ...prepared, target: { ...prepared.target, device: { ...device, model: 'Other' } } },
  ])
    expect(
      (await new CustodyCompletionSession(store, project.id).complete(run, plan as typeof prepared)).status,
    ).toBe('pending');
  expect((await new CustodyCompletionSession(store, 'other-project').complete(run, prepared)).status).toBe(
    'pending',
  );
});

it('shares current, historical and snapshot lookups within one query but reloads for the next query', async () => {
  await store.delete('workflow', device.assetId);
  await store.set('lifecycle-evidence', 'archive', { workflow: state, handoff: record });
  await store.set('lifecycle-evidence', 'malformed', null);
  const get = vi.spyOn(store, 'get');
  const pages = vi.spyOn(store, 'entriesPage');
  const session = new CustodyCompletionSession(store, project.id);
  const results = await Promise.all(Array.from({ length: 4 }, () => session.complete(run, prepared)));
  expect(results.every((value) => value.status === 'completed')).toBe(true);
  expect(pages).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.filter(([collection]) => collection === 'handoff-snapshots')).toHaveLength(1);
  await store.delete('lifecycle-evidence', 'archive');
  expect((await complete()).status).toBe('pending');
});

it('reuses a snapshot shared by current and archived evidence and propagates storage loss', async () => {
  await store.set('handoff-snapshots', record.id, { ...snapshot, assetId: 'wrong' });
  await store.set('lifecycle-evidence', 'archive', { workflow: state, handoff: record });
  const get = vi.spyOn(store, 'get');
  expect((await complete()).status).toBe('pending');
  expect(get.mock.calls.filter(([collection]) => collection === 'handoff-snapshots')).toHaveLength(1);
  get.mockRestore();
  vi.spyOn(store, 'get').mockImplementation((collection, key) => {
    if (collection === 'handoff-snapshots') return Promise.reject(new Error('Storage worker lost'));
    return SqliteStore.prototype.get.call(store, collection, key);
  });
  await expect(complete()).rejects.toThrow('Storage worker lost');
});

it('requires the exact retained run and plan before accepting new custody', async () => {
  const expected = { ...run, status: 'completed', pauseReason: undefined };
  expect(await custodyRun(store, state, record)).toEqual({ previous: run, next: expected });
  await store.delete('runs', run.id);
  await expect(custodyRun(store, state, record)).rejects.toThrow('Matching workflow run');
  await store.set('runs', run.id, run);
  await store.delete('plans', run.planId);
  await expect(custodyRun(store, state, record)).rejects.toThrow('differs from');
  await store.set('plans', run.planId, prepared);
  await store.set('runs', run.id, { ...run, manualGate: 'normal_credentials' });
  await expect(custodyRun(store, state, record)).rejects.toThrow('differs from');
});

it('records typed custody audit events using the accepted timestamp or retained creation timestamp', () => {
  expect(custodyCompletionEvent(run.id, record)).toMatchObject({
    schemaVersion: 1,
    runId: run.id,
    at: record.acceptedAt,
    type: 'custody-completed',
    data: { status: 'completed', recordId: record.id },
  });
  const { acceptedAt: _acceptedAt, ...withoutAcceptanceDate } = record;
  void _acceptedAt;
  expect(custodyCompletionEvent(run.id, withoutAcceptanceDate).at).toBe(record.createdAt);
});
