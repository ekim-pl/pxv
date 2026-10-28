import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from '../test-api.js';
import { digest, requiredAttestations, toPolicyDocument } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, writePolicyLock, WorkflowEngine } from '@pxv/engine';
import type { RunRecord, WorkflowState } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { basePolicy, executeWithWitnesses, MemoryPort } from './fixtures.js';
import { device, hashB, product } from '../contracts/fixtures.js';

let root: string, store: SqliteStore, engine: WorkflowEngine, port: MemoryPort, now: Date;
const target = { device, transport: device.transports[0]! };
const calls: string[] = [];
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-pending-recipes-');
  const code = join(root, 'code');
  await mkdir(code);
  await writeFile(join(code, 'product.json'), JSON.stringify(product));
  const policy = basePolicy();
  policy.profiles[0]!.recipes = ['first', 'second'].map((id) => ({
    schemaVersion: 1,
    id,
    packageId: 'org.example.vpn',
    versionCode: 12,
    signerSha256: hashB,
    buildFingerprint: 'fixture/build',
    steps: [{ action: 'back' }],
    postconditions: [{ resourceId: 'org.example.vpn:id/ready' }],
  }));
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), code);
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  const project = await loadProject(created.root, product, code);
  await writePolicyLock(project);
  store = await SqliteStore.open(join(root, 'state.sqlite'));
  port = new MemoryPort();
  calls.length = 0;
  port.runRecipe = (_target, _user, recipe) => {
    calls.push(recipe.id);
    return Promise.resolve({
      status: 'manual-pending',
      capability: 'app-setup',
      recipeDigest: digest(recipe),
    });
  };
  now = new Date('2026-10-16T09:00:00Z');
  engine = new WorkflowEngine({
    project,
    store,
    port,
    clock: () => now,
    artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
    controlRoot: join(root, 'control'),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function paused() {
  const prepared = await engine.prepare(target);
  const submitted = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  const run = await executeWithWitnesses(engine, submitted.id);
  expect(run.manualGate).toBe('app_setup');
  const id = `${run.id}:recipe:${run.cursor}`;
  const proof = (await store.get<Record<string, unknown>>('capability-evidence', id))!;
  return { run, prepared, id, proof };
}
for (const field of [
  'deleted',
  'kind',
  'status',
  'runId',
  'policyDigest',
  'configurationDigest',
  'user',
  'app',
  'result',
  'previousReceiptId',
]) {
  it(`blocks a missing or altered pending ${field} without replay or repair`, async () => {
    const { run, id, proof } = await paused();
    if (field === 'deleted') await store.delete('capability-evidence', id);
    else {
      const changed = { ...proof };
      if (field === 'status') changed.status = 'measured';
      else delete changed[field];
      await store.set('capability-evidence', id, changed);
    }
    const retained = await store.get('capability-evidence', id);
    await expect(engine.refreshReview(run.id)).rejects.toThrow();
    expect(await store.entries('plans')).toHaveLength(1);
    await engine.attest(target, 'app_setup', 'Reviewer');
    expect((await engine.execute(run.id)).status).toBe('needs-inspection');
    expect(calls).toEqual(['first']);
    expect(await store.get('capability-evidence', id)).toEqual(retained);
    const stored = (await store.get<RunRecord>('runs', run.id))!;
    expect(stored.cursor).toBe(run.cursor);
    expect(stored.completedSetup?.some((value) => value.check === 'app_setup') ?? false).toBe(false);
    expect((await engine.readiness(target)).ready).toBe(false);
    await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow();
    expect(port.calls).not.toContain('finalize');
  });
}
it('requires a distinct receipt for each recipe and runs later recipes only once', async () => {
  const { run } = await paused();
  await engine.attest(target, 'app_setup', 'Reviewer');
  expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
  expect(calls).toEqual(['first', 'second']);
  expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
  expect(calls).toEqual(['first', 'second']);
  await engine.attest(target, 'app_setup', 'Reviewer');
  await executeWithWitnesses(engine, run.id);
  for (const check of requiredAttestations(engine.project.policy))
    await engine.attest(target, check, 'Reviewer');
  expect((await engine.readiness(target)).ready).toBe(true);
  expect(calls).toEqual(['first', 'second']);
});
it('refuses unexpected retained proof for an unstarted action instead of replaying or adopting it', async () => {
  const prepared = await engine.prepare(target);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  const index = prepared.plan.actions.findIndex((action) => action.kind === 'recipe');
  const id = `${run.id}:recipe:${index}`;
  const unexpected = { status: 'manual-pending', retained: true };
  await store.set('capability-evidence', id, unexpected);
  expect((await executeWithWitnesses(engine, run.id)).status).toBe('needs-inspection');
  expect(calls).toEqual([]);
  expect(await store.get('capability-evidence', id)).toEqual(unexpected);
});
it('authenticates repeated carried checkpoints, including queued refreshed runs and later recipes', async () => {
  const original = await paused();
  let run = original.run;
  for (let index = 0; index < 3; index++) {
    now = new Date(now.getTime() + 16 * 60_000);
    const prepared = await engine.refreshReview(run.id);
    expect(prepared.refreshedFrom?.pendingRecipeEvidenceId).toBe(original.id);
    run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
    expect((await engine.execute(run.id)).manualGate).toBe('app_setup');
  }
  expect(calls).toEqual(['first']);
  await engine.attest(target, 'app_setup', 'Reviewer');
  run = await engine.execute(run.id);
  expect(calls).toEqual(['first', 'second']);
  const next = await engine.refreshReview(run.id);
  expect(next.refreshedFrom?.pendingRecipeEvidenceId).toBe(`${run.id}:recipe:${run.cursor}`);
  const submitted = await engine.submit(next.plan.id, next.reviewSummary, 'Reviewer');
  await engine.execute(submitted.id);
  await engine.attest(target, 'app_setup', 'Reviewer');
  await executeWithWitnesses(engine, submitted.id);
  expect(calls).toEqual(['first', 'second']);
  expect(await store.get('capability-evidence', original.id)).toEqual(original.proof);
});
for (const source of ['run', 'cursor', 'gate', 'id', 'plan', 'proof'])
  it(`refuses changed carried ${source} evidence before queued execution`, async () => {
    const { run, id, proof } = await paused();
    const prepared = await engine.refreshReview(run.id);
    const next = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
    const ancestor = (await store.get<RunRecord>('runs', run.id))!;
    if (source === 'run') await store.set('runs', run.id, { ...ancestor, status: 'cancelled' });
    else if (source === 'cursor') await store.set('runs', run.id, { ...ancestor, cursor: run.cursor! + 1 });
    else if (source === 'gate') await store.set('runs', run.id, { ...ancestor, manualGate: 'other' });
    else if (source === 'id') await store.set('runs', run.id, { ...ancestor, id: '0'.repeat(64) });
    else if (source === 'plan') await store.delete('plans', run.planId);
    else await store.set('capability-evidence', id, { ...proof, runId: '0'.repeat(64) });
    expect((await engine.execute(next.id)).status).toBe('needs-inspection');
    expect(calls).toEqual(['first']);
  });
it('rejects conflicting pending identities and unauthenticated prior-receipt markers', async () => {
  const { run, id, proof } = await paused();
  for (const change of [
    {
      kind: 'network-probe',
      runId: '0'.repeat(64),
      policyDigest: '0'.repeat(64),
      app: { packageId: 'org.other.app', versionCode: 1, signerSha256: '0'.repeat(64) },
    },
    { previousReceiptId: 'unknown-receipt' },
    { user: { ...port.observation.profiles[0]!.user, serialNo: 999 } },
  ]) {
    await store.set('capability-evidence', id, { ...proof, ...change });
    await expect(engine.refreshReview(run.id)).rejects.toThrow();
  }
  expect(calls).toEqual(['first']);
});
for (const failure of ['transaction', 'audit', 'proof', 'run', 'plan', 'workflow'])
  it(`rolls back recipe completion on ${failure} failure without consuming its receipt`, async () => {
    const { run, id, proof, prepared } = await paused();
    await engine.attest(target, 'app_setup', 'Reviewer');
    const transition = store.transition.bind(store);
    let triggered = false;
    if (failure === 'audit') {
      const database = new DatabaseSync(join(root, 'state.sqlite'));
      database.exec(`CREATE TRIGGER fail_recipe BEFORE INSERT ON events
        WHEN json_extract(NEW.value,'$.type')='observed' AND json_extract(NEW.value,'$.data.kind')='recipe'
        BEGIN SELECT RAISE(ABORT,'recipe audit failed'); END;`);
      database.close();
    } else
      vi.spyOn(store, 'transition').mockImplementation(async (input) => {
        const completion = input.changes.some(
          (value) => value.kind === 'set' && value.collection === 'capability-evidence',
        );
        if (!triggered && completion) {
          triggered = true;
          if (failure === 'transaction') throw new Error('recipe transaction failed');
          if (failure === 'proof') await store.set('capability-evidence', id, { ...proof, changed: true });
          if (failure === 'run') await store.set('runs', run.id, { ...run, status: 'completed' });
          if (failure === 'plan') await store.set('plans', prepared.plan.id, { ...prepared, changed: true });
          if (failure === 'workflow') {
            const state = (await store.get<WorkflowState>('workflow', device.assetId))!;
            await store.set('workflow', device.assetId, { ...state, pending: ['competing-state'] });
          }
        }
        return transition(input);
      });
    await engine.execute(run.id).catch(() => undefined);
    expect(calls).toEqual(['first']);
    expect(await store.get('capability-evidence', id)).toEqual(
      failure === 'proof' ? { ...proof, changed: true } : proof,
    );
    const retained = (await store.get<RunRecord>('runs', run.id))!;
    expect(retained.cursor).toBe(run.cursor);
    expect(retained.completedSetup?.some((value) => value.check === 'app_setup') ?? false).toBe(false);
    expect(retained.status).toBe(failure === 'run' ? 'completed' : 'needs-inspection');
    const events = await store.events<{ type: string; data?: { kind?: string } }>(run.id);
    expect(events.some(({ event }) => event.type === 'observed' && event.data?.kind === 'recipe')).toBe(
      false,
    );
    if (failure === 'workflow')
      expect((await store.get<WorkflowState>('workflow', device.assetId))?.pending).toEqual([
        'competing-state',
      ]);
  });
it('keeps storage and decoding failures visible and retains the pending proof', async () => {
  const { run, id, proof } = await paused();
  const original = new Error('pending proof worker lost');
  const get = store.get.bind(store);
  const spy = vi
    .spyOn(store, 'get')
    .mockImplementation((collection, key) =>
      collection === 'capability-evidence' ? Promise.reject(original) : get(collection, key),
    );
  await expect(engine.refreshReview(run.id)).rejects.toBe(original);
  spy.mockRestore();
  const database = new DatabaseSync(join(root, 'state.sqlite'));
  database
    .prepare('UPDATE records SET value=? WHERE collection=? AND key=?')
    .run('{', 'capability-evidence', id);
  database.close();
  await expect(engine.refreshReview(run.id)).rejects.toThrow('Malformed stored JSON');
  await store.set('capability-evidence', id, proof);
});
