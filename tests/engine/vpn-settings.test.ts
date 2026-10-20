import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { toPolicyDocument, requiredAttestations } from '@pxv/contracts';
import { createProject, saveInventory, loadProject, WorkflowEngine } from '@pxv/engine';
import { VpnProofVerifier } from '../../packages/engine/src/vpn-proof-verifier.js';
import type {
  PreparedOperation,
  RunRecord,
  VpnSettingsProof,
} from '../../packages/engine/src/workflow-types.js';
import { validVpnProof, vpnProofDigest } from '../../packages/engine/src/vpn-evidence.js';
import { SqliteStore } from '@pxv/runtime';
import { basePolicy, MemoryPort } from './fixtures.js';
import { device, product } from '../contracts/fixtures.js';

let root: string, store: SqliteStore, engine: WorkflowEngine, port: MemoryPort, now: Date;
const target = { device, transport: device.transports[0]! };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-vpn-settings-'));
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  port = new MemoryPort();
  now = new Date('2026-10-16T09:00:00Z');
  const policy = basePolicy();
  policy.profiles.push({
    id: 'work',
    name: 'Work',
    kind: 'secondary',
    packages: [],
    settings: [],
    permissions: [],
    vpn: { packageId: null, alwaysOn: false, lockdown: false },
  });
  port.observation.profiles.push({
    profileId: 'work',
    user: { userId: 10, serialNo: 42, name: 'Work' },
    packages: [],
    settings: [],
    permissions: [],
    vpn: { packageId: null, alwaysOn: false, lockdown: false },
  });
  const project = await createProject(join(root, 'project'), product, toPolicyDocument(policy));
  await saveInventory(project, { schemaVersion: 1, devices: [device] });
  engine = new WorkflowEngine({
    project: await loadProject(project.root, product),
    store,
    port,
    artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
    controlRoot: join(root, 'control'),
    clock: () => now,
  });
});
afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function start() {
  const prepared = await engine.prepare(target);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
  await engine.execute(run.id);
  return { prepared, run };
}
async function confirm(runId: string) {
  const receipt = await engine.attest(target, 'vpn_settings', 'Alice');
  const run = await engine.execute(runId);
  return { receipt, run };
}
it('requires a separate witnessed proof for matching enabled and disabled profiles, without changing settings', async () => {
  const { prepared, run } = await start();
  expect(prepared.plan.actions.map((value) => value.kind)).toEqual(['vpn', 'vpn']);
  expect((await engine.runStatus(run.id)).run?.pauseReason).toMatchObject({
    gate: 'vpn_settings',
    profileId: 'admin',
  });
  expect(port.calls).toEqual([]);
  expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
  const first = await confirm(run.id);
  expect(first.receipt.profileIds).toEqual(['admin']);
  expect(first.run.pauseReason).toMatchObject({ gate: 'vpn_settings', profileId: 'work' });
  expect((await engine.execute(run.id)).manualGate).toBe('vpn_settings');
  expect((await confirm(run.id)).receipt.profileIds).toEqual(['work']);
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Alice');
  expect((await engine.readiness(target)).ready).toBe(true);
  expect((await engine.deviceStatus(target)).vpnEvidenceScope).toBe('operator-witnessed-settings');
  const entries = await store.entries<VpnSettingsProof>('capability-evidence');
  expect(entries).toHaveLength(2);
  const entry = entries[0]!;
  expect(entry.value.scope).toBe('operator-witnessed-settings');
  await store.set('capability-evidence', entry.key, {
    ...entry.value,
    receipt: { ...entry.value.receipt, operator: 'Changed' },
  });
  expect((await engine.readiness(target)).ready).toBe(false);
  await expect(engine.finalize(target, 'Alice')).rejects.toThrow('vpn-settings');
  await store.set('capability-evidence', entry.key, entry.value);
  await engine.finalize(target, 'Alice');
});
it('accepts only the active reviewed transition and rejects unrelated drift and recreated users', async () => {
  const profile = port.observation.profiles[0]!;
  profile.vpn = { packageId: null, alwaysOn: false, lockdown: false };
  // An app-configuration checkpoint precedes the Settings verification when configuration differs.
  const { run } = await start();
  await engine.attest(target, 'app_setup', 'Alice');
  await engine.execute(run.id);
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('Configure');
  profile.vpn = structuredClone(engine.project.policy.profiles[0]!.vpn);
  profile.settings[0]!.value = '1';
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('Other live');
  profile.settings[0]!.value = '0';
  profile.user.serialNo++;
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('Other live');
  profile.user.serialNo--;
  profile.vpn.packageId = 'org.wrong.vpn';
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('reviewed configuration');
  profile.vpn = structuredClone(engine.project.policy.profiles[0]!.vpn);
  expect((await confirm(run.id)).run.pauseReason).toMatchObject({ profileId: 'work' });
});
it('refreshes unfinished Settings checkpoints, preserves completed proofs, and rejects tampered history', async () => {
  const { run } = await start();
  await confirm(run.id);
  now = new Date(now.getTime() + 16 * 60_000);
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('15 minutes');
  await expect(engine.execute(run.id)).rejects.toThrow('expired');
  const refreshed = await engine.refreshReview(run.id);
  expect(refreshed.refreshedFrom?.capabilityEvidence).toHaveLength(1);
  const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
  expect((await engine.execute(next.id)).manualGate).toBe('vpn_settings');
  await confirm(next.id);
  expect((await engine.state(device.assetId)).capabilityEvidence).toHaveLength(2);
});
it('does not accept an ordinary receipt outside the active VPN Settings action', async () => {
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('Fresh provisioning');
  const { run } = await start();
  await confirm(run.id);
  await confirm(run.id);
  await expect(engine.attest(target, 'vpn_settings', 'Alice')).rejects.toThrow('does not belong');
});

