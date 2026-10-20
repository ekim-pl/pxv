import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { requiredAttestations, resolvePolicy, toPolicyDocument } from '@pxv/contracts';
import {
  createProject,
  loadProject,
  policyLockStatus,
  recordLifecycle,
  saveInventory,
  WorkflowEngine,
  writePolicyLock,
  type ProjectContext,
  type RunRecord,
} from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { basePolicy, MemoryPort, executeWithWitnesses } from './fixtures.js';
import { device, hashB, product } from '../contracts/fixtures.js';

let root: string, project: ProjectContext, engine: WorkflowEngine, store: SqliteStore, port: MemoryPort;
const now = new Date('2026-10-20T10:00:00Z');
const target = { device, transport: device.transports[0]! };
const lockPath = () => join(project.root, 'policy.lock.json');
function application(context = project) {
  return new WorkflowEngine({
    project: context,
    store,
    port,
    clock: () => now,
    controlRoot: join(root, 'control'),
    artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
  });
}
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-workflow-approval-');
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
async function prepare() {
  const plan = await engine.prepare(target);
  const run = await engine.submit(plan.plan.id, plan.reviewSummary, 'Reviewer');
  return { plan, run };
}
async function ready() {
  const prepared = await prepare();
  await executeWithWitnesses(engine, prepared.run.id);
  for (const check of requiredAttestations(project.policy)) await engine.attest(target, check, 'Reviewer');
  return { ...prepared, pending: (await store.get<RunRecord>('runs', prepared.run.id))! };
}
async function staleLock() {
  const stale = resolvePolicy(
    { ...project.policy, name: 'Unaccepted policy' },
    project.config,
    product,
    project.resolved.engineDigest,
  );
  await writeFile(lockPath(), JSON.stringify(stale));
}

it.each(['capability', 'required-attestation'] as const)(
  'completes duress requested only through %s after normal credentials',
  async (source) => {
    const policy = basePolicy();
    if (source === 'capability') policy.capabilities = ['duress'];
    else policy.requiredAttestations.push('duress');
    await writeFile(join(project.root, project.config.policyFile), JSON.stringify(toPolicyDocument(policy)));
    project = await loadProject(project.root, product, project.codeRoot);
    await writePolicyLock(project);
    engine = application();
    const { run } = await prepare();
    expect((await executeWithWitnesses(engine, run.id)).manualGate).toBe('normal_credentials');
    await expect(engine.attest(target, 'duress', 'Reviewer')).rejects.toThrow('Normal credentials');
    await engine.attest(target, 'normal_credentials', 'Reviewer');
    expect((await engine.execute(run.id)).manualGate).toBe('duress');
    await engine.attest(target, 'duress', 'Reviewer');
    expect((await engine.execute(run.id)).pauseReason?.kind).toBe('acceptance');
  },
);

it.each(['missing', 'invalid', 'stale', 'symlink', 'corrupt-digest'] as const)(
  'refuses %s locks before observing or retaining plans',
  async (kind) => {
    if (kind === 'missing') await rm(lockPath());
    else if (kind === 'stale') await staleLock();
    else if (kind === 'symlink') {
      await rm(lockPath());
      await symlink(join(project.root, 'policy.json'), lockPath());
    } else if (kind === 'corrupt-digest')
      await writeFile(lockPath(), JSON.stringify({ ...project.resolved, digest: hashB }));
    else await writeFile(lockPath(), 'not JSON');
    expect(await policyLockStatus(project)).toBe(
      ['symlink', 'corrupt-digest'].includes(kind) ? 'invalid' : kind,
    );
    const inspect = vi.spyOn(port, 'inspect');
    await expect(engine.prepare(target)).rejects.toThrow('explicitly renew policy lock');
    expect(inspect).not.toHaveBeenCalled();
    expect(await store.entries('plans')).toEqual([]);
  },
);

