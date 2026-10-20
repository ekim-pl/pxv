import { executeWithWitnesses } from './fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observationDigest, toPolicyDocument, type SelectedTarget } from '@pxv/contracts';
import {
  createProject,
  loadProject,
  saveInventory,
  WorkflowEngine,
  type EmulatorImagePin,
  type EmulatorProvenance,
} from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { afterEach, beforeEach, expect, it, vi } from '../test-api.js';
import { hashA, hashB, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

const now = new Date('2026-10-16T09:00:00Z');
const pin: EmulatorImagePin = {
  path: '/tmp/approved-image.img',
  sha256: hashA,
  fingerprint: 'grapheneos/akita/test',
  source: 'https://example.org/image.img',
};
let root: string;
let store: SqliteStore;
let port: MemoryPort;
let engine: WorkflowEngine;
let target: SelectedTarget;
let eventCursor = 0;
const emulatorReceipts = async () =>
  (await engine.receipts('all')).filter((value) => value.check === 'emulator_image_provenance');
function measurement(): EmulatorProvenance {
  return {
    schemaVersion: 1,
    acceptance: 'emulator-only',
    canonicalSerial: target.device.canonicalSerial,
    fingerprint: pin.fingerprint,
    imageSha256: pin.sha256,
    source: pin.source,
    capabilities: [],
    observedAt: now.toISOString(),
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-attestation-'));
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  port = new MemoryPort();
  const transport = { kind: 'emulator', serial: 'emulator-5554' } as const;
  port.observation.device = {
    ...port.observation.device,
    kind: 'emulator',
    canonicalSerial: transport.serial,
    transports: [transport],
  };
  target = { device: port.observation.device, transport };
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
  await saveInventory(created, { schemaVersion: 1, devices: [target.device] });
  const project = await loadProject(created.root, product);
  engine = new WorkflowEngine({
    project,
    store,
    port,
    artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
    clock: () => now,
    controlRoot: join(root, 'control'),
  });
  const prepared = await engine.prepare(target);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
  await executeWithWitnesses(engine, run.id);
  eventCursor = (await store.events('asset:all')).at(-1)?.sequence ?? 0;
  port.verifyEmulatorEvidence = vi.fn(() => Promise.resolve(measurement()));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});

it.each([0, 60_000])(
  'binds matching emulator evidence aged %s ms to its workflow and audit receipt',
  async (age) => {
    const value = { ...measurement(), observedAt: new Date(now.getTime() - age).toISOString() };
    port.verifyEmulatorEvidence = vi.fn(() => Promise.resolve(value));
    const state = await engine.state('all');
    const receipt = await engine.attest(target, 'emulator_image_provenance', 'Alice', 'Reviewed image', pin);
    expect(port.verifyEmulatorEvidence).toHaveBeenCalledExactlyOnceWith(target, pin);
    expect(receipt).toMatchObject({
      check: 'emulator_image_provenance',
      operator: 'Alice',
      note: 'Reviewed image',
      planDigest: state.planDigest,
      observationDigest: observationDigest(port.observation),
      profileIds: ['admin'],
    });
    expect(await store.get('emulator-provenance', 'all')).toEqual({
      measurement: value,
      observationDigest: receipt.observationDigest,
      policyDigest: state.policyDigest,
      planDigest: state.planDigest,
    });
    expect(await emulatorReceipts()).toEqual([receipt]);
    const events = await store.events<{ type: string; receipt?: unknown }>('asset:all', eventCursor);
    expect(events.filter(({ event }) => event.type === 'attestation')).toEqual([
      expect.objectContaining({ event: { type: 'attestation', receipt } }),
    ]);
  },
);

it.each([
  ['invalid hash', { ...pin, sha256: 'invalid' }],
  ['empty path', { ...pin, path: '' }],
  ['control character', { ...pin, source: 'https://example.org/\nimage.img' }],
  ['non-string fingerprint', { ...pin, fingerprint: 123 }],
  ['extra key', { ...pin, unreviewed: true }],
  ['missing key', { path: pin.path, sha256: pin.sha256, fingerprint: pin.fingerprint }],
  ['unknown key', { path: pin.path, sha256: pin.sha256, fingerprint: pin.fingerprint, url: pin.source }],
] as const)('rejects an image pin with %s before asking the measurement provider', async (_name, input) => {
  await expect(
    engine.attest(
      target,
      'emulator_image_provenance',
      'Alice',
      undefined,
      input as unknown as EmulatorImagePin,
    ),
  ).rejects.toThrow('Invalid emulator image pin');
  expect(port.verifyEmulatorEvidence).not.toHaveBeenCalled();
  expect(await emulatorReceipts()).toEqual([]);
  expect(await store.get('emulator-provenance', 'all')).toBeUndefined();
});

it.each([
  ['schema', { schemaVersion: 2 }],
  ['acceptance', { acceptance: 'physical-device' }],
  ['device', { canonicalSerial: 'another-emulator' }],
  ['fingerprint', { fingerprint: 'other/build' }],
  ['hash', { imageSha256: hashB }],
  ['source', { source: 'https://example.org/other.img' }],
  ['invalid timestamp', { observedAt: 'invalid' }],
  ['future timestamp', { observedAt: new Date(now.getTime() + 1).toISOString() }],
  ['expired timestamp', { observedAt: new Date(now.getTime() - 60_001).toISOString() }],
  ['capabilities', { capabilities: ['unreviewed-capability'] }],
] as const)('rejects mismatched emulator %s without saving evidence or receipts', async (_name, patch) => {
  port.verifyEmulatorEvidence = () =>
    Promise.resolve({ ...measurement(), ...patch } as unknown as EmulatorProvenance);
  await expect(engine.attest(target, 'emulator_image_provenance', 'Alice', undefined, pin)).rejects.toThrow(
    'Emulator provenance does not match',
  );
  expect(await emulatorReceipts()).toEqual([]);
  expect(await store.get('emulator-provenance', 'all')).toBeUndefined();
});

it('requires both an image pin and a measurement provider; operator notes cannot substitute', async () => {
  await expect(
    engine.attest(target, 'emulator_image_provenance', 'Alice', 'Approved by hand'),
  ).rejects.toThrow('Measured emulator image evidence is required');
  expect(port.verifyEmulatorEvidence).not.toHaveBeenCalled();
  delete port.verifyEmulatorEvidence;
  await expect(engine.attest(target, 'emulator_image_provenance', 'Alice', undefined, pin)).rejects.toThrow(
    'Measured emulator image evidence is required',
  );
  expect(await emulatorReceipts()).toEqual([]);
});

it('replaces an earlier receipt with one atomically bound to the latest matching measurement', async () => {
  const first = await engine.attest(target, 'emulator_image_provenance', 'Alice', undefined, pin);
  const second = await engine.attest(target, 'emulator_image_provenance', 'Bob', 'Rechecked', pin);
  expect(second.id).not.toBe(first.id);
  expect(await emulatorReceipts()).toEqual([second]);
  expect(
    (await store.events<{ type: string }>('asset:all', eventCursor)).filter(
      ({ event }) => event.type === 'attestation',
    ),
  ).toHaveLength(2);
});

it('persists neither provenance nor a receipt when the attestation transaction loses its generation', async () => {
  vi.spyOn(store, 'transition').mockResolvedValueOnce(false);
  await expect(engine.attest(target, 'emulator_image_provenance', 'Alice', undefined, pin)).rejects.toThrow(
    'Asset evidence changed before attestation',
  );
  expect(await emulatorReceipts()).toEqual([]);
  expect(await store.get('emulator-provenance', 'all')).toBeUndefined();
  const events = await store.events<{ type: string }>('asset:all', eventCursor);
  expect(events.filter(({ event }) => event.type === 'attestation')).toEqual([]);
});
