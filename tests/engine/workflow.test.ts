import { executeWithWitnesses } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { recordObligation } from './obligations.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { digest, requiredAttestations } from '@pxv/contracts';
import type { ExecutionPolicy, SelectedTarget } from '@pxv/contracts';
import { createProject, loadProject, ResourceScope, saveInventory, WorkflowEngine } from '@pxv/engine';
import type { ArtifactPort, PreparedOperation, ProjectContext, RunRecord } from '@pxv/engine';
import { commitProjectFile, deviceLeaseKeys, SqliteStore } from '@pxv/runtime';
import { device, hashA, hashB, policy as setupPolicy, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

describe('reviewed workflows, operator and recipient gates', () => {
  let root = '';
  let store: SqliteStore;
  let context: ProjectContext;
  let engine: WorkflowEngine;
  let port: MemoryPort;
  let now: Date;
  let artifacts: ArtifactPort;
  const target: SelectedTarget = { device, transport: { kind: 'usb', serial: 'PIXEL1' } };
  const configure = async (policy: ExecutionPolicy): Promise<void> => {
    const created = await createProject(
      join(root, `project-${Math.random().toString(16).slice(2)}`),
      product,
      toPolicyDocument(policy),
    );
    await saveInventory(created, { schemaVersion: 1, devices: [port.observation.device] });
    context = await loadProject(created.root, product);
    engine = new WorkflowEngine({
      project: context,
      store,
      port,
      artifacts,
      controlRoot: join(root, 'control'),
      clock: () => now,
    });
  };
  const preparedRun = async (
    operation: 'provision' | 'create-users' | 'deploy-apps' = 'provision',
  ): Promise<{ prepared: PreparedOperation; run: RunRecord }> => {
    const prepared = await engine.prepare(target, operation);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    return { prepared, run };
  };
  const ready = async (): Promise<void> => {
    const { run } = await preparedRun();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
    for (const check of requiredAttestations(context.policy)) await engine.attest(target, check, 'Alice');
    expect((await engine.readiness(target)).ready).toBe(true);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-workflow-'));
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new MemoryPort();
    now = new Date('2026-10-16T09:00:00Z');
    artifacts = {
      snapshot: vi.fn<ArtifactPort['snapshot']>((artifact, path) => Promise.resolve({ ...artifact, path })),
    };
    await configure(basePolicy());
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('attests fresh evidence after a long execution without renewing execution approval', async () => {
    const { prepared, run } = await preparedRun();
    await engine.execute(run.id);
    await engine.attest(target, 'vpn_settings', 'Alice');
    const inspect = port.inspect.bind(port);
    port.inspect = (...args) => {
      now = new Date('2026-10-16T09:16:00Z');
      return inspect(...args);
    };
    await executeWithWitnesses(engine, run.id);
    for (const check of requiredAttestations(context.policy)) await engine.attest(target, check, 'Alice');
    expect((await engine.readiness(target)).ready).toBe(true);
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice')).rejects.toThrow('expired');
    await expect(engine.refreshReview(run.id)).rejects.toThrow('intentional manual');
    await engine.finalize(target, 'Alice');
  });

  it('prepares without phone mutation and atomically deduplicates concurrent exact approvals', async () => {
    const prepared = await engine.prepare(target);
    expect(port.calls).toEqual([]);
    expect(prepared.plan.actions).toEqual([
      { kind: 'vpn', profileId: 'admin', vpn: context.policy.profiles[0]!.vpn },
    ]);
    const submitted = await Promise.all(
      Array.from({ length: 6 }, () => engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice')),
    );
    expect(new Set(submitted.map((run) => run.id)).size).toBe(1);
    expect(await store.entries('runs')).toHaveLength(1);
    await expect(engine.submit(prepared.plan.id, 'different summary', 'Alice')).rejects.toThrow(
      'exact reviewed summary',
    );
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, ' ')).rejects.toThrow('Operator');
    await expect(engine.plan('missing')).rejects.toThrow('does not exist');
  });

  it.each(['operation', 'expiresAt', 'reviewSummary', 'baseline', 'plan', 'target', 'sharedEffects'])(
    'retains and refuses a tampered prepared %s',
    async (field) => {
      const prepared = await engine.prepare(target);
      const changed = structuredClone(prepared) as unknown as Record<string, unknown>;
      if (field === 'operation') changed[field] = 'install-os';
      else if (field === 'expiresAt') changed[field] = '2099-01-01T00:00:00Z';
      else if (field === 'reviewSummary') changed[field] = '{}';
      else if (field === 'baseline') changed[field] = { ...prepared.baseline, debuggingEnabled: false };
      else if (field === 'plan')
        changed[field] = {
          ...prepared.plan,
          actions: [{ kind: 'manual', capability: 'review', instructions: 'Changed' }],
        };
      else if (field === 'sharedEffects') changed[field] = [{ packageId: 'org.example.app', users: [] }];
      else changed[field] = { ...target, transport: { kind: 'wifi', serial: 'untrusted' } };
      await store.set('plans', prepared.plan.id, changed);
      await expect(engine.plan(prepared.plan.id)).rejects.toThrow();
      expect(await store.get('plans', prepared.plan.id)).toEqual(changed);
    },
  );

  it('rejects expired, invalid-date and policy-changed plans and unenrolled targets', async () => {
    const prepared = await engine.prepare(target);
    now = new Date(now.getTime() + 900_001);
    await expect(engine.plan(prepared.plan.id)).rejects.toThrow('expired');
    now = new Date('2026-10-16T09:00:00Z');
    await store.set('plans', prepared.plan.id, { ...prepared, expiresAt: 'invalid-date' });
    await expect(engine.plan(prepared.plan.id)).rejects.toThrow('Malformed');
    await store.set('plans', prepared.plan.id, prepared);
    const changed = new WorkflowEngine({
      project: { ...context, resolved: { ...context.resolved, digest: hashA } },
      store,
      port,
      artifacts,
      controlRoot: join(root, 'control'),
    });
    await expect(changed.plan(prepared.plan.id)).rejects.toThrow('Project policy');
    await expect(
      engine.prepare({ ...target, device: { ...device, canonicalSerial: 'WRONG' } }),
    ).rejects.toThrow('enrolled');
    port.observation.device = { ...device, model: 'Different model' };
    await expect(engine.observe(target)).rejects.toThrow('Observed identity');
  });

  it('creates missing users and deploys apps/settings/permissions/VPN through one shared verified path', async () => {
    const policy = basePolicy();
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    policy.profiles.push({ ...structuredClone(owner), id: 'work', name: 'Work', kind: 'secondary' });
    const observed = port.observation.profiles[0];
    if (!observed) throw new Error('Fixture observation missing');
    observed.packages = [];
    observed.settings = [];
    observed.permissions = [];
    observed.vpn = { packageId: null, alwaysOn: false, lockdown: false };
    await configure(policy);
    const { prepared, run } = await preparedRun();
    expect(prepared.sharedEffects).toEqual([{ packageId: 'org.example.vpn', users: [] }]);
    expect(prepared.reviewSummary).toContain('sharedEffects');
    expect(prepared.plan.actions.map((action) => action.kind)).toEqual([
      'create-user',
      'install-apk',
      'install-apk',
      'setting',
      'permission',
      'setting',
      'permission',
      'manual',
      'manual',
      'vpn',
      'vpn',
    ]);
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('app_setup');
    expect(port.calls).not.toContain('vpn');
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('app_setup');
    expect(port.calls).not.toContain('vpn');
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
    expect((await engine.state('all')).status).toBe('verified');
    expect(port.calls).toContain('create-user');
    expect(port.calls.filter((call) => call === 'install-apk')).toHaveLength(2);
    expect(await store.events(run.id)).not.toHaveLength(0);
  });

  it('separates user creation/deployment and rejects owner absence, downgrade and changed artifact identities', async () => {
    const profile = context.policy.profiles[0];
    if (!profile) throw new Error('Fixture owner missing');
    const two = basePolicy();
    two.profiles.push({ ...structuredClone(profile), id: 'work', name: 'Work', kind: 'secondary' });
    await configure(two);
    await expect(engine.prepare(target, 'deploy-apps')).rejects.toThrow('existing Android users');
    const { run } = await preparedRun('create-users');
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
    expect(port.calls).toEqual(['create-user']);
    port.observation.profiles = [];
    await expect(engine.prepare(target)).rejects.toThrow('owner user');
    port = new MemoryPort();
    const installed = port.observation.profiles[0]?.packages[0];
    if (!installed) throw new Error('Fixture installed package missing');
    installed.versionCode = 99;
    await configure(basePolicy());
    await expect(engine.prepare(target)).rejects.toThrow('downgrade');
    installed.versionCode = 1;
    artifacts.snapshot = () =>
      Promise.resolve({
        ...profile.packages[0],
        packageId: 'org.example.wrong',
        versionCode: 1,
        signerSha256: hashB,
        sha256: hashA,
        path: '/tmp/wrong.apk',
      });
    await expect(engine.prepare(target)).rejects.toThrow('different identity');
  });

  it('rejects an owner display-name mismatch before acquiring artifacts or retaining executable plans', async () => {
    const desired = basePolicy();
    const owner = desired.profiles[0];
    const observed = port.observation.profiles[0];
    if (!owner || !observed) throw new Error('Fixture owner missing');
    owner.name = 'Owner';
    observed.user.name = 'Właściciel';
    observed.packages = [];
    const snapshot = vi.fn<ArtifactPort['snapshot']>((artifact) => Promise.resolve(artifact));
    artifacts.snapshot = snapshot;
    await configure(desired);
    for (const operation of ['create-users', 'deploy-apps', 'provision'] as const)
      await expect(engine.prepare(target, operation)).rejects.toThrow(
        'Owner display name differs; update policy or rename on device and prepare again',
      );
    expect(snapshot).not.toHaveBeenCalled();
    expect(port.calls).toEqual([]);
    expect(await store.entries('plans')).toEqual([]);
    expect(await store.entries('runs')).toEqual([]);
    expect(observed.user.name).toBe('Właściciel');
  });

  it('requires and binds all-user APK effects, including users outside selected policy', async () => {
    const installed = port.observation.profiles[0]?.packages[0];
    if (!installed) throw new Error('Fixture installed package missing');
    installed.versionCode = 1;
    port.sharedEffects = () =>
      Promise.resolve([
        {
          packageId: 'org.example.vpn',
          users: [
            { user: { userId: 10, serialNo: 77, name: 'Unmanaged' }, versionCode: 99, signerSha256: hashB },
          ],
        },
      ]);
    await expect(engine.prepare(target)).rejects.toThrow('another Android user');
    port.sharedEffects = () => Promise.resolve([]);
    await expect(engine.prepare(target)).rejects.toThrow('incomplete');
    const without = { ...port, inspect: port.inspect.bind(port), sharedEffects: undefined };
    const unavailable = new WorkflowEngine({
      project: context,
      store,
      port: without as never,
      artifacts,
      controlRoot: join(root, 'control'),
    });
    await expect(unavailable.prepare(target)).rejects.toThrow('review service');
    port.sharedEffects = () =>
      Promise.resolve([
        { packageId: 'org.example.vpn', users: [] },
        { packageId: 'org.example.vpn', users: [] },
      ]);
    await expect(engine.prepare(target)).rejects.toThrow('Duplicate shared');
  });

  it('blocks live drift and never replays interrupted or failed mutations', async () => {
    const profile = port.observation.profiles[0];
    if (!profile) throw new Error('Fixture owner missing');
    profile.settings = [];
    const { run } = await preparedRun();
    port.observation.debuggingEnabled = false;
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect(port.calls).toEqual([]);
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    await store.set('runs', run.id, { ...run, status: 'running' });
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('running');
    await expect(executeWithWitnesses(engine, 'unknown')).rejects.toThrow('Unknown approved');
  });

  it('preserves pending intent and inspection barriers when a mutation fails', async () => {
    const profile = port.observation.profiles[0];
    if (!profile) throw new Error('Fixture owner missing');
    profile.settings = [];
    port.failAt = 'setting';
    const { run } = await preparedRun();
    expect(await executeWithWitnesses(engine, run.id)).toMatchObject({
      status: 'needs-inspection',
      error: 'Injected setting failure',
    });
    expect(
      (await store.events<{ type: string }>(run.id)).some((value) => value.event.type === 'intent'),
    ).toBe(true);
    expect(port.calls).toEqual(['setting']);
    await executeWithWitnesses(engine, run.id);
    expect(port.calls).toEqual(['setting']);
  });

  it('honors persisted and external cancellation without replay', async () => {
    const { run } = await preparedRun();
    await engine.cancel(run.id);
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('cancelled');
    await expect(engine.cancel('unknown')).rejects.toThrow('Unknown run');
    const next = await preparedRun();
    const controller = new AbortController();
    controller.abort();
    expect((await executeWithWitnesses(engine, next.run.id, controller.signal)).status).toBe('cancelled');
  });

  it('pauses for normal credentials, applies final language once, then pauses for optional duress', async () => {
    const desired = structuredClone(setupPolicy);
    desired.requiredAttestations = ['operator_signoff', 'recipient_acceptance'];
    const profile = port.observation.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.language = 'en-US';
    await configure(desired);
    const { run } = await preparedRun();
    const first = await executeWithWitnesses(engine, run.id);
    expect(first).toMatchObject({ status: 'pending', manualGate: 'normal_credentials' });
    expect(port.calls).toEqual([]);
    expect((await engine.state('all')).pending).toContain('manual:normal_credentials');
    await expect(engine.attest(target, 'duress', 'Alice')).rejects.toThrow('Contradictory');
    await engine.attest(target, 'normal_credentials', 'Alice');
    const second = await executeWithWitnesses(engine, run.id);
    expect(second).toMatchObject({ status: 'pending', manualGate: 'duress' });
    expect(port.calls).toEqual(['language']);
    await engine.attest(target, 'duress', 'Alice');
    const third = await executeWithWitnesses(engine, run.id);
    expect(third.status).toBe('pending');
    expect(third.manualGate).toBeUndefined();
    expect(port.calls).toEqual(['language']);
    for (const check of ['operator_signoff', 'recipient_acceptance', 'verified_boot'])
      await engine.attest(target, check, 'Alice');
    expect((await engine.readiness(target)).ready).toBe(true);
    const another = await engine.prepare(target);
    expect(another.plan.actions.filter((action) => action.kind === 'language')).toEqual([]);
  });

  it('requires normal credential receipts and completed language setup before duress attestation', async () => {
    await configure(structuredClone(setupPolicy));
    const { run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    expect(port.observation.profiles[0]?.language).toBe(context.policy.profiles[0]?.language);
    await expect(engine.attest(target, 'duress', 'Alice')).rejects.toThrow(
      'Normal credentials and final language must be complete',
    );
    await engine.attest(target, 'normal_credentials', 'Alice');
    await executeWithWitnesses(engine, run.id);
    expect((await engine.state('all')).languageReady).toBe(true);
    await store.delete('attestations', 'all');
    await expect(engine.attest(target, 'duress', 'Alice')).rejects.toThrow(
      'Normal credentials and final language must be complete',
    );
  });

  it('blocks non-language contradictions from being overridden by normal credential receipts', async () => {
    const desired = structuredClone(setupPolicy);
    await configure(desired);
    const { run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    const state = await engine.state('all');
    const permission = port.observation.profiles[0]?.permissions[0];
    if (!permission) throw new Error('Fixture permission missing');
    permission.granted = false;
    await store.set('workflow', 'all', { ...state, observation: port.observation });
    await expect(engine.attest(target, 'normal_credentials', 'Alice')).rejects.toThrow('Contradictory');
  });

  it('refreshes an expired normal-credential checkpoint only through a new exact review', async () => {
    await configure(structuredClone(setupPolicy));
    const { prepared, run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    now = new Date(now.getTime() + 16 * 60_000);
    await expect(engine.attest(target, 'normal_credentials', 'Alice')).rejects.toThrow('15 minutes');
    await expect(executeWithWitnesses(engine, run.id)).rejects.toThrow('expired');
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.id).not.toBe(prepared.plan.id);
    expect(refreshed.plan.actions).toEqual(prepared.plan.actions.slice(1));
    expect(refreshed.refreshedFrom).toMatchObject({
      runId: run.id,
      completedActions: 1,
      completedSetup: [],
    });
    expect(await executeWithWitnesses(engine, run.id)).toMatchObject({
      status: 'superseded',
      supersededBy: refreshed.plan.id,
    });
    await expect(engine.submit(refreshed.plan.id, prepared.reviewSummary, 'Alice')).rejects.toThrow('exact');
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect(next.cursor).toBe(0);
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('normal_credentials');
    await engine.attest(target, 'normal_credentials', 'Alice');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('duress');
    expect((await engine.readiness(target)).missing).toContain('operator_signoff');
    await expect(engine.refreshReview(run.id)).rejects.toThrow('intentional manual');
  });

  it('refreshes completed private language setup without repeating UI or inheriting final signoff', async () => {
    const observed = port.observation.profiles[0];
    if (!observed) throw new Error('Fixture profile missing');
    observed.language = 'en-US';
    await configure(structuredClone(setupPolicy));
    port.language = () =>
      Promise.resolve({ status: 'manual-pending', instructions: 'Set the language privately.' });
    const { run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    const normal = await engine.attest(target, 'normal_credentials', 'Alice');
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('language:admin');
    now = new Date(now.getTime() + 16 * 60_000);
    observed.language = 'pl-PL';
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions).toEqual([
      expect.objectContaining({ kind: 'manual', capability: 'duress' }),
    ]);
    expect(refreshed.refreshedFrom?.completedSetup).toEqual([
      { check: 'normal_credentials', receiptId: normal.id, planDigest: normal.planDigest },
    ]);
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('duress');
    await engine.attest(target, 'duress', 'Alice');
    await executeWithWitnesses(engine, next.id);
    expect((await engine.readiness(target)).missing).not.toContain('normal_credentials');
    expect((await engine.readiness(target)).missing).toContain('operator_signoff');
    expect(port.calls).toEqual([]);
  });

  it('keeps an unchanged manual language checkpoint across repeated reviews without replay', async () => {
    const observed = port.observation.profiles[0];
    if (!observed) throw new Error('Fixture profile missing');
    observed.language = 'en-US';
    await configure(structuredClone(setupPolicy));
    let calls = 0;
    port.language = () => {
      calls++;
      return Promise.resolve({ status: 'manual-pending', instructions: 'Set the language privately.' });
    };
    const { run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    await engine.attest(target, 'normal_credentials', 'Alice');
    await executeWithWitnesses(engine, run.id);
    now = new Date(now.getTime() + 16 * 60_000);
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions[0]?.kind).toBe('language');
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('language:admin');
    expect(calls).toBe(2); // Reopening the explicitly reviewed remaining language guide is allowed.
    now = new Date(now.getTime() + 16 * 60_000);
    observed.language = 'pl-PL';
    const again = await engine.refreshReview(next.id);
    const final = await engine.submit(again.plan.id, again.reviewSummary, 'Alice');
    expect((await executeWithWitnesses(engine, final.id)).manualGate).toBe('duress');
    await engine.attest(target, 'duress', 'Alice');
    expect(calls).toBe(2);
  });

  it.each(['permission', 'serial', 'language-and-permission'])(
    'refuses %s drift during review refresh',
    async (drift) => {
      const observed = port.observation.profiles[0];
      if (!observed) throw new Error('Fixture profile missing');
      observed.language = 'en-US';
      await configure(structuredClone(setupPolicy));
      port.language = () =>
        Promise.resolve({ status: 'manual-pending', instructions: 'Set the language privately.' });
      const { run } = await preparedRun();
      await executeWithWitnesses(engine, run.id);
      if (drift === 'language-and-permission') {
        await engine.attest(target, 'normal_credentials', 'Alice');
        await executeWithWitnesses(engine, run.id);
        observed.language = 'pl-PL';
      }
      if (drift === 'serial') observed.user.serialNo++;
      else if (observed.permissions[0]) observed.permissions[0].granted = false;
      now = new Date(now.getTime() + 16 * 60_000);
      await expect(engine.refreshReview(run.id)).rejects.toThrow(/changed/u);
      expect(await store.get<RunRecord>('runs', run.id)).toMatchObject({ status: 'pending' });
      expect(await store.entries('plans')).toHaveLength(1);
    },
  );

  it('preserves uncommitted refreshed reviews and refuses unresolved cleanup or interrupted runs', async () => {
    await expect(engine.refreshReview('missing')).rejects.toThrow('intentional manual');
    await configure(structuredClone(setupPolicy));
    const { run } = await preparedRun();
    await expect(engine.refreshReview(run.id)).rejects.toThrow('intentional manual');
    await executeWithWitnesses(engine, run.id);
    const scope = new ResourceScope(store, device.canonicalSerial, run.id);
    await recordObligation(scope, 'helper', 'test-helper', {});
    await expect(engine.refreshReview(run.id)).rejects.toThrow('Recover unresolved');
    await scope.cleanup(
      (user) => Promise.resolve(user),
      () => Promise.resolve(),
    );
    const cas = vi.spyOn(store, 'transition').mockResolvedValueOnce(false);
    await expect(engine.refreshReview(run.id)).rejects.toThrow('checkpoint changed');
    cas.mockRestore();
    const retained = (await store.entries<PreparedOperation>('plans')).find(
      (value) => value.key !== run.planId,
    );
    if (!retained) throw new Error('Uncommitted candidate missing');
    await expect(
      engine.submit(retained.value.plan.id, retained.value.reviewSummary, 'Alice'),
    ).rejects.toThrow('not committed');
    expect(await store.get('runs', run.id)).toMatchObject({ status: 'pending' });
  });

  it('refreshes a paused import while preserving completed recipe history and requiring a new app receipt', async () => {
    const policy = structuredClone(setupPolicy);
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.recipes = ['first', 'private-import'].map((id) => ({
      schemaVersion: 1,
      id,
      packageId: 'org.example.vpn',
      versionCode: 12,
      signerSha256: hashB,
      buildFingerprint: 'fixture/build',
      steps: [{ action: 'back' }],
      postconditions: [{ resourceId: 'org.example.vpn:id/ready' }],
    }));
    const calls: string[] = [];
    port.runRecipe = (_target, _user, recipe) => {
      calls.push(recipe.id);
      return Promise.resolve({
        status: recipe.id === 'first' ? 'measured' : 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(recipe),
        postconditions: 1,
      });
    };
    await configure(policy);
    const { run } = await preparedRun();
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('app_setup');
    await engine.attest(target, 'app_setup', 'Alice');
    now = new Date(now.getTime() + 16 * 60_000);
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions[0]).toMatchObject({ kind: 'recipe', recipe: { id: 'private-import' } });
    expect(refreshed.refreshedFrom?.capabilityEvidence).toHaveLength(1);
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('app_setup');
    expect(calls).toEqual(['first', 'private-import']);
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('normal_credentials');
    expect(
      (await engine.state('all')).capabilityEvidence?.filter((value) => value.kind === 'recipe'),
    ).toHaveLength(2);
    expect(calls).toEqual(['first', 'private-import']);
  });

  it('requires fresh measured checks, helper cleanup and exact current receipts before handoff', async () => {
    await expect(engine.state('all')).rejects.toThrow('Fresh provisioning');
    await ready();
    await expect(engine.attest(target, 'unknown_check', 'Alice')).rejects.toThrow('does not belong');
    const scope = new ResourceScope(store, device.canonicalSerial, 'parent');
    await recordObligation(scope, 'helper', 'probe', {});
    expect((await engine.readiness(target)).missing).toContain('cleanup');
    await scope.cleanup(
      (user) => Promise.resolve(user),
      () => Promise.resolve(),
    );
    const state = await engine.state('all');
    await store.set('workflow', 'all', {
      ...state,
      observation: { ...state.observation, helpers: ['org.example.helper'] },
    });
    expect((await engine.readiness(target)).missing).toContain('helper-removal');
    await store.set('workflow', 'all', state);
    now = new Date(now.getTime() + 900_001);
    await expect(engine.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow('15 minutes');
    await expect(engine.finalize(target, 'Alice')).rejects.toThrow('15 minutes');
  });

  it.each(['device', 'transport'])(
    'refuses custody while a matching native %s reservation remains',
    async (matching) => {
      await ready();
      const handoff = await engine.finalize(target, 'Alice', 'en');
      const keys = deviceLeaseKeys(
        digest({ kind: device.kind, serial: device.canonicalSerial }),
        digest(target.transport.serial),
      );
      const directory = join(root, 'control/reservations');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'failed-finalization.json');
      await writeFile(
        path,
        JSON.stringify({
          schema: 1,
          operation_id: 'failed-finalization',
          device_key: matching === 'device' ? keys.device : hashA,
          transport_key: matching === 'transport' ? keys.transport : hashB,
          supervisor: {
            pid: 999999,
            start_ticks: '1',
            boot_id: 'previous-boot',
            uid: process.getuid?.() ?? 0,
          },
          status: 'recovery_required',
          cleanup_proven: true,
        }),
      );
      await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('Native recovery');
      expect((await engine.readiness(target)).ready).toBe(false);
      expect((await engine.readiness(target)).missing).toContain('native-recovery');
      expect((await engine.state('all')).status).toBe('shutdown-requested');
      expect(await store.get('handoff', 'all')).toEqual(handoff);
      // Another phone's reservation must not block an already finalized asset.
      await writeFile(
        path,
        JSON.stringify({
          schema: 1,
          operation_id: 'unrelated-operation',
          device_key: hashA,
          transport_key: hashB,
          supervisor: {
            pid: 999999,
            start_ticks: '1',
            boot_id: 'previous-boot',
            uid: process.getuid?.() ?? 0,
          },
          status: 'recovery_required',
          cleanup_proven: true,
        }),
      );
      expect((await engine.acceptCustody('all', 'Recipient', true)).outcome).toBe('completed-custody');
    },
  );

  it('refuses custody if enrollment no longer matches the accepted canonical device', async () => {
    await ready();
    await engine.finalize(target, 'Alice', 'en');
    const enrolled = engine.project.inventory.devices[0];
    if (!enrolled) throw new Error('Fixture enrollment missing');
    enrolled.canonicalSerial = 'REPLACED';
    await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('handoff identity differs');
    expect((await engine.state('all')).status).toBe('shutdown-requested');
  });

  it('prepares and executes policy-constrained extension core actions with pinned artifacts', async () => {
    const profile = context.policy.profiles[0];
    const artifact = profile?.packages[0];
    if (!profile || !artifact) throw new Error('Fixture artifact missing');
    const prepared = await engine.prepareExtension(target, [
      { kind: 'install-apk', profileId: 'admin', artifact },
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review extension action.' },
    ]);
    expect(prepared.operation).toBe('extension');
    expect(prepared.plan.actions[0]).toMatchObject({
      kind: 'install-apk',
      artifact: { path: join(context.root, 'state/plans', prepared.plan.id, '0-admin-org.example.vpn.apk') },
    });
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('operator_signoff');
    await engine.attest(target, 'operator_signoff', 'Alice');
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    await expect(engine.prepareExtension(target, [])).rejects.toThrow('bounded nonempty');
    await expect(engine.prepare(target, 'extension')).rejects.toThrow('prepareExtension');
    await expect(
      engine.prepareExtension(target, [{ kind: 'manual', capability: 'unknown', instructions: 'No' }]),
    ).rejects.toThrow('outside selected');
    await expect(
      engine.prepareExtension(target, [{ kind: 'vpn', profileId: 'missing', vpn: profile.vpn }]),
    ).rejects.toThrow('outside selected');
    await expect(
      engine.prepareExtension(target, [
        { kind: 'vpn', profileId: 'admin', vpn: { packageId: null, alwaysOn: false, lockdown: false } },
      ]),
    ).rejects.toThrow('contradicts');
  });

  it('requires pinned USB OS snapshots and binds their hashes into the reviewed plan', async () => {
    await expect(engine.prepare(target, 'install-os')).rejects.toThrow('pinned OS policy');
    const desired = basePolicy();
    desired.osByCodename = {
      akita: {
        codename: 'akita',
        release: '2026100600',
        url: 'https://example.org/os.zip',
        signatureUrl: 'https://example.org/os.zip.sig',
        publicKey: 'ssh-ed25519 AAAA',
        signerPrincipal: 'release@example.org',
        namespace: 'factory images',
      },
    };
    await configure(desired);
    await expect(engine.prepare(target, 'install-os')).rejects.toThrow('snapshot service');
    artifacts.snapshotOs = (os, path) =>
      Promise.resolve({
        path,
        signaturePath: `${path}.sig`,
        sha256: hashA,
        signatureSha256: hashB,
        policy: os,
      });
    const prepared = await engine.prepare(target, 'install-os');
    expect(prepared.baseline.os.release).toBe('unobserved');
    expect(prepared.osSnapshot?.sha256).toBe(hashA);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    expect(await executeWithWitnesses(engine, run.id)).toMatchObject({
      status: 'pending',
      pauseReason: { kind: 'reenrollment' },
    });
    expect(port.calls).toEqual(['install-os']);
    const extension = await engine.prepareExtension(target, [
      { kind: 'install-os', os: desired.osByCodename.akita! },
    ]);
    expect(extension.operation).toBe('install-os');
    await expect(
      engine.prepareExtension(target, [
        { kind: 'install-os', os: desired.osByCodename.akita! },
        { kind: 'manual', capability: 'operator_signoff', instructions: 'mixed' },
      ]),
    ).rejects.toThrow('separate operation');
  });

  it('selects the matching GrapheneOS pin for a mixed-model policy', async () => {
    const desired = basePolicy();
    const pin = {
      codename: 'akita',
      release: '2026100600',
      url: 'https://example.org/akita.zip',
      signatureUrl: 'https://example.org/akita.zip.sig',
      publicKey: 'ssh-ed25519 AAAA',
      signerPrincipal: 'release@example.org',
      namespace: 'factory images',
    };
    desired.osByCodename = { akita: pin, husky: { ...pin, codename: 'husky' } };
    await configure(desired);
    artifacts.snapshotOs = (os, path) =>
      Promise.resolve({
        path,
        signaturePath: `${path}.sig`,
        sha256: hashA,
        signatureSha256: hashB,
        policy: os,
      });
    const prepared = await engine.prepare(target, 'install-os');
    expect(prepared.osSnapshot?.policy.codename).toBe('akita');
    expect(prepared.plan.actions).toEqual([{ kind: 'install-os', os: pin }]);
    await expect(
      engine.prepareExtension(target, [{ kind: 'install-os', os: desired.osByCodename['husky']! }]),
    ).rejects.toThrow('selected policy');
    expect(port.calls).toEqual([]);
  });

  it('executes bounded fleet jobs under shared project ownership and independent phone leases', async () => {
    const second = {
      ...device,
      assetId: 'second',
      canonicalSerial: 'PIXEL2',
      transports: [{ kind: 'usb' as const, serial: 'PIXEL2' }],
    };
    await saveInventory(context, { schemaVersion: 1, devices: [device, second] });
    context = await loadProject(context.root, product);
    port.inspect = (selected) =>
      Promise.resolve({ ...structuredClone(port.observation), device: selected.device });
    engine = new WorkflowEngine({
      project: context,
      store,
      port,
      artifacts,
      controlRoot: join(root, 'control'),
      clock: () => now,
    });
    const runs: RunRecord[] = [];
    for (const selected of [
      target,
      { device: second, transport: { kind: 'usb' as const, serial: 'PIXEL2' } },
    ]) {
      const prepared = await engine.prepare(selected, 'create-users');
      runs.push(await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice'));
    }
    const results = await engine.executeFleet(
      runs.map((run) => run.id),
      2,
    );
    expect(results.map((run) => run.status)).toEqual(['completed', 'completed']);
    expect(await engine.executeFleet([], 1)).toEqual([]);
    await expect(engine.executeFleet([runs[0]?.id ?? 'none'], 0)).rejects.toThrow('1 to 8');
    await expect(engine.executeFleet(['unknown'], 2)).rejects.toThrow('Unknown approved');
    expect(digest(results.map((run) => run.id))).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('retains the accepted policy/product snapshot and rejects mismatched or tampered handoff exports', async () => {
    await expect(engine.acceptedHandoff('all')).rejects.toThrow('Finalize');
    await ready();
    const record = await engine.finalize(target, 'Alice');
    const accepted = await engine.acceptedHandoff('all');
    expect(accepted.snapshot.resolvedPolicy.digest).toBe(record.policyDigest);
    const acceptedName = accepted.snapshot.resolvedPolicy.policy.name;
    context.policy.name = 'Unaccepted replacement policy';
    expect((await engine.acceptedHandoff('all')).snapshot.resolvedPolicy.policy.name).toBe(acceptedName);
    await store.set('handoff-snapshots', record.id, { ...accepted.snapshot, assetId: 'other' });
    await expect(engine.acceptedHandoff('all')).rejects.toThrow('does not match');
    const changed = structuredClone(accepted.snapshot);
    changed.resolvedPolicy.policy.name = 'Forged snapshot';
    await store.set('handoff-snapshots', record.id, changed);
    await expect(engine.acceptedHandoff('all')).rejects.toThrow('snapshot digest mismatch');
  });
  it('rejects attestation against a workflow generation changed during live measurement', async () => {
    const { run } = await preparedRun();
    await executeWithWitnesses(engine, run.id);
    const before = await engine.state('all');
    const inspect = port.inspect.bind(port);
    vi.spyOn(port, 'inspect').mockImplementationOnce(async (...args) => {
      await store.set('workflow', 'all', { ...before, pending: ['external-evidence-generation'] });
      return inspect(...args);
    });
    await expect(engine.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow('evidence changed');
    expect((await engine.receipts('all')).filter((value) => value.check !== 'vpn_settings')).toEqual([]);
    expect((await engine.state('all')).pending).toEqual(['external-evidence-generation']);
  });

  it('atomically rolls back completed handoff state when its durable event fails', async () => {
    await ready();
    const db = new DatabaseSync(join(root, 'state.sqlite'));
    db.exec(
      "CREATE TRIGGER handoff_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.type')='ready-for-handoff' BEGIN SELECT RAISE(ABORT,'handoff-audit-fault'); END",
    );
    try {
      await expect(engine.finalize(target, 'Alice')).rejects.toThrow('handoff-audit-fault');
      expect(port.calls).toContain('finalize');
      expect(await store.get('handoff', 'all')).toBeUndefined();
      expect(await store.entries('handoff-snapshots')).toEqual([]);
      expect(await engine.state('all')).toMatchObject({ status: 'pending', pending: ['debugging-shutdown'] });
      await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('after finalization');
    } finally {
      db.close();
    }
  });

  it('atomically preserves shutdown-requested custody on audit failure and concurrent generation changes', async () => {
    await ready();
    const record = await engine.finalize(target, 'Alice');
    const db = new DatabaseSync(join(root, 'state.sqlite'));
    db.exec(
      "CREATE TRIGGER custody_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.type')='custody-accepted' BEGIN SELECT RAISE(ABORT,'custody-audit-fault'); END",
    );
    try {
      await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('custody-audit-fault');
      expect(await store.get('handoff', 'all')).toEqual(record);
      expect((await engine.state('all')).status).toBe('shutdown-requested');
      db.exec('DROP TRIGGER custody_fault');
      const transition = store.transition.bind(store);
      vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
        await store.set('handoff', 'all', { ...record, operator: 'Bob' });
        return transition(input);
      });
      await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('evidence changed');
      expect(await store.get('handoff', 'all')).toEqual({ ...record, operator: 'Bob' });
      expect((await engine.state('all')).status).toBe('shutdown-requested');
    } finally {
      db.close();
    }
  });

  it('preserves a changed workflow generation and blocks readiness after checkpoint conflict', async () => {
    const { run } = await preparedRun();
    const transitions = store.transition.bind(store);
    let injected = false;
    vi.spyOn(store, 'transition').mockImplementation(async (input) => {
      const completed = input.changes.find((item) => item.kind === 'set' && item.collection === 'workflow');
      if (
        !injected &&
        completed?.kind === 'set' &&
        (completed.value as { status?: string }).status === 'verified'
      ) {
        injected = true;
        await store.set('workflow', 'all', {
          ...(completed.value as object),
          status: 'failed',
          pending: ['storage-fault'],
        });
      }
      return transitions(input);
    });
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect((await engine.readiness(target)).missing).toContain('execution-inspection');
  });

  it('invalidates measured workflow evidence when retained native completion bytes are malformed', async () => {
    const { run } = await preparedRun();
    const transition = store.transition.bind(store);
    vi.spyOn(store, 'transition').mockImplementation(async (input) => {
      const committed = await transition(input);
      if (
        input.changes.some(
          (item) =>
            item.kind === 'set' &&
            item.collection === 'workflow' &&
            (item.value as { status?: string }).status === 'verified',
        )
      ) {
        const directory = join(root, 'control/receipts');
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, run.id + '-00000000-0000-0000-0000-000000000000.json'),
          '{retained-malformed-native',
        );
      }
      return committed;
    });
    expect(await executeWithWitnesses(engine, run.id)).toMatchObject({
      status: 'needs-inspection',
      error: 'Native completion receipts are malformed or unavailable; preserve them for inspection',
    });
    expect((await engine.state('all')).status).toBe('failed');
    expect((await engine.readiness(target)).missing).toContain('execution-inspection');
  });
  it.each(['policy', 'config', 'inventory'] as const)(
    'rejects stale %s source revisions under project ownership before approval or device execution',
    async (source) => {
      const { prepared, run } = await preparedRun();
      const latest = await loadProject(context.root, product);
      const files = {
        policy: latest.config.policyFile,
        config: 'pxv.project.json',
        inventory: latest.config.inventoryFile,
      };
      const next = {
        policy: toPolicyDocument({ ...latest.policy, name: 'Changed by a second operator' }),
        config: { ...latest.config, inventoryFile: 'different-inventory.json' },
        inventory: { ...latest.inventory, devices: [{ ...device, groups: ['updated'] }] },
      };
      await commitProjectFile({
        path: join(latest.root, files[source]),
        projectId: latest.config.id,
        controlRoot: engine.controlRoot,
        expectedSha256: latest.revisions[source],
        data: JSON.stringify(next[source]),
      });
      await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice')).rejects.toThrow(
        'Project source changed',
      );
      await expect(executeWithWitnesses(engine, run.id)).rejects.toThrow('Project source changed');
      await expect(engine.executeFleet([run.id], 1)).rejects.toThrow('Project source changed');
      await expect(engine.refreshReview(run.id)).rejects.toThrow('Project source changed');
      expect(port.calls).toEqual([]);
      expect((await store.get<RunRecord>('runs', run.id))?.status).toBe('queued');
    },
  );

  it('invalidates cached approvals when actual executable bytes change before acquiring project ownership', async () => {
    const codeRoot = join(root, 'isolated-code');
    await mkdir(join(codeRoot, 'packages/core'), { recursive: true });
    const source = join(codeRoot, 'packages/core/index.js');
    await writeFile(source, 'export const version=1;');
    const created = await createProject(
      join(root, 'isolated-project'),
      product,
      toPolicyDocument(basePolicy()),
      codeRoot,
    );
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const project = await loadProject(created.root, product, codeRoot);
    const isolated = new WorkflowEngine({
      project,
      port,
      artifacts,
      store,
      controlRoot: engine.controlRoot,
      clock: () => now,
    });
    const prepared = await isolated.prepare(target);
    const run = await isolated.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    await writeFile(source, 'export const version=2;');
    await expect(isolated.submit(prepared.plan.id, prepared.reviewSummary, 'Alice')).rejects.toThrow(
      'Executable build changed',
    );
    await expect(isolated.execute(run.id)).rejects.toThrow('Executable build changed');
    expect(port.calls).toEqual([]);
  });
  it('blocks stale-context signoff and finalization before any debugging mutation or handoff write', async () => {
    await ready();
    await commitProjectFile({
      path: join(context.root, context.config.policyFile),
      projectId: context.config.id,
      controlRoot: engine.controlRoot,
      expectedSha256: context.revisions.policy,
      data: JSON.stringify(toPolicyDocument({ ...context.policy, name: 'Changed after signoff prompt' })),
    });
    await expect(engine.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow(
      'Project source changed',
    );
    await expect(engine.finalize(target, 'Alice')).rejects.toThrow('Project source changed');
    await expect(engine.readiness(target)).rejects.toThrow('Project source changed');
    expect(port.calls).not.toContain('finalize');
    expect(await store.get('handoff', 'all')).toBeUndefined();
  });

  it('blocks stale-context custody when inventory changed after the physical confirmation prompt', async () => {
    await ready();
    const record = await engine.finalize(target, 'Alice');
    await commitProjectFile({
      path: join(context.root, context.config.inventoryFile),
      projectId: context.config.id,
      controlRoot: engine.controlRoot,
      expectedSha256: context.revisions.inventory,
      data: JSON.stringify({ schemaVersion: 1, devices: [{ ...device, groups: ['changed-after-prompt'] }] }),
    });
    await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('Project source changed');
    expect(await store.get('handoff', 'all')).toEqual(record);
    expect((await engine.state('all')).status).toBe('shutdown-requested');
  });
});