it('accepts formatting changes, detects policy and executable changes, and renews only explicitly', async () => {
  await writeFile(lockPath(), `\n${JSON.stringify(project.resolved)}\n`);
  expect(await policyLockStatus(project)).toBe('current');
  await writeFile(
    join(project.root, 'policy.json'),
    JSON.stringify(toPolicyDocument({ ...project.policy, name: 'Changed' })),
  );
  project = await loadProject(project.root, product, project.codeRoot);
  expect(await policyLockStatus(project)).toBe('stale');
  await writePolicyLock(project);
  expect(await policyLockStatus(project)).toBe('current');
  await writeFile(
    join(project.codeRoot!, 'product.json'),
    JSON.stringify({ ...product, name: 'New executable resources' }),
  );
  const reloaded = await loadProject(project.root, product, project.codeRoot);
  expect(await policyLockStatus(reloaded)).toBe('stale');
});

it('rechecks approval before persisting a plan after asynchronous inspection', async () => {
  const inspect = port.inspect.bind(port);
  vi.spyOn(port, 'inspect').mockImplementation(async (...args) => {
    await rm(lockPath());
    return inspect(...args);
  });
  await expect(engine.prepare(target)).rejects.toThrow('Policy lock is missing');
  expect(await store.entries('plans')).toEqual([]);
});

