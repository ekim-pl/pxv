import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { requiredAttestations, toPolicyDocument } from '@pxv/contracts';
import {
  createProject,
  loadProject,
  saveInventory,
  writePolicyLock,
  WorkflowEngine,
  recordLifecycle,
  type ProjectContext,
  type RunRecord,
  type WorkflowState,
} from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { basePolicy, MemoryPort, executeWithWitnesses } from './fixtures.js';
import { device, product } from '../contracts/fixtures.js';
import { alteredPrepared } from './prepared-fixture.js';
let root: string, project: ProjectContext, store: SqliteStore, port: MemoryPort, engine: WorkflowEngine;
let now: Date;
const target = { device, transport: device.transports[0]! };
const application = () =>
  new WorkflowEngine({
    project,
    store,
    port,
    clock: () => now,
    controlRoot: join(root, 'control'),
    artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
  });
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-custody-continuity-');
  now = new Date('2026-10-20T10:00:00Z');
  const code = join(root, 'code');
  await mkdir(code);
  await writeFile(join(code, 'product.json'), JSON.stringify(product));
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()), code);
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  project = await loadProject(created.root, product, code);
  await writePolicyLock(project);
  store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
  port = new MemoryPort();
  engine = application();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function ready(extension = false) {
  const prepared = extension
    ? await engine.prepareExtension(target, [
        { kind: 'vpn', profileId: project.policy.profiles[0]!.id, vpn: project.policy.profiles[0]!.vpn },
      ])
    : await engine.prepare(target);
  const submitted = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  const run = await executeWithWitnesses(engine, submitted.id);
  for (const check of requiredAttestations(project.policy)) await engine.attest(target, check, 'Reviewer');
  return { run, prepared };
}
async function changeBaseline(kind: string) {
  if (kind === 'executable')
    await writeFile(
      join(project.codeRoot!, 'product.json'),
      JSON.stringify({ ...product, name: 'New executable' }),
    );
  else if (kind === 'policy')
    await writeFile(
      join(project.root, 'policy.json'),
      JSON.stringify(toPolicyDocument({ ...project.policy, name: 'New policy' })),
    );
  else if (kind === 'extensions')
    await writeFile(
      join(project.root, 'pxv.project.json'),
      JSON.stringify({
        ...project.config,
        extensions: [
          {
            id: '@private/changed',
            version: '0.1.0',
            integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
            apiVersion: 1,
            entry: 'index.js',
            installPath: 'a'.repeat(64),
          },
        ],
      }),
    );
  else
    await writeFile(
      join(project.root, 'pxv.project.json'),
      JSON.stringify({ ...project.config, insertMetadata: { projectName: 'New metadata' } }),
    );
  project = await loadProject(project.root, product, project.codeRoot);
  engine = application();
}
it('finalizes and accepts a fully executed completed extension run', async () => {
  const { run } = await ready(true);
  expect(run.status).toBe('completed');
  expect((await engine.readiness(target)).ready).toBe(true);
  await engine.finalize(target, 'Reviewer');
  expect((await engine.readiness(target)).missing).not.toContain('finalization-inspection');
  expect((await engine.acceptCustody(device.assetId, 'Recipient', true)).outcome).toBe('completed-custody');
  expect((await engine.runStatus(run.id)).run).toMatchObject({ status: 'completed', nextSteps: [] });
});

it('rejects altered retained plans at custody without changing handoff, workflow, run or audit', async () => {
  const { run, prepared } = await ready();
  const handoff = await engine.finalize(target, 'Reviewer');
  const state = await store.get('workflow', device.assetId);
  const events = await store.events(run.id);
  for (const value of Object.values(alteredPrepared(prepared))) {
    await store.set('plans', prepared.plan.id, value);
    await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow('differs from');
    expect(await store.get('handoff', device.assetId)).toEqual(handoff);
    expect(await store.get('workflow', device.assetId)).toEqual(state);
    expect(await store.get('runs', run.id)).toMatchObject({ status: 'pending' });
    expect(await store.events(run.id)).toEqual(events);
  }
  await store.set('plans', prepared.plan.id, prepared);
  expect((await engine.acceptCustody(device.assetId, 'Recipient', true)).outcome).toBe('completed-custody');
});

