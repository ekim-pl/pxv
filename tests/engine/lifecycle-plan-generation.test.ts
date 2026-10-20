import { executeWithWitnesses } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from './../test-api.js';
import { createProject, loadProject, recordLifecycle, saveInventory, WorkflowEngine } from '@pxv/engine';
import type { ArtifactPort, ProjectContext, SeedvaultWorkflowPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, hashA, hashB, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

let root: string;
let store: SqliteStore;
let project: ProjectContext;
let engine: WorkflowEngine;
let port: MemoryPort;
let artifacts: ArtifactPort;
const usb = { device, transport: device.transports[0]! };
const wifi = { device, transport: device.transports[1]! };
const other = {
  ...device,
  assetId: 'other',
  canonicalSerial: 'PIXEL2',
  transports: [{ kind: 'usb' as const, serial: 'PIXEL2' }],
};
const lifecycle = (assetId = device.assetId) => ({
  assetId,
  type: 'maintenance' as const,
  operator: 'Owner',
  note: 'Personal device recovery',
  confirmedErasure: false,
});
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-plan-generation-');
  const codeRoot = join(root, 'code');
  await mkdir(join(codeRoot, 'packages/core'), { recursive: true });
  await writeFile(join(codeRoot, 'packages/core/build.js'), 'export const version=1;');
  const policy = basePolicy();
  policy.osByCodename = {
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
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), codeRoot);
  await saveInventory(created, { schemaVersion: 1, devices: [device, other] });
  project = await loadProject(created.root, product, codeRoot);
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  port = new MemoryPort();
  const seedvault: SeedvaultWorkflowPort = {
    inspect: () =>
      Promise.resolve({
        deviceSerial: device.canonicalSerial,
        osFingerprint: 'fixture/build',
        foregroundUserId: 0,
        unsupportedUsers: [],
        profiles: [
          {
            profileId: 'admin',
            user: port.observation.profiles[0]!.user,
            package: { packageId: 'com.stevesoltys.seedvault', versionCode: 1, signerSha256: hashA },
            backup: { enabled: true, transportPackage: 'com.stevesoltys.seedvault' },
            unlocked: true,
          },
        ],
      }),
    executeProfile: () =>
      Promise.resolve({ status: 'manual-pending', instructions: 'Complete private setup.' }),
  };
  artifacts = {
    snapshot: (artifact) => Promise.resolve(artifact),
    snapshotOs: (os, path) =>
      Promise.resolve({
        path,
        signaturePath: path + '.sig',
        sha256: hashA,
        signatureSha256: hashB,
        policy: os,
      }),
  };
  engine = new WorkflowEngine({
    project,
    store,
    port,
    seedvault,
    artifacts,
    controlRoot: join(root, 'control'),
  });
});
afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function maintenance(assetId = device.assetId) {
  return recordLifecycle(project, store, lifecycle(assetId), undefined, engine.controlRoot);
}

it('retires submitted and unsubmitted OS/Seedvault approvals while retaining their exact historical bytes', async () => {
  const os = await engine.prepare(usb, 'install-os');
  const seed = await engine.prepareSeedvault(wifi, { operation: 'backup' });
  const unsubmitted = await engine.prepare(usb, 'install-os');
  const oldRun = await engine.submit(os.plan.id, os.reviewSummary, 'Owner');
  const oldSeedRun = await engine.submit(seed.plan.id, seed.reviewSummary, 'Owner');
  const event = await maintenance();
  await expect(engine.submit(os.plan.id, os.reviewSummary, 'Owner')).rejects.toThrow('lifecycle event');
  await expect(engine.submit(unsubmitted.plan.id, unsubmitted.reviewSummary, 'Owner')).rejects.toThrow(
    'lifecycle event',
  );
  await expect(engine.submit(seed.plan.id, seed.reviewSummary, 'Owner')).rejects.toThrow('lifecycle event');
  await expect(executeWithWitnesses(engine, oldRun.id)).rejects.toThrow('lifecycle event');
  await expect(executeWithWitnesses(engine, oldSeedRun.id)).rejects.toThrow('lifecycle event');
  expect(await store.get('plans', os.plan.id)).toEqual(os);
  expect(await store.get('seedvault-plans', seed.plan.id)).toEqual(seed);
  expect(port.calls).toEqual([]);
  const fresh = await engine.prepare(usb, 'install-os');
  expect(fresh.lifecycleGeneration).toBe(event.id);
  expect(fresh.reviewSummary).toContain(event.id);
  const approved = await engine.submit(fresh.plan.id, fresh.reviewSummary, 'Owner');
  expect((await executeWithWitnesses(engine, approved.id)).status).toBe('pending');
  expect(port.calls).toEqual(['install-os']);
});