it('rejects cross-device proofs, altered bindings and malformed receipts even if a copied record has a new checksum', async () => {
  const { run } = await start();
  await confirm(run.id);
  const entry = (await store.entries<VpnSettingsProof>('capability-evidence'))[0]!;
  const proof = entry.value;
  const binding = { ...proof, status: 'manual-completed' };
  expect(validVpnProof(proof, entry.key, binding)).toBe(true);
  const patches = [
    { scope: 'measured' },
    { kind: 'recipe' },
    { status: 'measured' },
    { planId: '' },
    { actionIndex: -1 },
    { actionIndex: 0.5 },
    { runId: 'other' },
    { profileId: 'work' },
    { assetId: 'other-phone' },
    { deviceSerial: 'other-serial' },
    { user: { ...proof.user, serialNo: 99 } },
    { policyDigest: 'b'.repeat(64) },
    { configurationDigest: 'c'.repeat(64) },
    { receipt: { ...proof.receipt, check: 'app_setup' } },
    { receipt: { ...proof.receipt, profileIds: ['work'] } },
    { receipt: { ...proof.receipt, profileIds: ['admin', 'work'] } },
    { receipt: { ...proof.receipt, planDigest: 'a'.repeat(64) } },
    { receipt: { ...proof.receipt, observationDigest: 'd'.repeat(64) } },
    { receipt: {} },
  ];
  for (const patch of patches) {
    const { proofDigest: checksum, ...body } = { ...proof, ...patch };
    const changed = { ...body, proofDigest: vpnProofDigest(body as Omit<VpnSettingsProof, 'proofDigest'>) };
    expect(changed.proofDigest).not.toBe(checksum);
    expect(validVpnProof(changed, entry.key, binding)).toBe(false);
  }
  expect(validVpnProof(undefined, entry.key, binding)).toBe(false);
  expect(validVpnProof(proof, entry.key, { ...binding, user: undefined })).toBe(false);
  expect(validVpnProof(proof, entry.key, { ...binding, status: 'measured' })).toBe(false);
  await store.set('capability-evidence', entry.key, { ...proof, proofDigest: 'tampered' });
  await expect(engine.refreshReview(run.id)).rejects.toThrow('VPN Settings evidence changed');
});

it('does not commit a witness proof when verification is interrupted', async () => {
  const { run } = await start();
  await engine.attest(target, 'vpn_settings', 'Alice');
  const abort = new AbortController();
  port.verifyVpnConfiguration = (_target, _user, _vpn, context) => {
    abort.abort(new Error('Interrupted verification'));
    context.signal?.throwIfAborted();
    return Promise.resolve();
  };
  expect((await engine.execute(run.id, abort.signal)).status).toBe('cancelled');
  expect(await store.entries('capability-evidence')).toEqual([]);
  expect((await engine.readiness(target)).ready).toBe(false);
});

