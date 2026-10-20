import { executeWithWitnesses } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { createProject, loadProject, saveInventory, WorkflowEngine, type WorkflowPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

describe('per-user default locales', () => {
  let root: string;
  let store: SqliteStore;
  let engine: WorkflowEngine;
  let port: MemoryPort;
  let now: Date;
  let requests: { userId: number; locale: string }[];
  const target = { device, transport: device.transports[0]! };
  beforeEach(async () => {
    root = await mkdtemp('/tmp/pxv-default-locales-');
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new MemoryPort();
    now = new Date('2026-10-16T09:00:00Z');
    requests = [];
    const policy = basePolicy();
    policy.capabilities = ['duress'];
    const owner = policy.profiles[0]!;
    owner.defaultLocale = 'de-DE';
    policy.profiles.push({
      ...structuredClone(owner),
      id: 'work',
      name: 'Work',
      kind: 'secondary',
      defaultLocale: 'sr-Latn-RS',
    });
    port.observation.profiles.push({
      ...structuredClone(port.observation.profiles[0]!),
      profileId: 'work',
      user: { userId: 10, serialNo: 17, name: 'Work' },
    });
    port.language = vi.fn<WorkflowPort['language']>((_target, user, locale, context) => {
      expect(context.lease).toBeDefined();
      requests.push({ userId: user.userId, locale });
      return Promise.resolve({
        status: 'manual-pending',
        instructions: 'Set the requested locale privately.',
      });
    });
    const code = join(root, 'code');
    await mkdir(join(code, 'packages/fixture'), { recursive: true });
    await writeFile(join(code, 'packages/fixture/index.js'), 'export const version=1;');
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), code);
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    engine = new WorkflowEngine({
      project: await loadProject(created.root, product, code),
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
  async function ownerCheckpoint() {
    const prepared = await engine.prepare(target);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('normal_credentials');
    expect(requests).toEqual([]);
    await engine.attest(target, 'normal_credentials', 'Operator');
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('language:admin');
    return run;
  }

  it('checks owner and secondary defaults separately before duress, including an expired review', async () => {
    const run = await ownerCheckpoint();
    expect(requests).toEqual([{ userId: 0, locale: 'de-DE' }]);
    expect((await engine.state(device.assetId)).languageReady).toBe(false);
    port.observation.profiles[0]!.language = 'de-DE';
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('language:work');
    expect(requests).toEqual([
      { userId: 0, locale: 'de-DE' },
      { userId: 10, locale: 'sr-Latn-RS' },
    ]);
    expect((await engine.state(device.assetId)).languageReady).toBe(false);
    await expect(engine.attest(target, 'duress', 'Operator')).rejects.toThrow('Contradictory');
    port.observation.profiles[1]!.language = 'sr-Cyrl-RS';
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('language:work');
    expect(requests).toHaveLength(2);
    now = new Date(now.getTime() + 16 * 60_000);
    port.observation.profiles[1]!.language = 'sr-Latn-RS';
    const refreshed = await engine.refreshReview(run.id);
    expect(refreshed.plan.actions).toEqual([
      expect.objectContaining({ kind: 'manual', capability: 'duress' }),
    ]);
    const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Operator');
    expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('duress');
    expect((await engine.state(device.assetId)).languageReady).toBe(true);
    await engine.attest(target, 'duress', 'Operator');
    await executeWithWitnesses(engine, next.id);
    for (const check of ['verified_boot', 'operator_signoff', 'recipient_acceptance'])
      await engine.attest(target, check, 'Operator');
    expect((await engine.readiness(target)).ready).toBe(true);
    expect(requests).toHaveLength(2);
    expect((await engine.prepare(target)).plan.actions.some((action) => action.kind === 'language')).toBe(
      false,
    );
  });

  it.each(['permission', 'another-profile-locale'])(
    'refuses unrelated %s drift while accepting an owner locale change',
    async (drift) => {
      const run = await ownerCheckpoint();
      port.observation.profiles[0]!.language = 'de-DE';
      if (drift === 'permission') port.observation.profiles[1]!.permissions[0]!.granted = false;
      else port.observation.profiles[1]!.language = 'fr-FR';
      const result = await executeWithWitnesses(engine, run.id);
      expect(result.status).toBe('needs-inspection');
      expect(result.error).toContain('Other live requirements changed');
      expect(requests).toHaveLength(1);
    },
  );

  it('checks contributed locale actions against defaultLocale declarations', async () => {
    await expect(
      engine.prepareExtension(target, [{ kind: 'language', profileId: 'admin', language: 'de-DE' }]),
    ).resolves.toMatchObject({ operation: 'extension' });
    await expect(
      engine.prepareExtension(target, [{ kind: 'language', profileId: 'admin', language: 'fr-FR' }]),
    ).rejects.toThrow('contradicts selected policy');
    expect(requests).toEqual([]);
  });
});
