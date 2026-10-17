import { toPolicyDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  inspectRegistryBinding,
  loadProject,
  readRegistryGeneration,
  saveInventory,
  WorkflowEngine,
} from '@pxv/engine';
import type { ArtifactPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, hashA, hashB, product } from '../contracts/fixtures.js';
import { registryDocument, registryTime } from '../contracts/phone-registry-fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

describe('registry invalidation before destructive execution', () => {
  let root: string;
  let path: string;
  let store: SqliteStore;
  let port: MemoryPort;
  let engine: WorkflowEngine;
  const target = { device, transport: device.transports[0]! };
  const inventory = { schemaVersion: 1 as const, devices: [device] };
  beforeEach(async () => {
    root = await mkdtemp('/tmp/pxv-registry-execution-');
    const codeRoot = join(root, 'code');
    await mkdir(join(codeRoot, 'packages/core'), { recursive: true });
    await writeFile(join(codeRoot, 'packages/core/build.js'), 'export const build=1;');
    const policy = basePolicy();
    policy.profiles.push({
      ...structuredClone(policy.profiles[0]!),
      id: 'work',
      name: 'Work',
      kind: 'secondary',
    });
    policy.osByCodename = {
      akita: {
        codename: 'akita',
        release: '2026100600',
        url: 'https://releases.grapheneos.org/akita-install-2026100600.zip',
        signatureUrl: 'https://releases.grapheneos.org/akita-install-2026100600.zip.sig',
        signerPrincipal: 'contact@grapheneos.org',
        namespace: 'factory images',
        publicKey: 'ssh-ed25519 AAAA',
      },
    };
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), codeRoot);
    await saveInventory(created, inventory);
    const project = await loadProject(created.root, product, codeRoot);
    path = join(root, 'state.sqlite3');
    store = await SqliteStore.open(path);
    port = new MemoryPort();
    const artifacts: ArtifactPort = {
      snapshot: (artifact) => Promise.resolve(artifact),
      snapshotOs: (os, destination) =>
        Promise.resolve({
          path: destination,
          signaturePath: `${destination}.sig`,
          sha256: hashA,
          signatureSha256: hashB,
          policy: os,
        }),
    };
    engine = new WorkflowEngine({
      project,
      store,
      port,
      artifacts,
      controlRoot: join(root, 'control'),
      clock: () => new Date(registryTime),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function durableEpoch() {
    const reader = await SqliteStore.open(path);
    try {
      return await readRegistryGeneration(reader, device);
    } finally {
      await reader.close();
    }
  }

  it.each(['install-os', 'create-users'] as const)(
    'commits invalidation before %s and keeps bindings stale when the fake device action fails',
    async (operation) => {
      const original = registryDocument();
      const before = await readRegistryGeneration(store, device);
      const action = operation === 'install-os' ? 'flash' : 'createUser';
      const mutation = vi.spyOn(port, action).mockImplementation(async () => {
        const persisted = await durableEpoch();
        if (operation === 'install-os') expect(persisted.deviceEpoch).not.toBe(before.deviceEpoch);
        else expect(persisted.profileEpochs.work).not.toBe(before.profileEpochs.work);
        const inspected = inspectRegistryBinding(original.devices[0]!, persisted, inventory);
        expect(inspected.profiles[1]?.fields.pin?.state).toBe('stale');
        expect(inspected.fields.duressPin?.state).toBe(operation === 'install-os' ? 'stale' : 'current');
        throw new Error('Synthetic device failure; no hardware contacted');
      });
      const prepared = await engine.prepare(target, operation);
      const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Synthetic operator');
      const result = await engine.execute(run.id);
      expect(result.status).toBe('needs-inspection');
      expect(mutation).toHaveBeenCalledOnce();
      const retained = inspectRegistryBinding(original.devices[0]!, await durableEpoch(), inventory);
      expect(retained.profiles[1]?.fields.pin?.state).toBe('stale');
      expect(original.devices[0]?.profiles[1]?.fields.pin?.state).toBe('current');
    },
  );

  it.each(['install-os', 'create-users'] as const)(
    'does not invoke %s when invalidation cannot be persisted',
    async (operation) => {
      const compareAndSet = store.compareAndSet.bind(store);
      vi.spyOn(store, 'compareAndSet').mockImplementation((collection, key, expected, next) => {
        if (collection === 'registry-generation')
          return Promise.reject(new Error('Synthetic durable write failure'));
        return compareAndSet(collection, key, expected, next);
      });
      const mutation = vi.spyOn(port, operation === 'install-os' ? 'flash' : 'createUser');
      const prepared = await engine.prepare(target, operation);
      const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Synthetic operator');
      expect((await engine.execute(run.id)).status).toBe('needs-inspection');
      expect(mutation).not.toHaveBeenCalled();
      expect((await readRegistryGeneration(store, device)).deviceEpoch).toBe('');
      expect(await store.get('registry-generation', device.assetId)).toBeUndefined();
    },
  );
});
