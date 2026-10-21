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
import { device, observation, project, product, hashB } from '../contracts/fixtures.js';
import { basePolicy } from './fixtures.js';
import {
  custodyBaseline as resolved,
  preparedFixture,
  alteredPrepared,
  sealPrepared,
} from './prepared-fixture.js';

const date = '2026-10-20T10:00:00.000Z';
const prepared = preparedFixture();
const run: RunRecord = {
  id: digest({ project: project.id, plan: prepared.plan.digest }),
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
  planDigest: prepared.plan.digest,
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
it('authenticates original hashless handoffs without adding content measurements to stored evidence', async () => {
  const baseline = structuredClone(observation);
  for (const profile of baseline.profiles) for (const installed of profile.packages) delete installed.sha256;
  const legacy = sealPrepared({ ...prepared, baseline });
  const original = { ...run, id: digest({ project: project.id, plan: legacy.plan.digest }) };
  await store.set('plans', 'plan', legacy);
  await store.set('workflow', device.assetId, {
    ...state,
    planDigest: legacy.plan.digest,
    observation: baseline,
  });
  await store.set('handoff', device.assetId, { ...record, observationDigest: observationDigest(baseline) });
  const bytes = JSON.stringify(legacy);
  expect((await complete(original, legacy)).status).toBe('completed');
  expect(JSON.stringify(await store.get('plans', 'plan'))).toBe(bytes);
  expect(
    (await store.get<typeof state>('workflow', device.assetId))!.observation.profiles[0]!.packages[0],
  ).not.toHaveProperty('sha256');
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
  const result = await custodyRun(store, state, record);
  expect(result.previous).toEqual(run);
  expect(result.next).toEqual(expected);
  await store.delete('runs', run.id);
  await expect(custodyRun(store, state, record)).rejects.toThrow('Matching workflow run');
  await store.set('runs', run.id, run);
  await store.delete('plans', run.planId);
  await expect(custodyRun(store, state, record)).rejects.toThrow('differs from');
  await store.set('plans', run.planId, prepared);
  await store.set('runs', run.id, { ...run, manualGate: 'normal_credentials' });
  await expect(custodyRun(store, state, record)).rejects.toThrow('differs from');
});

it('rejects altered complete plans and incomplete legacy plans without rewriting stored records', async () => {
  for (const [name, value] of Object.entries(alteredPrepared(prepared))) {
    if (name === 'actions') continue; // The empty subset fixture has no actions to replace.
    await store.set('plans', run.planId, value);
    expect(
      (await new CustodyCompletionSession(store, project.id).complete(run, value as typeof prepared)).status,
    ).toBe('pending');
    await expect(custodyRun(store, state, record)).rejects.toThrow('differs from');
    expect(await store.get('plans', run.planId)).toEqual(value);
    expect(await store.get('runs', run.id)).toEqual(run);
    const alreadyCompleted = { ...run, status: 'completed' as const };
    expect(
      await new CustodyCompletionSession(store, project.id).complete(
        alreadyCompleted,
        value as typeof prepared,
      ),
    ).toEqual(alreadyCompleted);
  }
});

it('authenticates archived legacy completion with original extension locks independently of installation', async () => {
  const original = resolvePolicy(
    basePolicy(),
    {
      ...project,
      extensions: [
        {
          id: '@private/original',
          version: '0.1.0',
          integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
          apiVersion: 1,
          entry: 'index.js',
          installPath: 'a'.repeat(64),
        },
      ],
    },
    product,
  );
  const plan = sealPrepared(
    { ...prepared, plan: { ...prepared.plan, policyDigest: original.digest } },
    original.project.extensions,
  );
  const legacyRun = { ...run, id: digest({ project: project.id, plan: plan.plan.digest }) };
  const workflow = { ...state, planDigest: plan.plan.digest, policyDigest: original.digest };
  const handoff = { ...record, policyDigest: original.digest };
  await store.set('handoff-snapshots', record.id, { ...snapshot, resolvedPolicy: original });
  await store.delete('workflow', device.assetId);
  await store.set('lifecycle-evidence', 'archive', { workflow, handoff });
  expect((await new CustodyCompletionSession(store, project.id).complete(legacyRun, plan)).status).toBe(
    'completed',
  );
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

for (const operation of ['provision', 'create-users', 'deploy-apps', 'extension'] as const)
  for (const status of ['pending', 'completed'] as const)
    it(`accepts exact fully executed ${status} ${operation} lineage`, async () => {
      const plan = preparedFixture(operation);
      const previous = { ...run, id: digest({ project: project.id, plan: plan.plan.digest }), status };
      await store.set('runs', previous.id, previous);
      await store.set('plans', run.planId, plan);
      const result = await custodyRun(store, { ...state, planDigest: plan.plan.digest }, record);
      expect(result.next.status).toBe('completed');
      expect(result.next).not.toHaveProperty('pauseReason');
      expect(result.expected).toEqual([
        { collection: 'runs', key: previous.id, value: previous },
        { collection: 'plans', key: run.planId, value: plan },
        { collection: 'handoff-snapshots', key: record.id, value: snapshot },
      ]);
    });
