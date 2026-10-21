import { approveProject } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { requiredAttestations, type SelectedTarget } from '@pxv/contracts';
import { SqliteStore } from '@pxv/runtime';
import { createProject, loadProject, saveInventory, WorkflowEngine, type WorkflowState } from '@pxv/engine';
import { AttestationService } from '../../packages/engine/src/attestation-service.js';
import { HandoffService } from '../../packages/engine/src/handoff-service.js';
import { ObservationService } from '../../packages/engine/src/observation-service.js';
import { CapabilityProofVerifier } from '../../packages/engine/src/capability-proof-verifier.js';
import { EvidenceService } from '../../packages/engine/src/evidence-service.js';
import { NativeDeviceOwnership, NativeProjectOwnership } from '../../packages/engine/src/ownership.js';
import { PlanRepository } from '../../packages/engine/src/plan-repository.js';
import { device, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort, executeWithWitnesses } from './fixtures.js';

describe('independently composed attestation and handoff services', () => {
  let root: string;
  let store: SqliteStore;
  let port: MemoryPort;
  let state: WorkflowState;
  let attestation: AttestationService;
  let handoff: HandoffService;
  const target: SelectedTarget = { device, transport: { kind: 'usb', serial: 'PIXEL1' } };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-handoff-service-'));
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const project = await loadProject(created.root, product);
    await approveProject(project);
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new MemoryPort();
    const clock = () => new Date('2026-10-16T09:00:00Z');
    const observations = new ObservationService(project, port);
    const devices = new NativeDeviceOwnership(join(root, 'control'));
    const projects = new NativeProjectOwnership(project, join(root, 'control'));
    const plans = new PlanRepository(project, store, observations, clock);
    const evidence = new EvidenceService(
      project,
      store,
      observations,
      devices,
      clock,
      new CapabilityProofVerifier(project, store, plans),
    );
    attestation = new AttestationService(
      project,
      store,
      port,
      observations,
      evidence,
      plans,
      devices,
      projects,
      clock,
    );
    handoff = new HandoffService(project, store, port, observations, evidence, devices, projects, clock);
    const engine = new WorkflowEngine({
      project,
      store,
      port,
      clock,
      controlRoot: join(root, 'control'),
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
    });
    const prepared = await engine.prepare(target);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    await executeWithWitnesses(engine, run.id);
    state = await engine.state(device.assetId);
    await store.delete('attestations', device.assetId);
    await store.set('workflow', device.assetId, state);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const signoff = async () => {
    for (const check of requiredAttestations(basePolicy())) await attestation.attest(target, check, 'Alice');
  };
  it('records a supported receipt through independently composed services', async () => {
    const receipt = await attestation.attest(target, 'operator_signoff', 'Alice', 'Inspected locally');
    expect(receipt.note).toBe('Inspected locally');
    expect(await store.get('attestations', device.assetId)).toEqual([receipt]);
    expect(port.calls).toEqual([]);
  });
  it('rejects a changed live observation before persisting any receipt', async () => {
    port.observation.debuggingEnabled = !state.observation.debuggingEnabled;
    await expect(attestation.attest(target, 'operator_signoff', 'Alice')).rejects.toThrow(
      'Live state changed',
    );
    expect(await store.get('attestations', device.assetId)).toBeUndefined();
  });
  it('requires signoffs before requesting debugging shutdown', async () => {
    await expect(handoff.finalize(target, 'Alice')).rejects.toThrow('Handoff checks remain');
    expect(port.calls).not.toContain('finalize');
    expect(await store.get('workflow', device.assetId)).toEqual(state);
  });
  it('preserves a competing generation and performs no shutdown when intent compare fails', async () => {
    await signoff();
    const transition = store.transition.bind(store);
    const changed = { ...state, pending: ['external-inspection'] };
    vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
      await store.set('workflow', device.assetId, changed);
      return transition(input);
    });
    await expect(handoff.finalize(target, 'Alice')).rejects.toThrow('evidence changed before finalization');
    expect(port.calls).not.toContain('finalize');
    expect(await store.get('workflow', device.assetId)).toEqual(changed);
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
  });
  it('retains a changed shutdown generation instead of recording an accepted handoff', async () => {
    await signoff();
    const changed = { ...state, status: 'pending', pending: ['external-shutdown-inspection'] };
    const finalize = port.finalize.bind(port);
    vi.spyOn(port, 'finalize').mockImplementation(async (...args) => {
      await finalize(...args);
      await store.set('workflow', device.assetId, changed);
    });
    await expect(handoff.finalize(target, 'Alice')).rejects.toThrow('evidence changed during finalization');
    expect(port.calls).toContain('finalize');
    expect(await store.get('workflow', device.assetId)).toEqual(changed);
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
    expect(await store.entries('handoff-snapshots')).toEqual([]);
  });
  it('requires an enrolled asset before recording custody', async () => {
    await expect(handoff.acceptCustody('unknown', 'Recipient', true)).rejects.toThrow('enrolled device');
    expect(await store.entries('handoff')).toEqual([]);
  });
});
