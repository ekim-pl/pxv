import { approveProject } from './fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { toPolicyDocument, type SelectedTarget } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, type RunRecord } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { createWorkflowServices } from '../../packages/engine/src/composition.js';
import { afterEach, beforeEach, describe, expect, it, vi } from '../test-api.js';
import { device, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('fleet scheduling and project lifetime', () => {
  let root: string;
  let store: SqliteStore;
  let port: MemoryPort;
  let services: ReturnType<typeof createWorkflowServices>;
  let targets: SelectedTarget[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-fleet-'));
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    targets = Array.from({ length: 9 }, (_, index) => {
      const serial = `FLEET${index}`;
      return {
        device: {
          ...device,
          assetId: `phone-${index}`,
          canonicalSerial: serial,
          transports: [{ kind: 'usb' as const, serial }],
        },
        transport: { kind: 'usb' as const, serial },
      };
    });
    await saveInventory(created, { schemaVersion: 1, devices: targets.map((target) => target.device) });
    const project = await loadProject(created.root, product);
    await approveProject(project);
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new MemoryPort();
    port.inspect = (target, _policy, signal) => {
      signal?.throwIfAborted();
      return Promise.resolve({ ...structuredClone(port.observation), device: target.device });
    };
    services = createWorkflowServices({
      project,
      store,
      port,
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
      controlRoot: join(root, 'control'),
      clock: () => new Date('2026-10-16T09:00:00Z'),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const enqueue = async (phones: number[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const phone of phones) {
      const target = targets[phone];
      if (!target) throw new Error('Missing fixture phone');
      const prepared = await services.preparation.prepare(target, 'create-users');
      ids.push((await services.review.submit(prepared.plan.id, prepared.reviewSummary, 'Alice')).id);
    }
    return ids;
  };
  const statuses = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await store.get<RunRecord>('runs', id))?.status));

  it('holds the fleet promise and native project ownership until an active sibling finishes after ingestion throws', async () => {
    const ids = await enqueue([0, 1, 1, 2, 0]);
    const siblingEntered = deferred();
    const finishSibling = deferred();
    const ingestionFailed = deferred();
    const failure = new Error('Unexpected ingestion failure');
    let projectHeld = false;
    const ownProject = services.projects.run.bind(services.projects);
    vi.spyOn(services.projects, 'run').mockImplementation((action) =>
      ownProject(async () => {
        projectHeld = true;
        try {
          return await action();
        } finally {
          projectHeld = false;
        }
      }),
    );
    const ingest = services.journal.ingestNative.bind(services.journal);
    vi.spyOn(services.journal, 'ingestNative').mockImplementation(async (id) => {
      if (id !== ids[0]) return ingest(id);
      await siblingEntered.promise;
      ingestionFailed.resolve();
      throw failure;
    });
    const inspect = port.inspect.bind(port);
    vi.spyOn(port, 'inspect').mockImplementation(async (target, policy, signal) => {
      siblingEntered.resolve();
      await finishSibling.promise;
      signal?.throwIfAborted();
      return inspect(target, policy, signal);
    });
    let settled = false;
    const outcome = services.execution
      .executeFleet(ids, 2)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await ingestionFailed.promise;
    await setImmediate();
    let competingProjectEntered = false;
    const competitor = services.projects.run(() => {
      competingProjectEntered = true;
      return Promise.resolve();
    });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(projectHeld).toBe(true);
      expect(competingProjectEntered).toBe(false);
      expect(await statuses(ids)).toEqual(['queued', 'queued', 'queued', 'queued', 'queued']);
    } finally {
      finishSibling.resolve();
      await outcome;
      await competitor;
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure]);
    expect(competingProjectEntered).toBe(true);
    expect(await statuses(ids)).toEqual(['queued', 'completed', 'queued', 'queued', 'queued']);
  });

  it('aggregates every active unexpected throw and starts no later run in either phone group or queue', async () => {
    const ids = await enqueue([0, 1, 0, 1, 2]);
    const entered = [deferred(), deferred()];
    const release = deferred();
    const failures = [new Error('First ingestion failure'), new Error('Second ingestion failure')];
    const started: string[] = [];
    vi.spyOn(services.journal, 'ingestNative').mockImplementation(async (id) => {
      started.push(id);
      const index = ids.indexOf(id);
      entered[index]?.resolve();
      await release.promise;
      throw failures[index] ?? new Error('Unexpected run started');
    });
    const outcome = services.execution.executeFleet(ids, 2).catch((error: unknown) => error);
    await Promise.all(entered.map((gate) => gate.promise));
    release.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
    expect(started).toEqual(ids.slice(0, 2));
    expect(await statuses(ids)).toEqual(ids.map(() => 'queued'));
  });

  it('preserves input order and same-phone serialization while other phones finish out of order', async () => {
    const ids = await enqueue([0, 1, 0, 2]);
    const entered = ids.map(() => deferred());
    const release = ids.map(() => deferred());
    const completed: string[] = [];
    const activePhones = new Set<string>();
    let maximum = 0;
    const own = services.devices.run.bind(services.devices);
    vi.spyOn(services.devices, 'run').mockImplementation(async (target, id, action) => {
      expect(activePhones.has(target.device.canonicalSerial)).toBe(false);
      activePhones.add(target.device.canonicalSerial);
      maximum = Math.max(maximum, activePhones.size);
      const index = ids.indexOf(id);
      entered[index]?.resolve();
      await release[index]?.promise;
      try {
        return await own(target, id, action);
      } finally {
        activePhones.delete(target.device.canonicalSerial);
        completed.push(id);
      }
    });
    const outcome = services.execution.executeFleet(ids, 2);
    try {
      await Promise.all([entered[0]?.promise, entered[1]?.promise]);
      release[1]?.resolve();
      await entered[3]?.promise;
      expect(completed).toEqual([ids[1]]);
      release[3]?.resolve();
      release[0]?.resolve();
      await entered[2]?.promise;
      expect(completed).toContain(ids[0]);
    } finally {
      release.forEach((gate) => gate.resolve());
    }
    expect((await outcome).map((run) => run.id)).toEqual(ids);
    expect(maximum).toBe(2);
    expect(await statuses(ids)).toEqual(ids.map(() => 'completed'));
  });

  it.each([1, 2, 8])('bounds active runs to %s workers', async (jobs) => {
    const ids = await enqueue([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const filled = deferred();
    const release = deferred();
    const ingest = services.journal.ingestNative.bind(services.journal);
    let active = 0;
    let maximum = 0;
    const started = new Set<string>();
    vi.spyOn(services.journal, 'ingestNative').mockImplementation(async (id) => {
      if (started.has(id)) return ingest(id);
      started.add(id);
      active++;
      maximum = Math.max(maximum, active);
      if (active === jobs) filled.resolve();
      await release.promise;
      active--;
      return ingest(id);
    });
    const outcome = services.execution.executeFleet(ids, jobs);
    await filled.promise;
    try {
      expect(started.size).toBe(jobs);
      expect(maximum).toBe(jobs);
    } finally {
      release.resolve();
    }
    expect((await outcome).map((run) => run.id)).toEqual(ids);
    expect(maximum).toBe(jobs);
  });

  it('continues after an ordinary per-device inspection failure', async () => {
    const ids = await enqueue([0, 1, 0, 2]);
    vi.spyOn(port, 'inspect').mockImplementationOnce(() => Promise.reject(new Error('Device unavailable')));
    const outcome = await services.execution.executeFleet(ids, 1);
    expect(outcome.map((run) => run.status)).toEqual([
      'needs-inspection',
      'completed',
      'completed',
      'completed',
    ]);
    expect(outcome.map((run) => run.id)).toEqual(ids);
    expect(outcome[0]?.error).toBe('Device unavailable');
  });

  it('keeps returned failed and cancelled statuses from stopping later runs', async () => {
    const ids = await enqueue([0, 0, 1]);
    const first = await store.get<RunRecord>('runs', ids[0]!);
    await store.set('runs', ids[0]!, { ...first, status: 'failed' });
    await services.execution.cancel(ids[1]!);
    const results = await services.execution.executeFleet(ids, 1);
    expect(results.map((run) => run.status)).toEqual(['failed', 'cancelled', 'completed']);
    expect(results.map((run) => run.id)).toEqual(ids);
  });

  it('preserves external cancellation for active and subsequent runs', async () => {
    const ids = await enqueue([0, 1, 0, 2]);
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const inspect = port.inspect.bind(port);
    vi.spyOn(port, 'inspect').mockImplementation(async (target, policy, signal) => {
      entered.resolve();
      await release.promise;
      return inspect(target, policy, signal);
    });
    const outcome = services.execution.executeFleet(ids, 2, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve();
    expect((await outcome).map((run) => run.status)).toEqual(ids.map(() => 'cancelled'));
  });

  it('handles empty batches without ownership and validates worker and batch limits', async () => {
    const own = vi.spyOn(services.projects, 'run');
    expect(await services.execution.executeFleet([], 1)).toEqual([]);
    expect(own).not.toHaveBeenCalled();
    for (const jobs of [0, -1, 9, 1.5, NaN])
      await expect(services.execution.executeFleet([], jobs)).rejects.toThrow('1 to 8 workers');
    await expect(services.execution.executeFleet(['duplicate', 'duplicate'])).rejects.toThrow('unique');
    await expect(
      services.execution.executeFleet(Array.from({ length: 1001 }, (_, i) => `${i}`)),
    ).rejects.toThrow('unique');
    await expect(services.execution.executeFleet(['unknown'])).rejects.toThrow('Unknown approved run');
    expect(own).not.toHaveBeenCalled();
  });
});