it('binds fresh Seedvault reviews and refuses expired-checkpoint refresh across another maintenance event', async () => {
  const event = await maintenance();
  const prepared = await engine.prepareSeedvault(wifi, { operation: 'backup' });
  expect(prepared.lifecycleGeneration).toBe(event.id);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner');
  expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
  const refreshed = await engine.refreshReview(run.id);
  expect(refreshed.lifecycleGeneration).toBe(event.id);
  const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Owner');
  await executeWithWitnesses(engine, next.id);
  await maintenance();
  await expect(engine.refreshReview(next.id)).rejects.toThrow('lifecycle event');
});

it('rejects an OS preparation that spans maintenance, including time spent downloading its snapshot', async () => {
  let started!: () => void;
  let proceed!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const snapshot = artifacts.snapshotOs!.bind(artifacts);
  artifacts.snapshotOs = async (...args) => {
    started();
    await paused;
    return snapshot(...args);
  };
  const preparing = engine.prepare(usb, 'install-os');
  await entered;
  await maintenance();
  const rejected = expect(preparing).rejects.toThrow('lifecycle event');
  proceed();
  await rejected;
  expect(await store.entries('plans')).toEqual([]);
  expect(port.calls).toEqual([]);
});

it('leaves another asset approvals valid and rejects malformed lifecycle generations', async () => {
  const prepared = await engine.prepare(usb, 'install-os');
  await maintenance(other.assetId);
  expect((await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).status).toBe('queued');
  await store.set('plan-generations', device.assetId, { malformed: true });
  await expect(engine.prepare(usb, 'install-os')).rejects.toThrow('Malformed asset lifecycle');
  await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
    'Malformed asset lifecycle',
  );
  await expect(engine.prepareSeedvault(wifi, { operation: 'backup' })).rejects.toThrow(
    'Malformed asset lifecycle',
  );
});

it('atomically rolls back approval invalidation when the lifecycle journal cannot persist', async () => {
  const event = await maintenance();
  const prepared = await engine.prepare(usb, 'install-os');
  const database = new DatabaseSync(join(root, 'state.sqlite'));
  database.exec(
    "CREATE TRIGGER lifecycle_generation_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.type')='maintenance' BEGIN SELECT RAISE(ABORT,'generation-event-fault'); END",
  );
  try {
    await expect(maintenance()).rejects.toThrow('generation-event-fault');
    expect(await store.get('plan-generations', device.assetId)).toBe(event.id);
    expect((await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).status).toBe('queued');
    expect(await store.entries('lifecycle')).toHaveLength(1);
  } finally {
    database.close();
  }
});

it('refreshes an intentional normal workflow checkpoint within the current lifecycle generation', async () => {
  const event = await maintenance();
  const prepared = await engine.prepareExtension(usb, [
    { kind: 'manual', capability: 'operator_signoff', instructions: 'Perform the actual owner signoff.' },
  ]);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner');
  expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('operator_signoff');
  const refreshed = await engine.refreshReview(run.id);
  expect(refreshed.lifecycleGeneration).toBe(event.id);
  const next = await engine.submit(refreshed.plan.id, refreshed.reviewSummary, 'Owner');
  expect((await executeWithWitnesses(engine, next.id)).manualGate).toBe('operator_signoff');
});
