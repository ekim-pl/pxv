import { toPolicyDocument } from '@pxv/contracts';
import { recordObligation } from './obligations.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digest, requiredAttestations } from '@pxv/contracts';
import type { RecipePolicy, NetworkProbePolicy, PolicyPack, SelectedTarget } from '@pxv/contracts';
import { createProject, loadProject, ResourceScope, saveInventory, WorkflowEngine } from '@pxv/engine';
import { CommandRunner, recoveryReservations, SqliteStore, withDeviceLease } from '@pxv/runtime';
import { device, hashA, hashB, product, policy as setupPolicy } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

const recipe: RecipePolicy = {
  schemaVersion: 1,
  id: 'vpn-setup',
  packageId: 'org.example.vpn',
  versionCode: 12,
  signerSha256: hashB,
  buildFingerprint: 'test/akita/build',
  steps: [{ action: 'back' }],
  postconditions: [{ resourceId: 'org.example.vpn:id/ready', checked: true }],
};
const probe: NetworkProbePolicy = {
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
const target: SelectedTarget = { device, transport: { kind: 'usb', serial: 'PIXEL1' } };

describe('scoped recipe, network and recovery evidence', () => {
  let root = '';
  let store: SqliteStore;
  let port: MemoryPort;
  let now = new Date('2026-10-16T09:00:00Z');
  const configure = async (policy: PolicyPack): Promise<WorkflowEngine> => {
    const created = await createProject(
      join(root, `project-${Math.random().toString(16).slice(2)}`),
      product,
      toPolicyDocument(policy),
    );
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    return new WorkflowEngine({
      project: await loadProject(created.root, product),
      store,
      port,
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
      controlRoot: join(root, 'control'),
      clock: () => now,
    });
  };
  const approve = async (engine: WorkflowEngine) => {
    const prepared = await engine.prepare(target);
    return engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-capability-'));
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new MemoryPort();
    now = new Date('2026-10-16T09:00:00Z');
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('runs pinned recipes and helper-UID probes, retains parent resources and requires final operator checks', async () => {
    const policy = basePolicy();
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.recipes = [recipe];
    profile.networkProbe = probe;
    port.runRecipe = async (_target, user, configured, execution) => {
      if (!execution.operationId || !execution.obligations) throw new Error('Missing durable recipe context');
      await execution.obligations.record({
        schemaVersion: 1,
        id: 'parent-keep-awake',
        operationId: execution.operationId,
        ownerOperationId: execution.operationId,
        deviceSerial: device.canonicalSerial,
        user,
        kind: 'restore-setting',
        resource: 'keep-awake',
        payload: { original: '0' },
        status: 'pending',
      });
      return {
        status: 'measured',
        capability: 'app-setup',
        recipeDigest: digest(configured),
        postconditions: 1,
      };
    };
    port.runProbe = async (_target, user, configured, execution) => {
      if (!execution.operationId || !execution.obligations || !execution.reviewedDeviceWideEffect)
        throw new Error('Missing durable probe context');
      expect(configured.artifact.path).toContain('/state/plans/');
      const child = execution.obligations.child('probe-child');
      await child.record({
        schemaVersion: 1,
        id: 'probe-only',
        operationId: child.operationId,
        ownerOperationId: child.ownerOperationId,
        deviceSerial: device.canonicalSerial,
        user,
        kind: 'remove-helper',
        resource: 'org.pxv.probe',
        payload: {},
        status: 'pending',
      });
      await child.resolve('probe-only');
      return {
        scope: 'probe-app-uid-https-only',
        normal: {
          uid: 10101,
          requestSucceeded: true,
          connectionObserved: true,
          vpnActive: true,
          egressIp: '192.0.2.1',
          errorType: null,
        },
        failures: [],
      };
    };
    const engine = await configure(policy);
    const run = await approve(engine);
    expect((await engine.execute(run.id)).status).toBe('pending');
    const scope = new ResourceScope(store, device.canonicalSerial, run.id);
    expect((await scope.list()).find((value) => value.id === 'parent-keep-awake')?.status).toBe('pending');
    const before = await engine.readiness(target);
    for (const missing of ['cleanup', 'app_setup', 'routes', 'network_failure_tests'])
      expect(before.missing).toContain(missing);
    port.cleanup = (_target, obligation, execution) => {
      expect(execution.operationId).toBe(obligation.ownerOperationId);
      return Promise.resolve();
    };
    expect((await engine.recover(target, run.id)).resolved).toBe(1);
    for (const check of requiredAttestations(policy)) await engine.attest(target, check, 'Alice');
    expect((await engine.readiness(target)).ready).toBe(true);
    const reference = (await engine.state('all')).capabilityEvidence?.find(
      (value) => value.kind === 'recipe',
    );
    if (!reference) throw new Error('Recipe evidence missing');
    await store.delete('capability-evidence', reference.evidenceId);
    expect((await engine.readiness(target)).missing).toContain('recipe:admin:vpn-setup');
  });

  it('pauses unsupported recipe automation for explicit private completion without replaying earlier UI', async () => {
    const policy = basePolicy();
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.recipes = [
      {
        ...recipe,
        id: 'manual-import',
        steps: [
          { action: 'stage-file', file: 'vpn_config' },
          { action: 'select-staged-file', file: 'vpn_config' },
        ],
      },
    ];
    Object.assign(port, { capabilities: { uiAutomation: false } });
    port.observation.profiles[0]!.vpn = { packageId: null, alwaysOn: false, lockdown: false };
    const calls: string[] = [];
    port.runRecipe = (_target, _user, configured) => {
      calls.push(configured.id);
      return Promise.resolve({
        status: 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(configured),
        instructions: 'Complete setup privately.',
      });
    };
    const engine = await configure(policy);
    const prepared = await engine.prepare(target);
    expect(prepared.capabilities).toEqual({ uiAutomation: false });
    expect((JSON.parse(prepared.reviewSummary) as Record<string, unknown>)['appConfiguration']).toEqual([
      { profileId: profile.id, recipeId: 'manual-import', mode: 'assisted' },
    ]);
    expect(prepared.plan.actions.map((action) => action.kind)).toEqual(['recipe', 'vpn']);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    expect((await engine.execute(run.id)).pauseReason).toMatchObject({
      kind: 'manual-step',
      gate: 'app_setup',
      profileId: profile.id,
      recipeId: 'manual-import',
      instructions: 'Complete setup privately.',
    });
    expect(port.calls).not.toContain('vpn');
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
    expect(calls).toEqual(['manual-import']);
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBeUndefined();
    expect(port.calls).toContain('vpn');
    expect(calls).toEqual(['manual-import']);
    expect((await engine.state('all')).capabilityEvidence?.[0]?.status).toBe('manual-completed');
  });

  it('plans every profile app and configuration before VPN lockdown and network measurements', async () => {
    const policy = basePolicy();
    const owner = policy.profiles[0]!;
    owner.recipes = [recipe];
    owner.networkProbe = probe;
    policy.profiles.push({ ...structuredClone(owner), id: 'work', name: 'Work', kind: 'secondary' });
    const observed = port.observation.profiles[0]!;
    observed.packages = [];
    observed.settings = [];
    observed.permissions = [];
    observed.vpn = { packageId: null, alwaysOn: false, lockdown: false };
    port.runRecipe = (_target, _user, configured) =>
      Promise.resolve({
        status: 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(configured),
      });
    port.runProbe = () => Promise.reject(new Error('Planning must not run a network probe'));
    const engine = await configure(policy);
    const prepared = await engine.prepare(target);
    const kinds = prepared.plan.actions.map((action) => action.kind);
    expect(kinds).toEqual([
      'create-user',
      'install-apk',
      'install-apk',
      'setting',
      'permission',
      'setting',
      'permission',
      'recipe',
      'recipe',
      'vpn',
      'vpn',
      'network-probe',
      'network-probe',
    ]);
    expect(port.calls).toEqual([]);
  });

  it('requires a fresh receipt for each named manual recipe even when measured policy state is identical', async () => {
    const policy = basePolicy();
    policy.profiles[0]!.recipes = [recipe, { ...recipe, id: 'second-setup' }];
    port.runRecipe = (_target, _user, configured) =>
      Promise.resolve({
        status: 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(configured),
      });
    const engine = await configure(policy);
    const run = await approve(engine);
    expect((await engine.execute(run.id)).pauseReason).toMatchObject({ recipeId: recipe.id });
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(run.id)).pauseReason).toMatchObject({ recipeId: 'second-setup' });
    expect((await engine.execute(run.id)).pauseReason).toMatchObject({ recipeId: 'second-setup' });
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBeUndefined();
    expect((await engine.state('all')).capabilityEvidence).toHaveLength(2);
  });

  it('requires named VPN setup and consent before a changed lockdown policy without a matching recipe', async () => {
    Object.assign(port, { capabilities: { uiAutomation: false } });
    port.observation.profiles[0]!.vpn = { packageId: null, alwaysOn: false, lockdown: false };
    const engine = await configure(basePolicy());
    const prepared = await engine.prepare(target);
    expect(prepared.plan.actions.map((action) => action.kind)).toEqual(['manual', 'vpn']);
    const setup = prepared.plan.actions[0];
    if (setup?.kind !== 'manual') throw new Error('Expected a named VPN setup checkpoint');
    expect(setup.capability).toBe('app_setup');
    expect(setup.instructions).toContain('org.example.vpn in profile admin');
    expect(prepared.reviewSummary).toContain('assisted');
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    const pause = (await engine.execute(run.id)).pauseReason;
    if (pause?.kind !== 'manual-step') throw new Error('Expected a manual setup pause');
    expect(pause.gate).toBe('app_setup');
    expect(pause.instructions).toContain('Android VPN consent');
    expect(port.calls).toEqual([]);
    await expect(engine.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow('Contradictory');
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(run.id)).pauseReason?.kind).toBe('acceptance');
    expect(port.calls).toEqual(['vpn']);
    expect((await engine.state('all')).status).toBe('verified');
    expect((await engine.prepare(target)).plan.actions).toEqual([]);
  });

  it('does not excuse drift in a VPN action that completed before the current app configuration gate', async () => {
    const policy = basePolicy();
    const profile = policy.profiles[0]!;
    profile.recipes = [recipe];
    port.runRecipe = (_target, _user, configured) => {
      port.observation.profiles[0]!.vpn = { packageId: null, alwaysOn: false, lockdown: false };
      return Promise.resolve({
        status: 'manual-pending',
        capability: 'app-setup',
        recipeDigest: digest(configured),
      });
    };
    const engine = await configure(policy);
    const prepared = await engine.prepareExtension(target, [
      { kind: 'vpn', profileId: profile.id, vpn: profile.vpn },
      { kind: 'recipe', profileId: profile.id, recipe },
    ]);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
    await expect(engine.attest(target, 'app_setup', 'Alice')).rejects.toThrow('Contradictory');
    await expect(engine.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow('Contradictory');
  });

  it('refuses unavailable adapters, false recipe claims and incomplete helper-UID measurements', async () => {
    const policy = basePolicy();
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.recipes = [recipe];
    let engine = await configure(policy);
    await expect(engine.prepare(target)).rejects.toThrow('recipe adapter');
    port.runRecipe = () =>
      Promise.resolve({
        status: 'measured',
        capability: 'app-setup',
        recipeDigest: hashA,
        postconditions: 1,
      });
    let run = await approve(engine);
    expect((await engine.execute(run.id)).error).toContain('different configuration');
    delete profile.recipes;
    profile.networkProbe = probe;
    engine = await configure(policy);
    await expect(engine.prepare(target)).rejects.toThrow('network probe adapter');
    port.runProbe = () =>
      Promise.resolve({
        scope: 'probe-app-uid-https-only',
        normal: {
          uid: 10101,
          requestSucceeded: false,
          connectionObserved: false,
          vpnActive: true,
          egressIp: null,
          errorType: 'ConnectException',
        },
        failures: [],
      });
    run = await approve(engine);
    expect((await engine.execute(run.id)).error).toContain('incomplete');
    const measured = port.observation.profiles[0];
    if (!measured) throw new Error('Fixture measured profile missing');
    measured.packages.push({ packageId: 'org.pxv.probe', versionCode: 1, signerSha256: hashB });
    await expect(engine.prepare(target)).rejects.toThrow('already installed');
  });

  it('blocks new mutations until typed recovery finishes and preserves recreated-user obligations', async () => {
    const engine = await configure(basePolicy());
    const scope = new ResourceScope(store, device.canonicalSerial, 'old-run');
    await recordObligation(
      scope,
      'remove-helper',
      'helper',
      {},
      { userId: 0, serialNo: 0, name: 'Administrator' },
    );
    const run = await approve(engine);
    expect((await engine.execute(run.id)).error).toContain('unresolved recovery');
    await expect(engine.recover(target, 'old-run')).rejects.toThrow('Typed device cleanup');
    port.cleanup = () => Promise.resolve();
    const user = port.observation.profiles[0]?.user;
    if (!user) throw new Error('Fixture user missing');
    user.serialNo = 99;
    await expect(engine.recover(target, 'old-run')).rejects.toThrow('identity changed');
    expect((await scope.list())[0]?.status).toBe('blocked');
    user.serialNo = 0;
    expect(await engine.recover(target, 'old-run')).toEqual({ operationId: 'old-run', resolved: 1 });
    expect((await scope.list())[0]?.status).toBe('resolved');
  });

  it('retains a real native fence throughout typed recovery and clears it only after successful cleanup', async () => {
    const engine = await configure(basePolicy());
    const scope = new ResourceScope(store, device.canonicalSerial, 'failed-run');
    await recordObligation(
      scope,
      'remove-helper',
      'temporary-helper',
      {},
      { userId: 0, serialNo: 0, name: 'Administrator' },
    );
    const deviceKey = digest({ kind: device.kind, serial: device.canonicalSerial });
    const transportKey = digest(target.transport.serial);
    const runner = new CommandRunner();
    await expect(
      withDeviceLease(join(root, 'control'), deviceKey, transportKey, 'failed-run', async (lease) => {
        await runner.run([process.execPath, '-e', 'process.exit(0)'], { mutation: true, lease, env: {} });
        throw new Error('Injected operation failure');
      }),
    ).rejects.toThrow('Injected');
    expect(await recoveryReservations(join(root, 'control'))).toHaveLength(1);
    port.inspectUser = (_target, user) => Promise.resolve(user);
    port.cleanup = async (_target, obligation, execution) => {
      expect(execution.operationId).toBe(obligation.ownerOperationId);
      expect((await recoveryReservations(join(root, 'control'))).length).toBeGreaterThan(0);
      throw new Error('Injected cleanup failure');
    };
    await expect(engine.recover(target, 'failed-run')).rejects.toThrow('cleanup failure');
    expect((await recoveryReservations(join(root, 'control'))).length).toBeGreaterThan(0);
    const priorAttempt = await store.get<{ operationId: string }>('recovery-attempts', 'failed-run');
    if (!priorAttempt) throw new Error('Recovery attempt was not retained');
    const database = new DatabaseSync(join(root, 'state.sqlite'));
    database.exec(
      "CREATE TRIGGER recovery_attempt_fault BEFORE UPDATE ON records WHEN NEW.collection='recovery-attempts' BEGIN SELECT RAISE(ABORT,'recovery-attempt-write-failed'); END",
    );
    try {
      await expect(engine.recover(target, 'failed-run')).rejects.toThrow('recovery-attempt-write-failed');
      const inherited = (await recoveryReservations(join(root, 'control')))[0];
      expect(inherited?.previous_operation_id).toBe(priorAttempt.operationId);
      expect(inherited?.operation_id).not.toBe(priorAttempt.operationId);
      expect(await store.get('recovery-attempts', 'failed-run')).toMatchObject(priorAttempt);
    } finally {
      database.exec('DROP TRIGGER recovery_attempt_fault');
      database.close();
    }
    port.cleanup = () => Promise.resolve();
    now = new Date(now.getTime() + 60_000);
    const result = await engine.recover(target, 'failed-run');
    expect(result.resolved).toBe(1);
    expect(await recoveryReservations(join(root, 'control'))).toEqual([]);
    const events = await store.events<{ type: string }>('failed-run');
    expect(events.filter((value) => value.event.type === 'native-completed')).toHaveLength(1);
    const nativeEvent = events.find((value) => value.event.type === 'native-completed');
    if (!nativeEvent) throw new Error('Native event missing');
    // Simulate retained events written before first-observation time markers existed.
    for (const marker of await store.entries('native-event-times'))
      await store.delete('native-event-times', marker.key);
    now = new Date(now.getTime() + 60_000);
    await engine.recover(target, 'failed-run');
    expect(
      (await store.events('failed-run')).find((value) => value.sequence === nativeEvent.sequence),
    ).toEqual(nativeEvent);
    expect(
      (await store.events<{ type: string }>('failed-run')).filter(
        (value) => value.event.type === 'native-completed',
      ),
    ).toHaveLength(1);
    const directory = join(root, 'control/receipts');
    const name = (await readdir(directory)).find((file) => file.startsWith('failed-run-'));
    if (!name) throw new Error('Retained native receipt missing');
    const path = join(directory, name);
    const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const timeKey = 'failed-run:' + name.slice('failed-run-'.length, -5);
    const recordedTime = await store.get('native-event-times', timeKey);
    await store.set('native-event-times', timeKey, ['malformed-time']);
    await expect(engine.recover(target, 'failed-run')).rejects.toThrow('Malformed native event time');
    await store.set('native-event-times', timeKey, recordedTime);
    await writeFile(path, JSON.stringify({ ...receipt, code: 7 }));
    now = new Date(now.getTime() + 60_000);
    await expect(engine.recover(target, 'failed-run')).rejects.toThrow('different evidence');
  });

  it('pauses unsupported language automation and accepts only the planned measured recipient change', async () => {
    const actual = port.observation.profiles[0];
    if (!actual) throw new Error('Fixture profile missing');
    actual.language = 'en-US';
    const calls: string[] = [];
    port.language = () => {
      calls.push('language-attempt');
      return Promise.resolve({
        status: 'manual-pending',
        instructions: 'Recipient chooses Polish privately.',
      });
    };
    const engine = await configure(setupPolicy);
    const run = await approve(engine);
    expect((await engine.execute(run.id)).manualGate).toBe('normal_credentials');
    await engine.attest(target, 'normal_credentials', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBe('language:admin');
    expect((await engine.execute(run.id)).manualGate).toBe('language:admin');
    expect(calls).toEqual(['language-attempt']);
    actual.language = 'pl-PL';
    expect((await engine.execute(run.id)).manualGate).toBe('duress');
    expect(calls).toEqual(['language-attempt']);
    await engine.attest(target, 'duress', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBeUndefined();
    expect(
      (await store.events<{ type: string }>(run.id)).some(
        (value) => value.event.type === 'language-observed',
      ),
    ).toBe(true);
  });

  it('blocks permission drift while the recipient completes a manual language checkpoint', async () => {
    const actual = port.observation.profiles[0];
    const permission = actual?.permissions[0];
    if (!actual || !permission) throw new Error('Fixture profile missing');
    actual.language = 'en-US';
    port.language = () => Promise.resolve({ status: 'manual-pending', instructions: 'Choose Polish.' });
    const engine = await configure(setupPolicy);
    const run = await approve(engine);
    await engine.execute(run.id);
    await engine.attest(target, 'normal_credentials', 'Alice');
    await engine.execute(run.id);
    actual.language = 'pl-PL';
    permission.granted = false;
    expect((await engine.execute(run.id)).error).toContain('Other live requirements changed');
  });
  it('retains cleanup when the original Android user disappears before explicit recovery', async () => {
    const engine = await configure(basePolicy());
    const scope = new ResourceScope(store, device.canonicalSerial, 'missing-user-run');
    await recordObligation(
      scope,
      'remove-helper',
      'temporary-helper',
      {},
      { userId: 0, serialNo: 0, name: 'Administrator' },
    );
    port.observation.profiles = [];
    let released = false;
    port.cleanup = () => {
      released = true;
      return Promise.resolve();
    };
    await expect(engine.recover(target, 'missing-user-run')).rejects.toThrow('Recovery user is absent');
    expect(released).toBe(false);
    expect((await scope.list())[0]?.status).toBe('blocked');
    expect(
      (await store.events<{ type: string }>('missing-user-run')).some(
        (value) => value.event.type === 'recovered',
      ),
    ).toBe(false);
  });

  it('does not claim recovery when cleanup introduces another unresolved resource', async () => {
    const engine = await configure(basePolicy());
    const scope = new ResourceScope(store, device.canonicalSerial, 'late-resource-run');
    const user = { userId: 0, serialNo: 0, name: 'Administrator' };
    await recordObligation(scope, 'remove-helper', 'original-helper', {}, user);
    const signal = new AbortController().signal;
    port.cleanup = async (_target, _obligation, context) => {
      expect(context.signal).toBe(signal);
      await recordObligation(scope, 'remove-helper', 'late-helper', {}, user);
    };
    await expect(engine.recover(target, 'late-resource-run', signal)).rejects.toThrow(
      'Recovery obligations remain unresolved',
    );
    expect((await scope.list()).map((value) => [value.resource, value.status])).toEqual([
      ['original-helper', 'resolved'],
      ['late-helper', 'pending'],
    ]);
    expect(
      (await store.events<{ type: string }>('late-resource-run')).some(
        (value) => value.event.type === 'recovered',
      ),
    ).toBe(false);
  });
});