it('rejects altered prepared content before finalization intent or physical shutdown', async () => {
  const { prepared } = await ready();
  const before = await engine.state(device.assetId);
  for (const value of Object.values(alteredPrepared(prepared))) {
    await store.set('plans', prepared.plan.id, value);
    await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow();
    expect(await store.get('workflow', device.assetId)).toEqual(before);
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
    expect(port.calls).not.toContain('finalize');
  }
});

for (const failure of ['shutdown', 'transaction', 'audit', 'competing-run']) {
  it(`blocks readiness and repeated shutdown after incomplete ${failure} finalization`, async () => {
    const queuedPlan = await engine.prepare(target);
    const queued = await engine.submit(queuedPlan.plan.id, queuedPlan.reviewSummary, 'Reviewer');
    const { run } = await ready();
    const transition = store.transition.bind(store);
    const database = new DatabaseSync(join(project.root, 'state/pxv.sqlite3'));
    try {
      if (failure === 'shutdown') port.failAt = 'finalize';
      if (failure === 'transaction')
        vi.spyOn(store, 'transition').mockImplementation((input) =>
          input.changes.some((change) => change.collection === 'handoff')
            ? Promise.resolve(false)
            : transition(input),
        );
      if (failure === 'audit')
        database.exec(
          "CREATE TRIGGER handoff_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.type')='ready-for-handoff' BEGIN SELECT RAISE(ABORT,'handoff-audit-fault'); END",
        );
      if (failure === 'competing-run') {
        const finalize = port.finalize.bind(port);
        vi.spyOn(port, 'finalize').mockImplementation(async (...args) => {
          await finalize(...args);
          const current = await store.get<RunRecord>('runs', run.id);
          await store.set('runs', run.id, { ...current, competingChange: true });
        });
      }
      await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow();
      expect(await engine.readiness(target)).toMatchObject({
        ready: false,
        missing: ['finalization-inspection'],
      });
      expect(await engine.deviceStatus(target)).toMatchObject({
        ready: false,
        readinessStatus: 'available',
        missing: ['finalization-inspection'],
      });
      expect(await store.get('workflow', device.assetId)).toMatchObject({ pending: ['debugging-shutdown'] });
      expect(await store.get('handoff', device.assetId)).toBeUndefined();
      await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow(
        'after finalization',
      );
      await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('finalization-inspection');
      expect(port.calls.filter((call) => call === 'finalize')).toHaveLength(1);
      const audit = await store.events<{ type: string }>(`asset:${device.assetId}`, 0, 1000);
      expect(audit.filter((event) => event.event.type === 'debugging-shutdown-intent')).toHaveLength(1);
      const retained = await store.get('workflow', device.assetId);
      await expect(engine.submit(queuedPlan.plan.id, queuedPlan.reviewSummary, 'Reviewer')).rejects.toThrow(
        'finalization-inspection',
      );
      await expect(engine.execute(queued.id)).rejects.toThrow('finalization-inspection');
      await expect(engine.executeFleet([queued.id])).rejects.toThrow('Fleet execution failed');
      await store.set('runs', queued.id, {
        ...queued,
        status: 'pending',
        cursor: 0,
        manualGate: 'normal_credentials',
      });
      await expect(engine.refreshReview(queued.id)).rejects.toThrow('finalization-inspection');
      await expect(engine.prepare(target)).rejects.toThrow('finalization-inspection');
      await expect(
        engine.prepareExtension(target, [
          { kind: 'vpn', profileId: 'admin', vpn: project.policy.profiles[0]!.vpn },
        ]),
      ).rejects.toThrow('finalization-inspection');
      await expect(engine.attest(target, 'normal_credentials', 'Reviewer')).rejects.toThrow(
        'finalization-inspection',
      );
      expect(await store.get('workflow', device.assetId)).toEqual(retained);
    } finally {
      database.close();
    }
  });
}
it('retains shutdown inspection across baseline changes until explicit maintenance archives it', async () => {
  await ready();
  port.failAt = 'finalize';
  await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow();
  const retained = await store.get('workflow', device.assetId);
  await changeBaseline('executable');
  expect(await engine.deviceStatus(target)).toMatchObject({
    readinessStatus: 'unavailable',
    readinessUnavailableReason: 'baseline-changed',
    missing: ['readiness-unavailable', 'finalization-inspection', 'policy-lock'],
  });
  await writePolicyLock(project);
  await expect(engine.prepare(target)).rejects.toThrow('finalization-inspection');
  expect(await store.get('workflow', device.assetId)).toEqual(retained);
  await recordLifecycle(
    project,
    store,
    {
      assetId: device.assetId,
      type: 'maintenance',
      operator: 'Reviewer',
      note: 'Inspected incomplete shutdown',
      confirmedErasure: false,
    },
    undefined,
    join(root, 'control'),
  );
  expect(await store.get('workflow', device.assetId)).toBeUndefined();
  expect((await engine.prepare(target)).plan.actions).toBeDefined();
});
for (const kind of ['executable', 'policy', 'configuration', 'extensions'])
  for (const lock of ['missing', 'stale', 'renewed']) {
    it(`accepts original custody after ${kind} changes with ${lock} approval`, async () => {
      const { run } = await ready();
      const receipt = await engine.finalize(target, 'Reviewer');
      await changeBaseline(kind);
      if (lock === 'missing') await rm(join(project.root, 'policy.lock.json'));
      if (lock === 'renewed') await writePolicyLock(project);
      const inspect = vi.spyOn(port, 'inspect');
      const accepted = await engine.acceptCustody(device.assetId, 'Recipient', true);
      expect(accepted).toMatchObject({
        id: receipt.id,
        policyDigest: receipt.policyDigest,
        outcome: 'completed-custody',
      });
      expect(inspect).not.toHaveBeenCalled();
      expect((await engine.runStatus(run.id)).run).toMatchObject({ status: 'completed', nextSteps: [] });
    });
  }
