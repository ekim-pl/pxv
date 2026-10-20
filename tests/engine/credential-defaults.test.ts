import { approveProject } from './fixtures.js';
import { executeWithWitnesses } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import {
  createProject,
  loadProject,
  readRegistryGeneration,
  saveInventory,
  WorkflowEngine,
} from '@pxv/engine';
import type { WorkflowPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, hashA, hashB, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

class CredentialPort extends MemoryPort {
  credentialDefaultsPreflight = vi.fn<NonNullable<WorkflowPort['credentialDefaultsPreflight']>>(() =>
    Promise.resolve(),
  );
  setCredentialDefault = vi.fn<NonNullable<WorkflowPort['setCredentialDefault']>>(
    (_target, user, _profile, context) => {
      expect(context.lease).toBeDefined();
      this.calls.push(`default-credential:${user.userId}`);
      return Promise.resolve();
    },
  );
  setDuressDefault = vi.fn<NonNullable<WorkflowPort['setDuressDefault']>>(
    (_target, user, _profile, context) => {
      expect(context.lease).toBeDefined();
      this.calls.push(`default-duress:${user.userId}`);
      return Promise.resolve();
    },
  );
}

describe('credential defaults and private recipient checkpoints', () => {
  let root: string;
  let store: SqliteStore;
  let port: CredentialPort;
  let engine: WorkflowEngine;
  const target = { device, transport: device.transports[0]! };
  beforeEach(async () => {
    root = await mkdtemp('/tmp/pxv-default-credentials-');
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new CredentialPort();
    const policy = basePolicy();
    const owner = policy.profiles[0]!;
    owner.defaultCredential = { type: 'pin', secretRef: 'owner-lock' };
    owner.defaultDuress = {
      ownerCredentialRef: 'owner-current',
      pinRef: 'duress-pin',
      passwordRef: 'duress-password',
    };
    owner.defaultLocale = 'de-DE';
    policy.profiles.push({
      ...structuredClone(owner),
      id: 'work',
      name: 'Work',
      kind: 'secondary',
      defaultCredential: { type: 'password', secretRef: 'work-lock' },
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    });
    delete policy.profiles[1]!.defaultDuress;
    const code = join(root, 'code');
    await mkdir(join(code, 'packages/fixture'), { recursive: true });
    await writeFile(join(code, 'packages/fixture/index.js'), 'export const version=1;');
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), code);
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    engine = new WorkflowEngine({
      project: await approveProject(await loadProject(created.root, product, code)),
      store,
      port,
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
      controlRoot: join(root, 'control'),
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function approve() {
    const prepared = await engine.prepare(target);
    return engine.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
  }

  it('applies per-profile defaults, pauses for ordinary verification, then applies owner duress', async () => {
    const run = await approve();
    expect(port.calls).toEqual([]);
    expect(port.credentialDefaultsPreflight).toHaveBeenCalledOnce();
    const normal = await executeWithWitnesses(engine, run.id);
    expect(normal).toMatchObject({ status: 'pending', manualGate: 'normal_credentials' });
    expect(port.calls.filter((value) => value.startsWith('default-'))).toEqual([
      'default-credential:0',
      'default-credential:11',
    ]);
    expect(port.setDuressDefault).not.toHaveBeenCalled();
    const normalGeneration = await readRegistryGeneration(store, device);
    expect(normalGeneration.profileEpochs['admin']).toBeTruthy();
    expect(normalGeneration.profileEpochs['work']).toBeTruthy();
    await expect(engine.attest(target, 'duress', 'Operator')).rejects.toThrow('Contradictory');
    await engine.attest(target, 'normal_credentials', 'Operator');
    const duress = await executeWithWitnesses(engine, run.id);
    expect(duress).toMatchObject({ status: 'pending', manualGate: 'duress' });
    expect(port.calls.slice(-3)).toEqual(['language', 'language', 'default-duress:0']);
    expect((await readRegistryGeneration(store, device)).deviceEpoch).not.toBe(normalGeneration.deviceEpoch);
    expect((await engine.readiness(target)).missing).toContain('duress');
    await engine.attest(target, 'duress', 'Operator');
    await executeWithWitnesses(engine, run.id);
    expect(port.setCredentialDefault).toHaveBeenCalledTimes(2);
    expect(port.setDuressDefault).toHaveBeenCalledOnce();
    const state = JSON.stringify(await store.entries('credential-defaults'));
    expect(state).toContain('command-accepted');
    expect(state).not.toContain('values');
  });

  it('remembers accepted defaults for stable users and fences older approved plans', async () => {
    port.observation.profiles.push({
      ...structuredClone(port.observation.profiles[0]!),
      profileId: 'work',
      user: { userId: 10, serialNo: 10, name: 'Work' },
    });
    const first = await approve();
    const second = await approve();
    await executeWithWitnesses(engine, first.id);
    await executeWithWitnesses(engine, second.id);
    expect(port.setCredentialDefault).toHaveBeenCalledTimes(2);
    const next = await engine.prepare(target);
    expect(next.plan.actions.some((action) => action.kind === 'default-credential')).toBe(false);
    const work = port.observation.profiles.find((profile) => profile.profileId === 'work')!;
    work.user.serialNo++;
    const recreated = await engine.prepare(target);
    expect(recreated.plan.actions.filter((action) => action.kind === 'default-credential')).toEqual([
      {
        kind: 'default-credential',
        profileId: 'work',
        credential: { type: 'password', secretRef: 'work-lock' },
      },
    ]);
  });

  it('rejects missing/failed preflight before any mutation or executable plan is retained', async () => {
    port.credentialDefaultsPreflight.mockRejectedValue(new Error('Private input unavailable'));
    await expect(engine.prepare(target)).rejects.toThrow('Private input unavailable');
    expect(port.calls).toEqual([]);
    expect(await store.entries('plans')).toEqual([]);
    await expect(engine.prepare(target, 'create-users')).resolves.toMatchObject({
      operation: 'create-users',
    });
  });

  it.each(['credentialDefaultsPreflight', 'setCredentialDefault', 'setDuressDefault'])(
    'rejects unavailable %s before retaining an executable plan or changing the phone',
    async (method) => {
      Reflect.deleteProperty(port, method);
      await expect(engine.prepare(target)).rejects.toThrow('credential defaults adapter is unavailable');
      expect(port.calls).toEqual([]);
      expect(await store.entries('plans')).toEqual([]);
    },
  );

  it('binds contributed credential defaults to the exact declared type and secret references', async () => {
    const owner = engine.project.policy.profiles[0]!;
    await expect(
      engine.prepareExtension(target, [
        { kind: 'default-credential', profileId: owner.id, credential: owner.defaultCredential! },
      ]),
    ).resolves.toMatchObject({ operation: 'extension' });
    await expect(
      engine.prepareExtension(target, [
        {
          kind: 'default-credential',
          profileId: owner.id,
          credential: { type: 'password', secretRef: 'owner-lock' },
        },
      ]),
    ).rejects.toThrow('contradicts selected policy');
    await expect(
      engine.prepareExtension(target, [
        {
          kind: 'default-duress',
          profileId: owner.id,
          duress: { ...owner.defaultDuress!, pinRef: 'unreviewed-pin' },
        },
      ]),
    ).rejects.toThrow('contradicts selected policy');
    expect(port.calls).toEqual([]);
  });

  it('invalidates old approvals before a failing credential mutation and never retries that run', async () => {
    const run = await approve();
    await store.set('handoff', device.assetId, { outcome: 'ready-for-handoff' });
    await store.set('attestations', device.assetId, [
      {
        schemaVersion: 1,
        id: 'old-credential-check',
        planDigest: hashA,
        observationDigest: hashB,
        check: 'normal_credentials',
        operator: 'Operator',
        recordedAt: new Date().toISOString(),
        profileIds: ['admin'],
      },
    ]);
    port.setCredentialDefault.mockRejectedValue(new Error('Credential setup failed; inspect the profile'));
    const failed = await executeWithWitnesses(engine, run.id);
    expect(failed.status).toBe('needs-inspection');
    expect((await engine.state(device.assetId)).status).toBe('failed');
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
    expect((await engine.receipts(device.assetId)).filter((value) => value.check !== 'vpn_settings')).toEqual(
      [],
    );
    expect((await engine.readiness(target)).ready).toBe(false);
    await executeWithWitnesses(engine, run.id);
    expect(port.setCredentialDefault).toHaveBeenCalledOnce();
    expect(port.setDuressDefault).not.toHaveBeenCalled();
    expect((await readRegistryGeneration(store, device)).profileEpochs['admin']).toBeTruthy();
  });

  it('rejects contributed owner duress before private normal verification and final language', async () => {
    const owner = engine.project.policy.profiles[0]!;
    const prepared = await engine.prepareExtension(target, [
      { kind: 'default-duress', profileId: owner.id, duress: owner.defaultDuress! },
    ]);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect(port.setDuressDefault).not.toHaveBeenCalled();
  });

  it('rejects an old plan that omitted initialization after OS installation clears history', async () => {
    const run = await approve();
    await executeWithWitnesses(engine, run.id);
    await engine.attest(target, 'normal_credentials', 'Operator');
    await executeWithWitnesses(engine, run.id);
    const prepared = await engine.prepare(target);
    expect(prepared.plan.actions.some((action) => action.kind.startsWith('default-'))).toBe(false);
    const stale = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
    await store.delete('credential-defaults', device.assetId);
    const calls = port.calls.length;
    const result = await executeWithWitnesses(engine, stale.id);
    expect(result).toMatchObject({ status: 'needs-inspection' });
    expect(result.error).toContain('history changed');
    expect(port.calls).toHaveLength(calls);
  });
});
