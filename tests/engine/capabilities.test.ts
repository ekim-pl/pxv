import { mkdtemp, rm } from 'node:fs/promises';
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
  const configure = async (policy: PolicyPack): Promise<WorkflowEngine> => {
    const created = await createProject(
      join(root, `project-${Math.random().toString(16).slice(2)}`),
      product,
      policy,
    );
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    return new WorkflowEngine({
      project: await loadProject(created.root, product),
      store,
      port,
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
      controlRoot: join(root, 'control'),
      clock: () => new Date('2026-10-16T09:00:00Z'),
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
      await execution.obligations.record({
        schemaVersion: 1,
        id: 'probe-only',
        operationId: execution.operationId,
        ownerOperationId: `${execution.operationId}/probe/child`,
        deviceSerial: device.canonicalSerial,
        user,
        kind: 'remove-helper',
        resource: 'org.pxv.probe',
        payload: {},
        status: 'pending',
      });
      await execution.obligations.resolve('probe-only');
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
    const run = await approve(engine);
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
    expect(calls).toEqual(['manual-import']);
    await engine.attest(target, 'app_setup', 'Alice');
    expect((await engine.execute(run.id)).manualGate).toBeUndefined();
    expect(calls).toEqual(['manual-import']);
    expect((await engine.state('all')).capabilityEvidence?.[0]?.status).toBe('manual-completed');
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
    await scope.register('remove-helper', 'helper', {}, { userId: 0, serialNo: 0, name: 'Administrator' });
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
    await scope.register(
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
        await runner.run([process.execPath, '-e', 'process.exit(0)'], { mutation: true, lease });
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
    port.cleanup = () => Promise.resolve();
    const result = await engine.recover(target, 'failed-run');
    expect(result.resolved).toBe(1);
    expect(await recoveryReservations(join(root, 'control'))).toEqual([]);
    const events = await store.events<{ type: string }>('failed-run');
    expect(events.filter((value) => value.event.type === 'native-completed')).toHaveLength(1);
    await engine.recover(target, 'failed-run');
    expect(
      (await store.events<{ type: string }>('failed-run')).filter(
        (value) => value.event.type === 'native-completed',
      ),
    ).toHaveLength(1);
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
});