for (const change of [
  'missing-run',
  'missing-plan',
  'interrupted',
  'superseded',
  'unfinished',
  'manual-gate',
]) {
  it(`blocks ${change} lineage before finalization intent or debugging shutdown`, async () => {
    const { run, prepared } = await ready();
    const original = await engine.state(device.assetId);
    if (change === 'missing-run') await store.delete('runs', run.id);
    else if (change === 'missing-plan') await store.delete('plans', prepared.plan.id);
    else
      await store.set('runs', run.id, {
        ...run,
        ...(change === 'interrupted' ? { status: 'needs-inspection' } : {}),
        ...(change === 'superseded' ? { status: 'superseded' } : {}),
        ...(change === 'unfinished' ? { cursor: 0 } : {}),
        ...(change === 'manual-gate' ? { manualGate: 'app_setup' } : {}),
      });
    await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow();
    expect(port.calls).not.toContain('finalize');
    expect(await store.get('workflow', device.assetId)).toEqual(original);
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
  });
}
it('does not revive custody after lifecycle invalidation', async () => {
  await ready();
  await engine.finalize(target, 'Reviewer');
  await recordLifecycle(
    project,
    store,
    {
      assetId: device.assetId,
      type: 'maintenance',
      operator: 'Reviewer',
      note: 'Visit',
      confirmedErasure: false,
    },
    undefined,
    join(root, 'control'),
  );
  await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow('Fresh provisioning');
});
for (const field of ['canonicalSerial', 'codename', 'kind', 'projectId']) {
  it(`rejects changed enrolled ${field} before custody`, async () => {
    await ready();
    await engine.finalize(target, 'Reviewer');
    if (field === 'projectId')
      await writeFile(
        join(project.root, 'pxv.project.json'),
        JSON.stringify({ ...project.config, id: 'different-project' }),
      );
    else
      await writeFile(
        join(project.root, 'inventory.json'),
        JSON.stringify({
          schemaVersion: 1,
          devices: [
            {
              ...device,
              ...(field === 'kind'
                ? {
                    canonicalSerial: 'emulator-5554',
                    transports: [{ kind: 'emulator', serial: 'emulator-5554' }],
                  }
                : {}),
              [field]: field === 'kind' ? 'emulator' : field === 'codename' ? 'husky' : 'OTHER',
            },
          ],
        }),
      );
    project = await loadProject(project.root, product, project.codeRoot);
    engine = application();
    await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow('identity differs');
  });
}
for (const collection of ['runs', 'plans', 'handoff-snapshots']) {
  it(`rolls back custody when its validated ${collection} changes before commit`, async () => {
    const { run, prepared } = await ready();
    const handoff = await engine.finalize(target, 'Reviewer');
    const transition = store.transition.bind(store);
    vi.spyOn(store, 'transition').mockImplementation(async (input) => {
      if (input.events.some((entry) => entry.runId === run.id)) {
        const key = collection === 'runs' ? run.id : collection === 'plans' ? prepared.plan.id : handoff.id;
        const previous = await store.get<Record<string, unknown>>(collection, key);
        await store.set(collection, key, { ...previous, competingChange: true });
      }
      return transition(input);
    });
    await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow(
      'changed before custody',
    );
    expect(await store.get('handoff', device.assetId)).toEqual(handoff);
    expect(await store.get<RunRecord>('runs', run.id)).toMatchObject({ status: 'pending' });
    expect(await store.get<WorkflowState>('workflow', device.assetId)).toMatchObject({
      status: 'shutdown-requested',
    });
    expect(
      (await store.events(run.id, 0, 1000)).some((event) =>
        JSON.stringify(event).includes('custody-completed'),
      ),
    ).toBe(false);
  });
}
it('reports missing current evidence without inventing a run or current state', async () => {
  expect(await engine.deviceStatus(target)).toMatchObject({
    ready: false,
    readinessStatus: 'unavailable',
    readinessUnavailableReason: 'missing-workflow',
    missing: ['readiness-unavailable'],
  });
  expect(await engine.deviceStatus(target)).not.toHaveProperty('state');
  expect(await engine.deviceStatus(target)).not.toHaveProperty('run');
  await expect(engine.readiness(target)).rejects.toThrow('Fresh provisioning');
});
it('reports historical completion after upgrades and lifecycle archival', async () => {
  const { run } = await ready();
  await engine.finalize(target, 'Reviewer');
  await engine.acceptCustody(device.assetId, 'Recipient', true);
  await changeBaseline('executable');
  expect(await engine.deviceStatus(target)).toMatchObject({
    ready: false,
    readinessStatus: 'unavailable',
    readinessUnavailableReason: 'baseline-changed',
    missing: ['readiness-unavailable', 'policy-lock'],
    run: { id: run.id, status: 'completed', nextSteps: [] },
  });
  await recordLifecycle(
    project,
    store,
    {
      assetId: device.assetId,
      type: 'maintenance',
      operator: 'Reviewer',
      note: 'Visit',
      confirmedErasure: false,
    },
    undefined,
    join(root, 'control'),
  );
  expect(await engine.deviceStatus(target)).toMatchObject({
    readinessUnavailableReason: 'missing-workflow',
    run: { status: 'completed', nextSteps: [] },
  });
});
it('distinguishes invalid workflow structure from timestamp expiry and storage failure', async () => {
  const { run } = await ready();
  await engine.finalize(target, 'Reviewer');
  await engine.acceptCustody(device.assetId, 'Recipient', true);
  now = new Date(now.getTime() + 900_001);
  expect(await engine.deviceStatus(target)).toMatchObject({
    readinessStatus: 'available',
    ready: false,
    missing: ['measurement-freshness'],
    run: { status: 'completed', nextSteps: [] },
  });
  const original = await store.get<WorkflowState>('workflow', device.assetId);
  await store.set('workflow', device.assetId, { ...original, observation: null });
  expect(await engine.deviceStatus(target)).toMatchObject({
    readinessStatus: 'unavailable',
    readinessUnavailableReason: 'invalid-workflow',
    run: { id: run.id, status: 'completed' },
  });
  await expect(engine.readiness(target)).rejects.toThrow();
  vi.spyOn(store, 'get').mockRejectedValue(new Error('Storage lost'));
  await expect(engine.deviceStatus(target)).rejects.toThrow('Storage lost');
});

for (const collection of ['runs', 'plans']) {
  it(`checks competing ${collection} changes before writing shutdown intent`, async () => {
    const { run, prepared } = await ready();
    const before = await engine.state(device.assetId);
    const transition = store.transition.bind(store);
    vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
      const key = collection === 'runs' ? run.id : prepared.plan.id;
      const value = await store.get<Record<string, unknown>>(collection, key);
      await store.set(collection, key, { ...value, competingChange: true });
      return transition(input);
    });
    await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('changed before finalization');
    expect(port.calls).not.toContain('finalize');
    expect(await store.get('workflow', device.assetId)).toEqual(before);
  });
}