it('rejects self-consistent proofs with unknown plans or altered operator receipts', async () => {
  const { run } = await start();
  await confirm(run.id);
  await confirm(run.id);
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Alice');
  const entry = (await store.entries<VpnSettingsProof>('capability-evidence'))[0]!;
  for (const patch of [
    { planId: 'nonexistent-reviewed-plan' },
    { receipt: { ...entry.value.receipt, operator: 'Changed' } },
  ]) {
    const { proofDigest: checksum, ...body } = { ...entry.value, ...patch };
    const changed = { ...body, proofDigest: vpnProofDigest(body) };
    expect(changed.proofDigest).not.toBe(checksum);
    await store.set('capability-evidence', entry.key, changed);
    expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
    await expect(engine.finalize(target, 'Alice')).rejects.toThrow('vpn-settings:admin');
  }
  await store.set('capability-evidence', entry.key, entry.value);
  expect((await engine.readiness(target)).ready).toBe(true);
});
it('requires completed action, source run, consumed receipt and intact retained plan provenance', async () => {
  const { run, prepared } = await start();
  await confirm(run.id);
  const original = (await store.get<RunRecord>('runs', run.id))!;
  for (const patch of [
    { id: 'other' },
    { planId: 'other' },
    { cursor: 0 },
    { cursor: 99 },
    { cursor: undefined },
    { completedSetup: [] },
    { completedSetup: original.completedSetup!.map((value) => ({ ...value, actionIndex: 99 })) },
    { capabilityEvidence: [] },
  ]) {
    await store.set('runs', run.id, { ...original, ...patch });
    expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
  }
  await store.set('runs', run.id, original);
  await store.delete('runs', run.id);
  expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
  await store.set('runs', run.id, original);
  await store.set('plans', prepared.plan.id, { ...prepared, reviewSummary: 'changed' });
  expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
  await store.set('plans', prepared.plan.id, prepared);
  expect((await engine.readiness(target)).missing).not.toContain('vpn-settings:admin');
});
it('preserves audited proofs through multiple expired reviews and rejects broken refresh links', async () => {
  let { run } = await start();
  await confirm(run.id);
  for (let index = 0; index < 2; index++) {
    now = new Date(now.getTime() + 16 * 60_000);
    const refreshed = await engine.refreshReview(run.id);
    run = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    await engine.execute(run.id);
    expect((await engine.readiness(target)).missing).not.toContain('vpn-settings:admin');
  }
  const prepared = await engine.plan(run.planId);
  const parentId = prepared.refreshedFrom!.runId;
  const parent = (await store.get<RunRecord>('runs', parentId))!;
  for (const patch of [{ supersededBy: 'other' }, { status: 'pending' }, { capabilityEvidence: [] }]) {
    await store.set('runs', parentId, { ...parent, ...patch });
    expect((await engine.readiness(target)).missing).toContain('vpn-settings:admin');
    await expect(engine.refreshReview(run.id)).rejects.toThrow('execution provenance');
  }
  await store.set('runs', parentId, parent);
  await confirm(run.id);
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Alice');
  expect((await engine.readiness(target)).ready).toBe(true);
});

