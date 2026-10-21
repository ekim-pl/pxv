import { approveProject } from './fixtures.js';
import { executeWithWitnesses } from './fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { digest } from '@pxv/contracts';
import type {
  SeedvaultAdapterDefinition,
  SeedvaultInspection,
  SeedvaultProfileIdentity,
  SeedvaultRequest,
  SeedvaultProfileResult,
} from '@pxv/contracts';
import {
  createProject,
  loadProject,
  saveInventory,
  WorkflowEngine,
  ResourceScope,
  recordLifecycle,
} from '@pxv/engine';
import type { SeedvaultWorkflowPort } from '@pxv/engine';
import { recoveryReservations, SqliteStore } from '@pxv/runtime';
import { AndroidAdapter } from '@pxv/adapters';
import { SeedvaultRun } from '../../packages/adapters/src/seedvault-run.js';
import { device, hashA, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

type SeedvaultExecutionContext = Parameters<SeedvaultWorkflowPort['executeProfile']>[3];

const selector = { resourceId: 'com.stevesoltys.seedvault:id/complete', text: 'Generation fixture' };
const adapter: SeedvaultAdapterDefinition = {
  schemaVersion: 1,
  id: 'fixture',
  buildFingerprint: 'fixture/build',
  package: { packageId: 'com.stevesoltys.seedvault', versionCode: 1, signerSha256: hashA },
  acceptance: { path: '/fixture/acceptance.json', sha256: hashA },
  activities: ['com.stevesoltys.seedvault/.settings.SettingsActivity'],
  restoreSourceResourceId: 'com.stevesoltys.seedvault:id/source',
  restoreFileSourceResourceId: 'com.stevesoltys.seedvault:id/file-source',
  backup: {
    steps: [
      { action: 'start-backup', selector },
      { action: 'observe-files-running', selector },
    ],
    completion: {
      apps: selector,
      files: selector,
      finalized: selector,
      idle: selector,
      generation: selector,
      fileGeneration: selector,
    },
  },
  restore: {
    steps: [
      { action: 'select-source' },
      { action: 'start-restore', selector },
      { action: 'select-file-source' },
      { action: 'start-files-restore', selector },
      { action: 'observe-files-running', selector },
    ],
    completion: {
      apps: selector,
      files: selector,
      finalized: selector,
      idle: selector,
      generation: selector,
      fileGeneration: selector,
    },
  },
};
const selectedDevice = {
  ...device,
  transports: [...device.transports, { kind: 'wifi' as const, serial: '192.0.2.5:37111' }],
};
const target = { device: selectedDevice, transport: selectedDevice.transports[1]! };
const users = [
  { profileId: 'admin', user: { userId: 0, serialNo: 0, name: 'Administrator' } },
  { profileId: 'personal', user: { userId: 11, serialNo: 42, name: 'Personal' } },
];
function inspection(): SeedvaultInspection {
  return {
    deviceSerial: device.canonicalSerial,
    osFingerprint: adapter.buildFingerprint,
    foregroundUserId: 0,
    unsupportedUsers: [],
    profiles: users.map((profile) => ({
      ...structuredClone(profile),
      package: structuredClone(adapter.package),
      backup: { enabled: true, transportPackage: 'com.stevesoltys.seedvault' },
      unlocked: true,
    })),
  };
}

class SeedvaultMemory implements SeedvaultWorkflowPort {
  observed = inspection();
  calls: string[] = [];
  pending = new Set<string>();
  fail = new Set<string>();
  remote = false;
  retainRemote = false;
  transform?: (result: SeedvaultProfileResult) => SeedvaultProfileResult;
  inspect(): Promise<SeedvaultInspection> {
    return Promise.resolve(structuredClone(this.observed));
  }
  async executeProfile(
    _target: unknown,
    profile: SeedvaultProfileIdentity,
    request: SeedvaultRequest,
    context: SeedvaultExecutionContext,
  ): Promise<SeedvaultProfileResult> {
    this.calls.push(profile.profileId);
    context.signal?.throwIfAborted();
    const progress = context.progress ?? {
      phase: 'prepared' as const,
      beforeTokens: [],
      obligationIds: [randomUUID(), randomUUID()],
      adapterDigest: digest(adapter),
      step: 0,
      previousForeground: users[0]!.user,
    };
    if (this.remote && !context.progress) {
      await context.lease.run(['/bin/true'], { mutation: true });
      for (const id of progress.obligationIds)
        await context.obligations.record({
          schemaVersion: 1,
          id,
          operationId: context.obligations.operationId,
          ownerOperationId: context.obligations.ownerOperationId,
          deviceSerial: device.canonicalSerial,
          kind: 'android-background-job',
          resource: 'seedvault',
          payload: {},
          status: 'pending',
          user: profile.user,
        });
    }
    progress.phase = 'running';
    progress.step = 1;
    await context.saveProgress(progress);
    if (this.fail.has(profile.profileId)) throw new Error('Injected Seedvault failure');
    if (this.pending.delete(profile.profileId))
      return { status: 'manual-pending' as const, instructions: 'Unlock privately on the device.', progress };
    if (this.remote && !this.retainRemote)
      for (const id of progress.obligationIds) await context.obligations.resolve(id);
    const source = request.sources?.find((item) => item.profileId === profile.profileId) ?? {
      profileId: profile.profileId,
      token: 'abc',
      selector,
      filesSelector: selector,
    };
    const result: SeedvaultProfileResult = {
      status: 'measured' as const,
      progress: { ...progress, phase: 'completed' as const, step: 2 },
      evidence: {
        profileId: profile.profileId,
        user: profile.user,
        operation: request.operation,
        token: source.token,
        observedAt: '2026-10-16T10:00:00Z',
        adapterDigest: digest(adapter),
        apps: true as const,
        files: true as const,
        finalized: true as const,
        source,
      },
    };
    return this.transform ? this.transform(result) : result;
  }
}

describe('supervised Seedvault runs', () => {
  let root: string;
  let store: SqliteStore;
  let port: SeedvaultMemory;
  let engine: WorkflowEngine;
  let now: Date;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-seedvault-'));
    const codeRoot = join(root, 'code');
    await mkdir(join(codeRoot, 'packages/core'), { recursive: true });
    await writeFile(join(codeRoot, 'packages/core/build.js'), 'export const version=1;');
    const policy = basePolicy();
    policy.profiles.push({
      ...structuredClone(policy.profiles[0]!),
      id: 'personal',
      name: 'Personal',
      kind: 'secondary',
    });
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), codeRoot);
    await saveInventory(created, { schemaVersion: 1, devices: [selectedDevice] });
    const project = await loadProject(created.root, product, codeRoot);
    await approveProject(project);
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new SeedvaultMemory();
    now = new Date('2026-10-16T10:00:00Z');
    engine = new WorkflowEngine({
      project,
      store,
      port: new MemoryPort(),
      seedvault: port,
      artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
      controlRoot: join(root, 'control'),
      clock: () => now,
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function prepare(request: SeedvaultRequest = { operation: 'backup', adapter }) {
    const prepared = await engine.prepareSeedvault(target, request);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner');
    return { prepared, run };
  }

  it('blocks optional continuations while preserving retained shutdown intent and inspection', async () => {
    const { prepared, run } = await prepare();
    const retained = { schemaVersion: 1, policyDigest: 'old-baseline', pending: ['debugging-shutdown'] };
    await store.set('workflow', device.assetId, retained);
    await expect(engine.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
      'finalization-inspection',
    );
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
      'finalization-inspection',
    );
    await expect(engine.execute(run.id)).rejects.toThrow('finalization-inspection');
    await store.set('runs', run.id, { ...run, status: 'pending', manualGate: 'seedvault:admin' });
    await expect(engine.refreshReview(run.id)).rejects.toThrow('finalization-inspection');
    expect((await engine.inspectSeedvault(target)).deviceSerial).toBe(device.canonicalSerial);
    await engine.cancel(run.id);
    expect(port.calls).toEqual([]);
    expect(await store.get('workflow', device.assetId)).toEqual(retained);
  });

  it('prepares read-only exact reviews and idempotently approves without touching provision evidence', async () => {
    await store.set('workflow', device.assetId, { preserved: 'provisioning' });
    const { prepared, run } = await prepare();
    expect(port.calls).toEqual([]);
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary + '\n', 'Owner')).rejects.toThrow(
      'exact reviewed summary',
    );
    expect(await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).toEqual(run);
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    const report = await engine.seedvaultReport(run.id);
    expect(report.cursor).toBe(2);
    expect(report.profiles.every((profile) => profile.evidence?.apps && profile.evidence.files)).toBe(true);
    expect(port.calls).toEqual(['admin', 'personal']);
    expect(await store.get('workflow', device.assetId)).toEqual({ preserved: 'provisioning' });
    expect(await store.entries('attestations')).toEqual([]);
    expect((await store.events<{ type: string }>(run.id)).map((item) => item.event.type)).toContain(
      'seedvault-profile-progress',
    );
  });

  it('pauses for locked profiles and resumes only the unfinished profile without an attestation', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    expect(await executeWithWitnesses(engine, run.id)).toMatchObject({
      status: 'pending',
      cursor: 1,
      manualGate: 'seedvault:personal',
    });
    port.observed.profiles[1]!.unlocked = true;
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    expect(port.calls).toEqual(['admin', 'personal', 'personal']);
    expect((await engine.seedvaultReport(run.id)).profiles[0]!.status).toBe('completed');
  });

  it('keeps recovery history readable when experimental recovery is disabled in the core product', async () => {
    const { prepared, run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    const report = await engine.seedvaultReport(run.id);
    const retained = await store.get('runs', run.id);
    const core = new WorkflowEngine({
      project: {
        ...engine.project,
        product: { ...engine.project.product, features: { extensions: false, seedvault: false } },
      },
      store,
      port: engine.port,
      seedvault: port,
      artifacts: engine.artifacts,
      controlRoot: engine.controlRoot,
      clock: engine.clock,
    });
    expect(await core.seedvaultReport(run.id)).toEqual(report);
    const count = port.calls.length;
    await expect(core.inspectSeedvault(target)).rejects.toThrow('optional experimental recovery');
    await expect(core.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
      'optional experimental recovery',
    );
    await expect(core.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
      'optional experimental recovery',
    );
    await expect(core.execute(run.id)).rejects.toThrow('optional experimental recovery');
    await expect(core.refreshReview(run.id)).rejects.toThrow('optional experimental recovery');
    expect(await store.get('runs', run.id)).toEqual(retained);
    expect(port.calls).toHaveLength(count);
    await expect(
      core.prepareExtension(target, [
        { kind: 'manual', capability: 'app_setup', instructions: 'Configure privately' },
      ]),
    ).rejects.toThrow('outside this core product');
  });

  it('refuses reused Android IDs and changed package pins before resuming', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    port.observed.profiles[1]!.user.serialNo++;
    const stopped = await executeWithWitnesses(engine, run.id);
    expect(stopped.status).toBe('needs-inspection');
    expect(stopped.error).toContain('identity changed');
    expect(port.calls).toEqual(['admin', 'personal']);
  });

  it('requires complete profile mappings and explicit restore sources', async () => {
    await expect(
      engine.prepareSeedvault(target, {
        operation: 'restore',
        adapter,
        sources: [{ profileId: 'admin', token: 'abc', selector, filesSelector: selector }],
      }),
    ).rejects.toThrow('every target profile');
    port.observed.unsupportedUsers.push({ userId: 14, serialNo: 90, name: 'Guest' });
    expect((await engine.inspectSeedvault(target)).unsupportedUsers).toHaveLength(1);
    await expect(engine.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
      'Unsupported Android users',
    );
    port.observed = inspection();
    port.observed.profiles.pop();
    await expect(engine.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
      'Every persistent profile',
    );
  });

  it('refreshes an expired intentional checkpoint preserving completed profile evidence', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    now = new Date(now.getTime() + 900001);
    await expect(executeWithWitnesses(engine, run.id)).rejects.toThrow('expired');
    const fresh = await engine.refreshReview(run.id);
    expect((await store.get<{ status: string }>('runs', run.id))?.status).toBe('superseded');
    const approved = await engine.submit(fresh.plan.id, fresh.reviewSummary, 'Owner');
    expect((await executeWithWitnesses(engine, approved.id)).status).toBe('completed');
    expect(port.calls).toEqual(['admin', 'personal', 'personal']);
    expect((await engine.seedvaultReport(approved.id)).profiles[0]!.evidence?.user).toEqual(users[0]!.user);
    await expect(engine.refreshReview(approved.id)).rejects.toThrow('intentional');
  });

  it('retains a remote-job fence while paused and resumes the same owner under recovery ownership', async () => {
    port.remote = true;
    port.pending.add('admin');
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
    expect(await recoveryReservations(engine.controlRoot)).not.toHaveLength(0);
    await expect(engine.refreshReview(run.id)).rejects.toThrow();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    expect(await recoveryReservations(engine.controlRoot)).toEqual([]);
    expect((await store.get<{ operationId: string }>('recovery-attempts', run.id))?.operationId).toMatch(
      /^recovery-/u,
    );
  });

  it('retains durable partial progress on failure and handles cancellation without replay', async () => {
    port.fail.add('personal');
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect((await engine.seedvaultReport(run.id)).cursor).toBe(1);
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect(port.calls).toEqual(['admin', 'personal']);
    const next = await prepare();
    await engine.cancel(next.run.id);
    expect((await executeWithWitnesses(engine, next.run.id)).status).toBe('cancelled');
    expect(port.calls).toEqual(['admin', 'personal']);
  });

  it('restores each explicit source against fresh target user identities', async () => {
    const sources = users.map((profile, index) => ({
      profileId: profile.profileId,
      token: String(index + 1),
      selector,
      filesSelector: selector,
    }));
    const { run } = await prepare({ operation: 'restore', adapter, sources });
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    expect(
      (await engine.seedvaultReport(run.id)).profiles.map((profile) => profile.evidence?.source),
    ).toEqual(sources);
  });

  it('rejects duplicate Android mappings and a Seedvault signer changed after review', async () => {
    port.observed.profiles[1]!.user = { ...port.observed.profiles[0]!.user };
    await expect(engine.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
      'reuse an Android',
    );
    port.observed = inspection();
    const { run } = await prepare();
    port.observed.profiles[1]!.package.signerSha256 = 'b'.repeat(64);
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect(port.calls).toEqual([]);
  });

  it('rejects changed exact reviews and wrong restore-set evidence', async () => {
    const first = await prepare();
    await store.set('seedvault-plans', first.prepared.plan.id, {
      ...first.prepared,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    await expect(
      engine.submit(first.prepared.plan.id, first.prepared.reviewSummary, 'Owner'),
    ).rejects.toThrow('review changed');
    const sources = users.map((profile) => ({
      profileId: profile.profileId,
      token: 'abc',
      selector,
      filesSelector: selector,
    }));
    const { run } = await prepare({ operation: 'restore', adapter, sources });
    port.transform = (result) =>
      result.status === 'measured'
        ? {
            ...result,
            evidence: {
              ...result.evidence,
              token: 'bad',
              source: { ...result.evidence.source, token: 'bad' },
            },
          }
        : result;
    const stopped = await executeWithWitnesses(engine, run.id);
    expect(stopped.status).toBe('needs-inspection');
    expect(stopped.error).toContain('different backup source');
    expect((await engine.seedvaultReport(run.id)).cursor).toBe(0);
  });

  it('preserves interrupted remote work and blocks another backup owner', async () => {
    port.remote = true;
    port.fail.add('admin');
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect(await recoveryReservations(engine.controlRoot)).not.toHaveLength(0);
    const next = await prepare();
    const blocked = await executeWithWitnesses(engine, next.run.id);
    expect(blocked.status).toBe('needs-inspection');
    expect(blocked.error).toMatch(/unresolved|reservation/u);
    expect(port.calls).toEqual(['admin']);
  });

  it('never treats partial application-only results as a completed profile', async () => {
    port.transform = (result) =>
      result.status === 'measured'
        ? { ...result, evidence: { ...result.evidence, files: false as true } }
        : result;
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
    expect((await engine.seedvaultReport(run.id)).profiles[0]!.evidence).toBeUndefined();
  });

  it.each(['name', 'owner'] as const)(
    'rejects a mismatched mapped profile %s before review',
    async (field) => {
      if (field === 'name') port.observed.profiles[1]!.user.name = 'Unreviewed profile';
      else port.observed.profiles[0]!.user.userId = 15;
      await expect(engine.prepareSeedvault(target, { operation: 'backup', adapter })).rejects.toThrow(
        'name or owner identity',
      );
      expect(port.calls).toEqual([]);
    },
  );

  it('keeps the reviewed profile order when live enumeration changes between visits', async () => {
    port.transform = (result) => {
      if (result.status === 'measured' && result.evidence.profileId === 'admin')
        port.observed.profiles.reverse();
      return result;
    };
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    expect(port.calls).toEqual(['admin', 'personal']);
  });

  it.each(['work.personal', 'p'.repeat(128)])(
    'supports valid profile IDs in real recovery scopes: %s',
    (profileId) => {
      const scope = new ResourceScope(store, device.canonicalSerial, 'scope-fixture');
      const android = new AndroidAdapter({
        runner: { run: () => Promise.reject(new Error('No live device commands')) },
      });
      expect(
        () =>
          new SeedvaultRun(
            android,
            target,
            { ...port.observed.profiles[1]!, profileId },
            { operation: 'backup', adapter },
            adapter,
            { lease: {}, obligations: scope.writer(), saveProgress: () => Promise.resolve() },
          ),
      ).not.toThrow();
      expect(port.calls).toEqual([]);
    },
  );

  it('rejects non-wireless approvals, empty owners, absent reports and wrong canonical phones', async () => {
    await expect(
      engine.prepareSeedvault(
        { device: selectedDevice, transport: selectedDevice.transports[0]! },
        { operation: 'backup', adapter },
      ),
    ).rejects.toThrow('wireless ADB');
    const { prepared } = await prepare();
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, ' ')).rejects.toThrow(
      'Operator identity',
    );
    await expect(engine.seedvaultReport('missing')).rejects.toThrow('no durable profile report');
    port.observed.deviceSerial = 'ANOTHER_PHONE';
    await expect(engine.inspectSeedvault(target)).rejects.toThrow('observed identity');
    const missing = new WorkflowEngine({
      project: engine.project,
      store,
      port: new MemoryPort(),
      artifacts: engine.artifacts,
      controlRoot: engine.controlRoot,
    });
    await expect(missing.inspectSeedvault(target)).rejects.toThrow('adapter is unavailable');
  });

  it('keeps unsupported build checkpoints pending without fabricated progress or attestations', async () => {
    port.executeProfile = () =>
      Promise.resolve({ status: 'manual-pending', instructions: 'No accepted build; retain private setup.' });
    const { run } = await prepare({ operation: 'backup' });
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
    const report = await engine.seedvaultReport(run.id);
    expect(report.profiles[0]!.instructions).toContain('No accepted build');
    expect(report.profiles[0]!.progress).toBeUndefined();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('pending');
  });

  it.each(['profile', 'operation', 'adapter', 'snapshot', 'phase', 'progress', 'instructions'] as const)(
    'rejects invalid adapter %s evidence before claiming success',
    async (field) => {
      port.transform = (result) => {
        if (result.status !== 'measured') return result;
        const changed = structuredClone(result);
        if (field === 'profile') changed.evidence.user.serialNo++;
        if (field === 'operation') changed.evidence.operation = 'restore';
        if (field === 'adapter') changed.evidence.adapterDigest = 'f'.repeat(64);
        if (field === 'snapshot') changed.evidence.source.token = 'def';
        if (field === 'phase') changed.progress.phase = 'running';
        if (field === 'progress') changed.progress.adapterDigest = 'f'.repeat(64);
        if (field === 'instructions')
          return { status: 'manual-pending', instructions: ' ', progress: changed.progress };
        return changed;
      };
      const { run } = await prepare();
      expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
      expect((await engine.seedvaultReport(run.id)).cursor).toBe(0);
    },
  );

  it.each([
    'schema',
    'run',
    'plan',
    'operation',
    'phone',
    'negative',
    'fraction',
    'overflow',
    'identity',
    'cursor',
    'prefix',
    'evidence',
  ] as const)('preserves and refuses corrupted durable profile %s records', async (field) => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    const report = await engine.seedvaultReport(run.id);
    const changed = structuredClone(report);
    if (field === 'schema') changed.schemaVersion = 2 as 1;
    if (field === 'run') changed.runId = 'wrong';
    if (field === 'plan') changed.planId = 'wrong';
    if (field === 'operation') changed.operation = 'restore';
    if (field === 'phone') changed.deviceSerial = 'WRONG';
    if (field === 'negative') changed.cursor = -1;
    if (field === 'fraction') changed.cursor = 0.5;
    if (field === 'overflow') changed.cursor = 3;
    if (field === 'identity') changed.profiles[0]!.user.serialNo++;
    if (field === 'cursor') changed.cursor = 0;
    if (field === 'prefix') changed.profiles[0]!.status = 'queued';
    if (field === 'evidence') delete changed.profiles[0]!.evidence;
    await store.set('seedvault-progress', run.id, changed);
    await expect(engine.seedvaultReport(run.id)).rejects.toThrow();
    expect(await store.get('seedvault-progress', run.id)).toEqual(changed);
  });

  it('requires review lineage to retain its superseded predecessor', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    const fresh = await engine.refreshReview(run.id);
    await store.delete('runs', run.id);
    await expect(engine.submit(fresh.plan.id, fresh.reviewSummary, 'Owner')).rejects.toThrow('not committed');
  });

  it('refuses refresh while job obligations remain even before a device mutation', async () => {
    port.pending.add('admin');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    const writer = new ResourceScope(store, device.canonicalSerial, run.id).writer();
    await writer.record({
      schemaVersion: 1,
      id: randomUUID(),
      operationId: run.id,
      ownerOperationId: run.id,
      deviceSerial: device.canonicalSerial,
      kind: 'seedvault-job',
      resource: 'fixture',
      payload: {},
      status: 'pending',
    });
    await expect(engine.refreshReview(run.id)).rejects.toThrow('Recover unresolved remote jobs');
  });

  it('refuses a changed profile at refresh and detects a concurrent checkpoint replacement', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    port.observed.profiles[1]!.user.serialNo++;
    await expect(engine.refreshReview(run.id)).rejects.toThrow('changed at the checkpoint');
    port.observed = inspection();
    const transition = store.transition.bind(store);
    vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
      await store.set('runs', run.id, { ...run, status: 'cancelled' });
      return transition(input);
    });
    await expect(engine.refreshReview(run.id)).rejects.toThrow('checkpoint changed');
  });

  it('refuses completed adapter claims while the profile still owns a remote job', async () => {
    port.remote = true;
    port.retainRemote = true;
    const { run } = await prepare();
    const stopped = await executeWithWitnesses(engine, run.id);
    expect(stopped.status).toBe('needs-inspection');
    expect(stopped.error).toContain('outstanding remote resources');
    expect((await engine.seedvaultReport(run.id)).cursor).toBe(0);
    expect(await recoveryReservations(engine.controlRoot)).not.toHaveLength(0);
  });

  it('blocks unresolved obligations from another owner even without a native reservation', async () => {
    const writer = new ResourceScope(store, device.canonicalSerial, 'another-operation').writer();
    await writer.record({
      schemaVersion: 1,
      id: randomUUID(),
      operationId: writer.operationId,
      ownerOperationId: writer.ownerOperationId,
      deviceSerial: device.canonicalSerial,
      kind: 'seedvault-job',
      resource: 'fixture',
      payload: {},
      status: 'pending',
    });
    const { run } = await prepare();
    const blocked = await executeWithWitnesses(engine, run.id);
    expect(blocked.status).toBe('needs-inspection');
    expect(blocked.error).toContain('another operation');
    expect(port.calls).toEqual([]);
  });

  it('honors cancellation arriving between remote completion and evidence acceptance', async () => {
    const controller = new AbortController();
    const original = port.executeProfile.bind(port);
    port.executeProfile = async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    };
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id, controller.signal)).status).toBe('cancelled');
    expect((await engine.seedvaultReport(run.id)).cursor).toBe(0);
    expect(port.calls).toEqual(['admin']);
  });

  it('retains completed-prefix ordering across refreshed live profile enumeration', async () => {
    port.pending.add('personal');
    const { run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    port.observed.profiles.reverse();
    const fresh = await engine.refreshReview(run.id);
    const next = await engine.submit(fresh.plan.id, fresh.reviewSummary, 'Owner');
    expect((await executeWithWitnesses(engine, next.id)).status).toBe('completed');
    expect(port.calls).toEqual(['admin', 'personal', 'personal']);
    expect((await engine.seedvaultReport(next.id)).cursor).toBe(2);
  });

  it('retains audited completed profile history after maintenance while refusing retired approvals', async () => {
    const { prepared, run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    const before = await engine.seedvaultReport(run.id);
    await recordLifecycle(
      engine.project,
      store,
      {
        assetId: device.assetId,
        type: 'maintenance',
        operator: 'Owner',
        note: 'Prepare personal recovery',
        confirmedErasure: false,
      },
      undefined,
      engine.controlRoot,
    );
    expect(await engine.seedvaultReport(run.id)).toEqual(before);
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
      'lifecycle event',
    );
    expect((await executeWithWitnesses(engine, run.id)).status).toBe('completed');
    expect(port.calls).toEqual(['admin', 'personal']);
  });

  it('reads immutable backup history after endpoint and policy changes without authorizing its old operation', async () => {
    const { prepared, run } = await prepare();
    await executeWithWitnesses(engine, run.id);
    const before = await engine.seedvaultReport(run.id);
    const enrolled = engine.project.inventory.devices[0]!;
    enrolled.transports = [enrolled.transports[0]!, { kind: 'wifi', serial: '192.0.2.44:45678' }];
    expect(await engine.seedvaultReport(run.id)).toEqual(before);
    await expect(engine.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
      'enrolled device',
    );
    const changed = new WorkflowEngine({
      project: { ...engine.project, resolved: { ...engine.project.resolved, digest: 'f'.repeat(64) } },
      store,
      port: new MemoryPort(),
      seedvault: port,
      artifacts: engine.artifacts,
      controlRoot: engine.controlRoot,
    });
    expect(await changed.seedvaultReport(run.id)).toEqual(before);
    await expect(changed.submit(prepared.plan.id, prepared.reviewSummary, 'Owner')).rejects.toThrow(
      'Policy lock is stale',
    );
  });

  it.each([
    'schema',
    'expiry',
    'project',
    'actions',
    'phone',
    'baseline',
    'kind',
    'transport-kind',
    'transport-binding',
    'plan-id',
    'review',
  ] as const)(
    'refuses corrupted immutable historical %s even after lifecycle invalidation',
    async (field) => {
      const { prepared, run } = await prepare();
      await executeWithWitnesses(engine, run.id);
      const changed = structuredClone(prepared);
      if (field === 'schema') changed.schemaVersion = 2 as 1;
      if (field === 'expiry') changed.expiresAt = 'invalid';
      if (field === 'project') changed.plan.projectId = randomUUID();
      if (field === 'actions')
        changed.plan.actions.push({
          kind: 'manual',
          capability: 'operator_signoff',
          instructions: 'Changed',
        });
      if (field === 'phone') changed.target.device.canonicalSerial = 'WRONG';
      if (field === 'baseline') changed.baseline.deviceSerial = 'WRONG';
      if (field === 'kind') {
        changed.target.device.kind = 'emulator';
        changed.plan.device.kind = 'emulator';
      }
      if (field === 'transport-kind')
        changed.target.transport = { kind: 'usb', serial: device.canonicalSerial };
      if (field === 'transport-binding') changed.target.transport = { kind: 'wifi', serial: 'unbound:1234' };
      if (field === 'plan-id') changed.plan.id = randomUUID();
      if (field === 'review') changed.reviewSummary = '{}';
      await store.set('seedvault-plans', prepared.plan.id, changed);
      await expect(engine.seedvaultReport(run.id)).rejects.toThrow();
      expect(await store.get('seedvault-plans', prepared.plan.id)).toEqual(changed);
    },
  );

  it('rejects restoration of a different file snapshot even when the application backup token matches', async () => {
    const sources = users.map((profile) => ({
      profileId: profile.profileId,
      token: 'abc',
      selector,
      filesSelector: selector,
    }));
    port.transform = (result) =>
      result.status === 'measured'
        ? {
            ...result,
            evidence: {
              ...result.evidence,
              source: {
                ...result.evidence.source,
                filesSelector: { ...result.evidence.source.filesSelector, text: 'Another file snapshot' },
              },
            },
          }
        : result;
    const { run } = await prepare({ operation: 'restore', adapter, sources });
    const stopped = await executeWithWitnesses(engine, run.id);
    expect(stopped.status).toBe('needs-inspection');
    expect(stopped.error).toContain('different backup source');
    expect((await engine.seedvaultReport(run.id)).cursor).toBe(0);
  });
});
