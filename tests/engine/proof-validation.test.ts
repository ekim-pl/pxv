import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { digest, requiredAttestations, toPolicyDocument, type RecipePolicy } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, writePolicyLock, WorkflowEngine } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { basePolicy, MemoryPort, executeWithWitnesses } from './fixtures.js';
import { device, product, hashA, hashB } from '../contracts/fixtures.js';
import { validateRecipeResult, validateProbeResult } from '../../packages/engine/src/capability-results.js';
import { DatabaseSync } from 'node:sqlite';
import type { RunRecord, PreparedOperation } from '@pxv/engine';
import { CapabilityProofVerifier } from '../../packages/engine/src/capability-proof-verifier.js';

let root: string, store: SqliteStore, engine: WorkflowEngine, port: MemoryPort;
const target = { device, transport: device.transports[0]! };
const recipe: RecipePolicy = {
  schemaVersion: 1,
  id: 'fixture',
  packageId: 'org.example.vpn',
  versionCode: 12,
  signerSha256: hashB,
  buildFingerprint: 'fixture/build',
  steps: [{ action: 'back' }],
  postconditions: [{ resourceId: 'org.example.vpn:id/ready' }],
};
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-proof-validation-');
  const code = join(root, 'code');
  await mkdir(code);
  await writeFile(join(code, 'product.json'), JSON.stringify(product));
  const policy = basePolicy();
  policy.profiles[0]!.recipes = [recipe];
  policy.profiles[0]!.networkProbe = {
    artifact: {
      packageId: 'org.pxv.probe',
      versionCode: 1,
      sha256: hashA,
      signerSha256: hashB,
      path: 'helper.apk',
    },
    endpoint: 'https://example.org/check',
    expectedEgressCidrs: ['192.0.2.0/24'],
    requireVpn: true,
    failurePackages: [],
  };
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), code);
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  const project = await loadProject(created.root, product, code);
  await writePolicyLock(project);
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  port = new MemoryPort();
  port.runRecipe = (_target, _user, configured) =>
    Promise.resolve({
      status: 'measured',
      capability: 'app-setup',
      recipeDigest: digest(configured),
      postconditions: 1,
    });
  port.runProbe = (_target, user) =>
    Promise.resolve({
      scope: 'probe-app-uid-https-only',
      normal: {
        uid: user.userId * 100000 + 10101,
        requestSucceeded: true,
        connectionObserved: true,
        vpnActive: true,
        egressIp: '192.0.2.1',
        errorType: null,
      },
      failures: [],
    });
  engine = new WorkflowEngine({
    project,
    store,
    port,
    artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
    clock: () => new Date('2026-10-16T09:00:00Z'),
    controlRoot: join(root, 'control'),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function ready(manual = false) {
  if (manual)
    port.runRecipe = (_target, _user, configured) =>
      Promise.resolve({
        status: 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(configured),
        instructions: 'Complete privately',
      });
  const prepared = await engine.prepare(target),
    submitted = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  let run = await executeWithWitnesses(engine, submitted.id);
  if (manual) {
    expect(run.manualGate).toBe('app_setup');
    await engine.attest(target, 'app_setup', 'Reviewer');
    run = await executeWithWitnesses(engine, submitted.id);
  }
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Reviewer');
  expect((await engine.readiness(target)).ready).toBe(true);
  return { run, prepared };
}
for (const kind of ['recipe', 'network-probe'])
  it(`rejects incomplete ${kind} evidence before finalization without rewriting records`, async () => {
    await ready();
    const state = await engine.state(device.assetId),
      ref = state.capabilityEvidence!.find((r) => r.kind === kind)!;
    const original = await store.get<Record<string, unknown>>('capability-evidence', ref.evidenceId);
    for (const field of ['result', 'runId', 'kind', 'observationDigest', 'user']) {
      const changed = { ...original };
      delete changed[field];
      await store.set('capability-evidence', ref.evidenceId, changed);
      expect((await engine.readiness(target)).missing).toContain(
        kind === 'recipe' ? 'recipe:admin:fixture' : 'probe:admin',
      );
      await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('Handoff checks remain');
      expect(await store.get('capability-evidence', ref.evidenceId)).toEqual(changed);
    }
    expect(port.calls).not.toContain('finalize');
  });
it('accepts complete existing proof layout and verifies consumed manual recipe audit receipts across pages', async () => {
  const { run } = await ready(true);
  const proof = run.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  expect(await store.get('capability-evidence', proof.evidenceId)).not.toHaveProperty('planId');
  const events = store.events.bind(store);
  vi.spyOn(store, 'events').mockImplementation((id, after) => events(id, after, 1));
  expect((await engine.readiness(target)).ready).toBe(true);
  const receipt = run.completedSetup!.find((r) => r.check === 'app_setup')!;
  await store.set('runs', run.id, {
    ...run,
    completedSetup: run.completedSetup!.filter((r) => r.receiptId !== receipt.receiptId),
  });
  expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
});
it('requires a completed proof status even when workflow and source references agree on a pending or unknown status', async () => {
  const { run } = await ready(true);
  const state = await engine.state(device.assetId);
  const reference = run.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  const proof = (await store.get<Record<string, unknown>>('capability-evidence', reference.evidenceId))!;
  for (const status of ['manual-pending', 'unknown']) {
    const references = run.capabilityEvidence!.map((r) =>
      r.evidenceId === reference.evidenceId ? { ...r, status } : r,
    );
    await store.set('capability-evidence', reference.evidenceId, { ...proof, status });
    await store.set('runs', run.id, { ...run, capabilityEvidence: references, completedSetup: [] });
    await store.set('workflow', device.assetId, { ...state, capabilityEvidence: references });
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
    await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('recipe:admin:fixture');
  }
  expect(port.calls).not.toContain('finalize');
});
it('infers an unindexed legacy recipe receipt only when no other completed app-setup action can own it', async () => {
  const { run, prepared } = await ready(true);
  const state = await engine.state(device.assetId);
  const reference = run.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  const completedSetup = run.completedSetup!.map(({ actionIndex: _index, ...receipt }) => {
    void _index;
    return receipt;
  });
  // The injected reader represents authenticated content; this isolates receipt inference from plan hashing.
  const ambiguous: PreparedOperation = {
    ...prepared,
    plan: {
      ...prepared.plan,
      actions: [
        ...prepared.plan.actions,
        { kind: 'manual', capability: 'app_setup', instructions: 'A separate completed setup' },
      ],
    },
  };
  const session = (plan: PreparedOperation) =>
    new CapabilityProofVerifier(engine.project, store, { read: () => Promise.resolve(plan) }).session(state);
  await store.set('runs', run.id, { ...run, completedSetup, cursor: ambiguous.plan.actions.length });
  expect(await session(ambiguous).valid(reference)).toBe(false);
  await store.set('runs', run.id, { ...run, cursor: ambiguous.plan.actions.length });
  expect(await session(ambiguous).valid(reference)).toBe(true);
  await store.set('runs', run.id, { ...run, completedSetup });
  expect(await session(prepared).valid(reference)).toBe(true);
});
it('propagates proof, source and later audit-page storage failures', async () => {
  await ready(true);
  const get = store.get.bind(store);
  for (const collection of ['capability-evidence', 'runs', 'plans', 'plan-generations']) {
    const fault = new Error(`${collection} unavailable`);
    const spy = vi
      .spyOn(store, 'get')
      .mockImplementation((name, key) => (name === collection ? Promise.reject(fault) : get(name, key)));
    await expect(engine.readiness(target)).rejects.toBe(fault);
    spy.mockRestore();
  }
  const events = store.events.bind(store),
    fault = new Error('Later audit page unavailable');
  vi.spyOn(store, 'events').mockImplementation((id, after) =>
    after ? Promise.reject(fault) : events(id, after, 1),
  );
  await expect(engine.readiness(target)).rejects.toBe(fault);
});
it('rejects altered proof bindings, results, source cursors and unauthenticated source plans', async () => {
  const { run, prepared } = await ready();
  const reference = run.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  const original = (await store.get<Record<string, unknown>>('capability-evidence', reference.evidenceId))!;
  for (const patch of [
    { observationDigest: hashA },
    { status: 'manual-completed' },
    { configurationDigest: hashB },
    { app: {} },
    { runId: hashB },
    { result: { status: 'measured', capability: 'app-setup', recipeDigest: hashA, postconditions: 1 } },
    { user: { ...port.observation.profiles[0]!.user, serialNo: 99 } },
  ]) {
    await store.set('capability-evidence', reference.evidenceId, { ...original, ...patch });
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
  }
  await store.set('capability-evidence', reference.evidenceId, original);
  for (const patch of [
    { cursor: 0 },
    { cursor: 999 },
    { capabilityEvidence: [] },
    { completedSetup: [null] },
  ]) {
    await store.set('runs', run.id, { ...run, ...patch });
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
  }
  await store.set('runs', run.id, run);
  await store.set('plans', prepared.plan.id, { ...prepared, reviewSummary: 'altered' });
  expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
});
it('rejects changed and missing retained app-setup audit receipts without accepting the live receipt list', async () => {
  await ready(true);
  const database = new DatabaseSync(join(root, 'state.sqlite'));
  try {
    const row = database
      .prepare(
        "SELECT sequence,value FROM events WHERE run_id=? AND value LIKE '%app_setup%' AND value LIKE '%attestation%'",
      )
      .get(`asset:${device.assetId}`) as { sequence: number; value: string };
    const original = JSON.parse(row.value) as { receipt: { observationDigest: string } };
    database.prepare('UPDATE events SET value=? WHERE sequence=?').run(
      JSON.stringify({
        ...original,
        receipt: { ...original.receipt, observationDigest: hashA },
      }),
      row.sequence,
    );
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
    database.prepare('DELETE FROM events WHERE sequence=?').run(row.sequence);
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
  } finally {
    database.close();
  }
});
it('authenticates completed recipes through committed refresh ancestry and rejects a changed predecessor', async () => {
  port.observation.profiles[0]!.vpn = { packageId: null, alwaysOn: false, lockdown: false };
  const prepared = await engine.prepare(target);
  let run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  run = await engine.execute(run.id);
  expect(run.manualGate).toBe('vpn_settings');
  const reference = run.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  const proof = (await store.get<Record<string, unknown>>('capability-evidence', reference.evidenceId))!;
  await store.set('capability-evidence', reference.evidenceId, { ...proof, result: {} });
  await expect(engine.refreshReview(run.id)).rejects.toThrow('execution provenance');
  await store.set('capability-evidence', reference.evidenceId, proof);
  for (let i = 0; i < 2; i++) {
    const refreshed = await engine.refreshReview(run.id);
    run = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Reviewer');
    run = await engine.execute(run.id);
    expect((await engine.readiness(target)).missing).not.toContain('recipe:admin:fixture');
  }
  const current = (await store.get<PreparedOperation>('plans', run.planId))!;
  const parent = (await store.get<RunRecord>('runs', current.refreshedFrom!.runId))!;
  for (const patch of [{ supersededBy: 'other' }, { status: 'pending' }, { capabilityEvidence: [] }]) {
    await store.set('runs', parent.id, { ...parent, ...patch });
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:fixture');
  }
  await store.set('runs', parent.id, parent);
  await executeWithWitnesses(engine, run.id);
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Reviewer');
  expect((await engine.readiness(target)).ready).toBe(true);
});
it('validates assisted result contents before refresh or consuming an app-setup receipt', async () => {
  port.runRecipe = (_target, _user, configured) =>
    Promise.resolve({ status: 'manual-pending', capability: 'app-setup', recipeDigest: digest(configured) });
  const prepared = await engine.prepare(target),
    run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  const pending = await executeWithWitnesses(engine, run.id);
  const id = `${run.id}:recipe:${pending.cursor}`;
  const proof = (await store.get<Record<string, unknown>>('capability-evidence', id))!;
  await store.set('capability-evidence', id, { ...proof, result: {} });
  await expect(engine.refreshReview(run.id)).rejects.toThrow('different configuration');
  await engine.attest(target, 'app_setup', 'Reviewer');
  expect((await engine.execute(run.id)).status).toBe('needs-inspection');
  expect(
    (await store.get<RunRecord>('runs', run.id))?.completedSetup?.some((r) => r.check === 'app_setup') ??
      false,
  ).toBe(false);
});
for (const status of ['needs-inspection', 'cancelled', 'superseded'] as const)
  it(`rejects ${status} source execution without a committed refresh`, async () => {
    const { run } = await ready();
    await store.set('runs', run.id, { ...run, status });
    expect((await engine.readiness(target)).ready).toBe(false);
  });
it('validates creation and retained probe results against user, CIDRs and requested failure recovery', () => {
  const probe = engine.project.policy.profiles[0]!.networkProbe!;
  const normal = {
    uid: 10101,
    requestSucceeded: true,
    connectionObserved: true,
    vpnActive: true,
    egressIp: '192.0.2.1',
    errorType: null,
  };
  const valid = { scope: 'probe-app-uid-https-only', normal, failures: [] };
  const user = port.observation.profiles[0]!.user;
  expect(validateProbeResult(probe, valid, user)).toEqual(valid);
  for (const change of [
    { uid: 100101 },
    { egressIp: '203.0.113.1' },
    { vpnActive: false },
    { requestSucceeded: false },
  ])
    expect(() => validateProbeResult(probe, { ...valid, normal: { ...normal, ...change } }, user)).toThrow();
  const failure = {
    stoppedPackage: 'org.example.vpn',
    stopped: {
      ...normal,
      requestSucceeded: false,
      connectionObserved: false,
      egressIp: null,
      errorType: 'ConnectException',
    },
    recovered: normal,
  };
  const configured = { ...probe, failurePackages: ['org.example.vpn'] };
  expect(() => validateProbeResult(configured, { ...valid, failures: [failure] }, user)).not.toThrow();
  for (const change of [
    { stoppedPackage: 'org.other.app' },
    { stopped: normal },
    { recovered: { ...normal, uid: 10102 } },
  ])
    expect(() =>
      validateProbeResult(configured, { ...valid, failures: [{ ...failure, ...change }] }, user),
    ).toThrow();
  expect(() =>
    validateRecipeResult(
      recipe,
      { status: 'measured', capability: 'app-setup', recipeDigest: digest(recipe), postconditions: 0 },
      'measured',
    ),
  ).toThrow();
});