async function verifierSession(overrides = new Map<string, PreparedOperation>()) {
  const state = await engine.state(device.assetId);
  const read = vi.fn(async (id: string) => {
    const value = overrides.get(id) ?? (await store.get<PreparedOperation>('plans', id));
    if (!value) throw new Error('Missing plan');
    return value;
  });
  const verifier = new VpnProofVerifier(engine.project, store, { read });
  return { state, read, verifier, session: verifier.session(state), overrides };
}
it('checks source action and plan bindings independently of the retained-plan reader', async () => {
  const { run, prepared } = await start();
  await confirm(run.id);
  const f = await verifierSession();
  const reference = f.state.capabilityEvidence![0]!;
  for (const patch of [
    { ...prepared, plan: { ...prepared.plan, id: 'different' } },
    { ...prepared, plan: { ...prepared.plan, policyDigest: 'a'.repeat(64) } },
    { ...prepared, target: { ...prepared.target, device: { ...device, assetId: 'other' } } },
    { ...prepared, target: { ...prepared.target, device: { ...device, canonicalSerial: 'OTHER' } } },
    { ...prepared, plan: { ...prepared.plan, digest: 'a'.repeat(64) } },
    { ...prepared, plan: { ...prepared.plan, actions: [] } },
    {
      ...prepared,
      plan: {
        ...prepared.plan,
        actions: [{ kind: 'vpn' as const, profileId: 'work', vpn: engine.project.policy.profiles[0]!.vpn }],
      },
    },
    {
      ...prepared,
      plan: {
        ...prepared.plan,
        actions: [
          {
            kind: 'vpn' as const,
            profileId: 'admin',
            vpn: { packageId: null, alwaysOn: false, lockdown: false },
          },
        ],
      },
    },
  ]) {
    f.overrides.set(prepared.plan.id, patch);
    expect(await f.verifier.session(f.state).valid(reference)).toBe(false);
  }
  f.overrides.clear();
  const noPlan = { ...f.state };
  delete noPlan.planId;
  expect(await f.verifier.session(noPlan).valid(reference)).toBe(false);
  expect(await f.verifier.session({ ...f.state, planDigest: 'b'.repeat(64) }).valid(reference)).toBe(false);
});
it('paginates and caches attestation audit history, retaining earlier profile receipts', async () => {
  for (let index = 0; index < 110; index++)
    await store.appendEvent(`asset:${device.assetId}`, { type: 'note' });
  await store.appendEvent(`asset:${device.assetId}`, { type: 'attestation' });
  const { run } = await start();
  await confirm(run.id);
  await confirm(run.id);
  const f = await verifierSession();
  const events = vi.spyOn(store, 'events');
  try {
    for (const reference of f.state.capabilityEvidence!) expect(await f.session.valid(reference)).toBe(true);
    expect(events).toHaveBeenCalledTimes(3);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(
      (await engine.receipts(device.assetId)).filter((receipt) => receipt.check === 'vpn_settings'),
    ).toHaveLength(1);
  } finally {
    events.mockRestore();
  }
});
it('rejects malformed audit pages and conflicting snapshots of a consumed receipt', async () => {
  const { run } = await start();
  await confirm(run.id);
  const f = await verifierSession();
  const reference = f.state.capabilityEvidence![0]!;
  const events = vi.spyOn(store, 'events').mockResolvedValueOnce([{ sequence: 0, event: { type: 'note' } }]);
  expect(await f.session.valid(reference)).toBe(false);
  events.mockRestore();
  const proof = (await store.get<VpnSettingsProof>('capability-evidence', reference.evidenceId))!;
  await store.appendEvent(`asset:${device.assetId}`, {
    type: 'attestation',
    receipt: { ...proof.receipt, operator: 'Other' },
  });
  expect(await f.verifier.session(f.state).valid(reference)).toBe(false);
});
it('rejects missing, cyclic and altered refresh lineage independently of plan integrity checks', async () => {
  const { run } = await start();
  await confirm(run.id);
  const prepared = await engine.refreshReview(run.id);
  if (!('operation' in prepared)) throw new Error('Unexpected Seedvault plan');
  const next = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
  await engine.execute(next.id);
  const f = await verifierSession();
  const reference = f.state.capabilityEvidence![0]!;
  const edge = prepared.refreshedFrom!;
  const previous = (await store.get<PreparedOperation>('plans', run.planId))!;
  for (const patch of [
    undefined,
    { ...edge, capabilityEvidence: [] },
    { ...edge, runId: 'missing' },
    { ...edge, planDigest: 'a'.repeat(64) },
    { ...edge, completedActions: -1 },
    { ...edge, completedActions: 99 },
    { ...edge, completedActions: 0.5 },
    { ...edge, completedActions: 0 },
  ]) {
    const changed = { ...prepared, ...(patch ? { refreshedFrom: patch } : {}) };
    if (!patch) delete changed.refreshedFrom;
    f.overrides.set(prepared.plan.id, changed);
    expect(await f.verifier.session(f.state).valid(reference)).toBe(false);
  }
  f.overrides.set(prepared.plan.id, {
    ...prepared,
    refreshedFrom: { ...edge, completedActions: 0 },
    plan: { ...prepared.plan, actions: previous.plan.actions },
  });
  expect(await f.verifier.session(f.state).valid(reference)).toBe(false);
  f.overrides.set(prepared.plan.id, {
    ...prepared,
    refreshedFrom: { ...edge, runId: next.id, planDigest: prepared.plan.digest, completedActions: 0 },
  });
  const currentRun = (await store.get<RunRecord>('runs', next.id))!;
  await store.set('runs', next.id, { ...currentRun, status: 'superseded', supersededBy: prepared.plan.id });
  expect(await f.verifier.session(f.state).valid(reference)).toBe(false);
});