it.each(['missing', 'stale'] as const)(
  'rechecks a %s lock at every reviewed boundary while preserving recovery',
  async (kind) => {
    const { plan, run } = await prepare();
    if (kind === 'missing') await rm(lockPath());
    else await staleLock();
    const calls = [
      () => engine.submit(plan.plan.id, plan.reviewSummary, 'Reviewer'),
      () => engine.execute(run.id),
      () => engine.executeFleet([run.id], 1),
      () => engine.refreshReview(run.id),
      () => engine.attest(target, 'operator_signoff', 'Reviewer'),
      () => engine.finalize(target, 'Reviewer'),
      () => engine.prepareSeedvault(target, { operation: 'backup' }),
      () =>
        engine.prepareExtension(target, [
          { kind: 'manual', capability: 'operator_signoff', instructions: 'Witness' },
        ]),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(`Policy lock is ${kind}`);
    expect((await engine.runStatus(run.id)).run?.status).toBe('queued');
    await engine.observe(target);
    await engine.cancel(run.id);
    expect(await engine.recover(target, run.id)).toMatchObject({ resolved: 0 });
    expect(port.calls).toEqual([]);
  },
);

it.each([0, 900_000, 900_001, -1, Number.NaN])(
  'reports measurement freshness consistently at age %s',
  async (age) => {
    await ready();
    const state = await engine.state(device.assetId);
    await store.set('workflow', device.assetId, {
      ...state,
      observedAt: Number.isNaN(age) ? 'invalid' : new Date(now.getTime() - age).toISOString(),
    });
    const fresh = Number.isFinite(age) && age >= 0 && age <= 900_000;
    const report = await engine.deviceStatus(target);
    expect(report.ready).toBe(fresh);
    expect(report.currentStateVerified).toBe(false);
    if (!fresh) {
      expect(report.missing).toContain('measurement-freshness');
      await expect(engine.attest(target, 'operator_signoff', 'Reviewer')).rejects.toThrow('15 minutes');
      await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('15 minutes');
    }
  },
);

it('reports an unlocked baseline without blocking retained history or offline custody', async () => {
  const { run } = await ready();
  await engine.finalize(target, 'Reviewer');
  await rm(lockPath());
  expect(await engine.deviceStatus(target)).toMatchObject({ ready: false, missing: ['policy-lock'] });
  await engine.acceptCustody(device.assetId, 'Recipient', true);
  expect((await engine.runStatus(run.id)).run).toMatchObject({ status: 'completed', nextSteps: [] });
  expect((await engine.acceptedHandoff(device.assetId)).record.outcome).toBe('completed-custody');
});

it('atomically completes the exact run, workflow, handoff and run audit on custody', async () => {
  const { run } = await ready();
  await engine.finalize(target, 'Reviewer');
  const accepted = await engine.acceptCustody(device.assetId, 'Recipient', true);
  expect(await store.get('runs', run.id)).toMatchObject({ status: 'completed' });
  expect((await engine.runStatus(run.id)).run).not.toHaveProperty('pauseReason');
  expect((await engine.deviceStatus(target)).run).toMatchObject({
    id: run.id,
    status: 'completed',
    nextSteps: [],
  });
  expect((await store.events(run.id, 0, 1000)).at(-1)?.event).toMatchObject({
    type: 'custody-completed',
    data: { status: 'completed', recordId: accepted.id },
  });
});

it('projects legacy completion from current and paginated archived evidence without rewriting history', async () => {
  const { run, pending } = await ready();
  await engine.finalize(target, 'Reviewer');
  await engine.acceptCustody(device.assetId, 'Recipient', true);
  await store.set('runs', run.id, pending);
  expect((await engine.runStatus(run.id)).run).toMatchObject({ status: 'completed', nextSteps: [] });
  expect((await engine.listRuns()).items[0]?.value.status).toBe('completed');
  expect((await engine.deviceStatus(target)).run?.status).toBe('completed');
  for (let index = 0; index < 1001; index++)
    await store.set('lifecycle-evidence', `a-${index}`, { workflow: null });
  await recordLifecycle(
    project,
    store,
    {
      assetId: device.assetId,
      type: 'maintenance',
      operator: 'Reviewer',
      note: 'New visit',
      confirmedErasure: false,
    },
    () => now,
    join(root, 'control'),
  );
  const pages = vi.spyOn(store, 'entriesPage');
  expect((await engine.listRuns()).items[0]?.value).toMatchObject({ status: 'completed', nextSteps: [] });
  expect(pages.mock.calls.filter(([collection]) => collection === 'lifecycle-evidence')).toHaveLength(2);
  expect(await store.get('runs', run.id)).toEqual(pending);
  const build = join(project.codeRoot!, 'product.json');
  await writeFile(build, JSON.stringify({ ...product, name: 'Upgraded resources' }));
  const upgraded = application(await loadProject(project.root, product, project.codeRoot));
  expect((await upgraded.runStatus(run.id)).run).toMatchObject({
    status: 'completed',
    reviewStatus: 'stale',
    nextSteps: [],
  });
});

it('rolls back custody when the matching run changes', async () => {
  const { run, pending } = await ready();
  const handoff = await engine.finalize(target, 'Reviewer');
  const transition = store.transition.bind(store);
  vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
    await store.set('runs', run.id, { ...pending, status: 'cancelled' });
    return transition(input);
  });
  await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow('evidence changed');
  expect(await store.get('handoff', device.assetId)).toEqual(handoff);
  expect((await engine.state(device.assetId)).status).toBe('shutdown-requested');
  expect((await store.get<RunRecord>('runs', run.id))?.status).toBe('cancelled');
});

it('rolls back the run, handoff, workflow and asset event when the run audit cannot persist', async () => {
  const { run, pending } = await ready();
  const handoff = await engine.finalize(target, 'Reviewer');
  const database = new DatabaseSync(join(project.root, 'state/pxv.sqlite3'));
  database.exec(
    "CREATE TRIGGER custody_run_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.type')='custody-completed' BEGIN SELECT RAISE(ABORT,'custody-run-audit-fault'); END",
  );
  const before = await store.events(`asset:${device.assetId}`, 0, 1000);
  try {
    await expect(engine.acceptCustody(device.assetId, 'Recipient', true)).rejects.toThrow(
      'custody-run-audit-fault',
    );
    expect(await store.get('runs', run.id)).toEqual(pending);
    expect(await store.get('handoff', device.assetId)).toEqual(handoff);
    expect((await engine.state(device.assetId)).status).toBe('shutdown-requested');
    expect(await store.events(`asset:${device.assetId}`, 0, 1000)).toEqual(before);
  } finally {
    database.close();
  }
});
