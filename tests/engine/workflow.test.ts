import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest, observationDigest, requiredAttestations } from '@pxv/contracts';
import type { PolicyPack, SelectedTarget } from '@pxv/contracts';
import { createProject, loadProject, ResourceScope, saveInventory, WorkflowEngine } from '@pxv/engine';
import type { ArtifactPort, PreparedOperation, ProjectContext, RunRecord } from '@pxv/engine';
import { deviceLeaseKeys, SqliteStore } from '@pxv/runtime';
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
  const configure = async (policy: PolicyPack): Promise<void> => {
    const created = await createProject(
      join(root, `project-${Math.random().toString(16).slice(2)}`),
      product,
      policy,
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
    expect((await engine.execute(run.id)).status).toBe('pending');
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

  it('prepares without phone mutation and atomically deduplicates concurrent exact approvals', async () => {
    const prepared = await engine.prepare(target);
    expect(port.calls).toEqual([]);
    expect(prepared.plan.actions).toEqual([]);
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
      'install-apk',
      'setting',
      'permission',
      'vpn',
      'create-user',
      'install-apk',
      'setting',
      'permission',
      'vpn',
    ]);
    expect((await engine.execute(run.id)).status).toBe('pending');
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
    expect((await engine.execute(run.id)).status).toBe('pending');
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
    expect((await engine.execute(run.id)).status).toBe('needs-inspection');
    expect(port.calls).toEqual([]);
    expect((await engine.execute(run.id)).status).toBe('needs-inspection');
    await store.set('runs', run.id, { ...run, status: 'running' });
    expect((await engine.execute(run.id)).status).toBe('running');
    await expect(engine.execute('unknown')).rejects.toThrow('Unknown approved');
  });

  it('preserves pending intent and inspection barriers when a mutation fails', async () => {
    const profile = port.observation.profiles[0];
    if (!profile) throw new Error('Fixture owner missing');
    profile.settings = [];
    port.failAt = 'setting';
    const { run } = await preparedRun();
    expect(await engine.execute(run.id)).toMatchObject({
      status: 'needs-inspection',
      error: 'Injected setting failure',
    });
    expect(
      (await store.events<{ type: string }>(run.id)).some((value) => value.event.type === 'intent'),
    ).toBe(true);
    expect(port.calls).toEqual(['setting']);
    await engine.execute(run.id);
    expect(port.calls).toEqual(['setting']);
  });

  it('honors persisted and external cancellation without replay', async () => {
    const { run } = await preparedRun();
    await engine.cancel(run.id);
    expect((await engine.execute(run.id)).status).toBe('cancelled');
    await expect(engine.cancel('unknown')).rejects.toThrow('Unknown run');
    const next = await preparedRun();
    const controller = new AbortController();
    controller.abort();
    expect((await engine.execute(next.run.id, controller.signal)).status).toBe('cancelled');
  });

  it('pauses for normal credentials, applies final language once, then pauses for optional duress', async () => {
    const desired = structuredClone(setupPolicy);
    desired.requiredAttestations = ['operator_signoff', 'recipient_acceptance'];
    const profile = port.observation.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.language = 'en-US';
    await configure(desired);
    const { run } = await preparedRun();
    const first = await engine.execute(run.id);
    expect(first).toMatchObject({ status: 'pending', manualGate: 'normal_credentials' });
    expect(port.calls).toEqual([]);
    expect((await engine.state('all')).pending).toContain('manual:normal_credentials');
    await expect(engine.attest(target, 'duress', 'Alice')).rejects.toThrow('Contradictory');
    await engine.attest(target, 'normal_credentials', 'Alice');
    const second = await engine.execute(run.id);
    expect(second).toMatchObject({ status: 'pending', manualGate: 'duress' });
    expect(port.calls).toEqual(['language']);
    await engine.attest(target, 'duress', 'Alice');
    const third = await engine.execute(run.id);
    expect(third.status).toBe('pending');
    expect(third.manualGate).toBeUndefined();
    expect(port.calls).toEqual(['language']);
    for (const check of ['operator_signoff', 'recipient_acceptance', 'verified_boot'])
      await engine.attest(target, check, 'Alice');
    expect((await engine.readiness(target)).ready).toBe(true);
    const another = await engine.prepare(target);
    expect(another.plan.actions.filter((action) => action.kind === 'language')).toEqual([]);
  });

  it('blocks non-language contradictions from being overridden by normal credential receipts', async () => {
    const desired = structuredClone(setupPolicy);
    await configure(desired);
    const { run } = await preparedRun();
    await engine.execute(run.id);
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
    await engine.execute(run.id);
    now = new Date(now.getTime() + 16 * 60_000);
    await expect(engine.attest(target, 'normal_credentials', 'Alice')).rejects.toThrow('15 minutes');
    await expect(engine.execute(run.id)).rejects.toThrow('expired');
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.id).not.toBe(prepared.plan.id);
    expect(refreshed.plan.actions).toEqual(prepared.plan.actions);
    expect(refreshed.refreshedFrom).toMatchObject({
      runId: run.id,
      completedActions: 0,
      completedSetup: [],
    });
    expect(await engine.execute(run.id)).toMatchObject({
      status: 'superseded',
      supersededBy: refreshed.plan.id,
    });
    await expect(engine.submit(refreshed.plan.id, prepared.reviewSummary, 'Alice')).rejects.toThrow('exact');
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect(next.cursor).toBe(0);
    expect((await engine.execute(next.id)).manualGate).toBe('normal_credentials');
    await engine.attest(target, 'normal_credentials', 'Alice');
    expect((await engine.execute(next.id)).manualGate).toBe('duress');
    expect((await engine.readiness(target)).missing).toContain('operator_signoff');
    await expect(engine.refreshReview(run.id)).rejects.toThrow('intentional manual');
  });

  it('refreshes completed private language setup without repeating UI or inheriting final signoff', async () => {
    const observed = port.observation.profiles[0];
    if (!observed) throw new Error('Fixture profile missing');
    observed.language = 'en-US';
    await configure(structuredClone(setupPolicy));
    port.language = () => Promise.resolve({ status: 'manual-pending' });
    const { run } = await preparedRun();
    await engine.execute(run.id);
    const normal = await engine.attest(target, 'normal_credentials', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBe('language:admin');
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
    expect((await engine.execute(next.id)).manualGate).toBe('duress');
    await engine.attest(target, 'duress', 'Alice');
    await engine.execute(next.id);
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
      return Promise.resolve({ status: 'manual-pending' });
    };
    const { run } = await preparedRun();
    await engine.execute(run.id);
    await engine.attest(target, 'normal_credentials', 'Alice');
    await engine.execute(run.id);
    now = new Date(now.getTime() + 16 * 60_000);
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions[0]?.kind).toBe('language');
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect((await engine.execute(next.id)).manualGate).toBe('language:admin');
    expect(calls).toBe(2); // Reopening the explicitly reviewed remaining language guide is allowed.
    now = new Date(now.getTime() + 16 * 60_000);
    observed.language = 'pl-PL';
    const again = await engine.refreshReview(next.id);
    const final = await engine.submit(again.plan.id, again.reviewSummary, 'Alice');
    expect((await engine.execute(final.id)).manualGate).toBe('duress');
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
      port.language = () => Promise.resolve({ status: 'manual-pending' });
      const { run } = await preparedRun();
      await engine.execute(run.id);
      if (drift === 'language-and-permission') {
        await engine.attest(target, 'normal_credentials', 'Alice');
        await engine.execute(run.id);
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
    await engine.execute(run.id);
    const scope = new ResourceScope(store, device.canonicalSerial, run.id);
    await scope.register('helper', 'test-helper', {});
    await expect(engine.refreshReview(run.id)).rejects.toThrow('Recover unresolved');
    await scope.cleanup(
      (user) => Promise.resolve(user),
      () => Promise.resolve(),
    );
    const cas = vi.spyOn(store, 'compareAndSet').mockResolvedValueOnce(false);
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
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
    await engine.attest(target, 'app_setup', 'Alice');
    now = new Date(now.getTime() + 16 * 60_000);
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions[0]).toMatchObject({ kind: 'recipe', recipe: { id: 'private-import' } });
    expect(refreshed.refreshedFrom?.capabilityEvidence).toHaveLength(1);
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Alice');
    expect((await engine.execute(next.id)).manualGate).toBe('app_setup');
    expect(calls).toEqual(['first', 'private-import']);
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(next.id)).manualGate).toBe('normal_credentials');
    expect((await engine.state('all')).capabilityEvidence).toHaveLength(2);
    expect(calls).toEqual(['first', 'private-import']);
  });

  it('requires fresh measured checks, helper cleanup and exact current receipts before handoff', async () => {
    await expect(engine.state('all')).rejects.toThrow('Fresh provisioning');
    await ready();
    await expect(engine.attest(target, 'unknown_check', 'Alice')).rejects.toThrow('does not belong');
    const scope = new ResourceScope(store, device.canonicalSerial, 'parent');
    await scope.register('helper', 'probe', {});
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

  it('blocks permission drift after signoff and records physical debugging shutdown/custody separately (regression 2)', async () => {
    await ready();
    const permission = port.observation.profiles[0]?.permissions[0];
    if (!permission) throw new Error('Fixture permission missing');
    permission.granted = false;
    await expect(engine.finalize(target, 'Alice')).rejects.toThrow('changed after signoff');
    expect(port.calls).not.toContain('finalize');
    permission.granted = true;
    const record = await engine.finalize(target, 'Alice', 'pl');
    expect(record.outcome).toBe('ready-for-handoff');
    expect(record.locale).toBe('pl');
    expect((await engine.state('all')).status).toBe('shutdown-requested');
    await expect(engine.acceptCustody('all', 'Recipient', false)).rejects.toThrow('physical debugging');
    expect((await engine.acceptCustody('all', 'Recipient', true)).outcome).toBe('completed-custody');
    expect((await engine.state('all')).status).toBe('completed-custody');
    await expect(engine.acceptCustody('all', 'Recipient', true)).rejects.toThrow('after finalization');
  });

  it('requires measured emulator image provenance for the exact workflow and never finalizes an emulator (regression 6)', async () => {
    port.observation.device = {
      ...device,
      kind: 'emulator',
      canonicalSerial: 'emulator-5554',
      transports: [{ kind: 'emulator', serial: 'emulator-5554' }],
    };
    await configure(basePolicy());
    const emulator = { device: port.observation.device, transport: port.observation.device.transports[0] };
    if (!emulator.transport) throw new Error('Fixture transport missing');
    const selected: SelectedTarget = { device: emulator.device, transport: emulator.transport };
    const prepared = await engine.prepare(selected);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    await engine.execute(run.id);
    await expect(
      engine.attest(selected, 'emulator_image_provenance', 'Alice', 'I checked it'),
    ).rejects.toThrow('Measured');
    const pin = {
      path: '/tmp/image.img',
      sha256: hashA,
      fingerprint: 'grapheneos/akita/test',
      source: 'https://example.org/image.img',
    };
    port.verifyEmulatorEvidence = (_target, input) =>
      Promise.resolve({
        schemaVersion: 1,
        acceptance: 'emulator-only',
        canonicalSerial: selected.device.canonicalSerial,
        fingerprint: input.fingerprint,
        imageSha256: input.sha256,
        source: input.source,
        capabilities: context.policy.capabilities,
        observedAt: now.toISOString(),
      });
    await expect(
      engine.attest(selected, 'emulator_image_provenance', 'Alice', undefined, { ...pin, sha256: 'invalid' }),
    ).rejects.toThrow('Invalid emulator');
    await engine.attest(selected, 'emulator_image_provenance', 'Alice', undefined, pin);
    for (const check of ['recipient_acceptance', 'operator_signoff'])
      await engine.attest(selected, check, 'Alice');
    expect((await engine.readiness(selected)).ready).toBe(true);
    const bound = await store.get<{ observationDigest: string }>('emulator-provenance', 'all');
    expect(bound?.observationDigest).toBe(observationDigest(port.observation));
    await expect(engine.finalize(selected, 'Alice')).rejects.toThrow('enrolled USB Pixel');
    port.verifyEmulatorEvidence = () =>
      Promise.resolve({
        schemaVersion: 1,
        acceptance: 'emulator-only',
        canonicalSerial: 'other',
        fingerprint: pin.fingerprint,
        imageSha256: pin.sha256,
        source: pin.source,
        capabilities: [],
        observedAt: now.toISOString(),
      });
    await expect(
      engine.attest(selected, 'emulator_image_provenance', 'Alice', undefined, pin),
    ).rejects.toThrow('does not match');
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
    expect((await engine.execute(run.id)).manualGate).toBe('operator_signoff');
    await engine.attest(target, 'operator_signoff', 'Alice');
    expect((await engine.execute(run.id)).status).toBe('completed');
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
    desired.os = {
      codename: 'akita',
      release: '2026100600',
      url: 'https://example.org/os.zip',
      signatureUrl: 'https://example.org/os.zip.sig',
      publicKey: 'ssh-ed25519 AAAA',
      signerPrincipal: 'release@example.org',
      namespace: 'factory images',
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
    expect((await engine.execute(run.id)).status).toBe('pending');
    expect(port.calls).toEqual(['install-os']);
    const extension = await engine.prepareExtension(target, [{ kind: 'install-os', os: desired.os }]);
    expect(extension.operation).toBe('install-os');
    await expect(
      engine.prepareExtension(target, [
        { kind: 'install-os', os: desired.os },
        { kind: 'manual', capability: 'operator_signoff', instructions: 'mixed' },
      ]),
    ).rejects.toThrow('separate operation');
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
});
