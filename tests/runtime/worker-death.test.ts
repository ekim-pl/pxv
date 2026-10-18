import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:path';
import type * as TestModule2 from 'node:sqlite';
import type * as TestModule3 from '@pxv/runtime';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;

import type { Worker as WorkerType } from 'node:worker_threads';
import type * as WorkerApi from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from './../test-api.js';

const workers = vi.hoisted(() => [] as WorkerType[]);
const startup = vi.hoisted(() => ({ source: undefined as string | undefined }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerApi>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(startup.source ?? args[0], startup.source ? { ...args[1], eval: true, env: {} } : args[1]);
        workers.push(this);
      }
    },
  };
});
// Module exports are called without a receiver.

const { mkdtemp } = await importModule<typeof TestModule0>('node:fs/promises', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join } = await importModule<typeof TestModule1>('node:path', import.meta.url);
// Module exports are called without a receiver.

const { DatabaseSync } = await importModule<typeof TestModule2>('node:sqlite', import.meta.url);
// Module exports are called without a receiver.

const { SqliteStore } = await importModule<typeof TestModule3>('@pxv/runtime', import.meta.url);

afterEach(() => {
  startup.source = undefined;
  vi.useRealTimers();
});

describe('storage worker crash boundaries', () => {
  it.each([
    ['process.exit(0)', 'before ready (0)'],
    ['process.exit(2)', 'before ready (2)'],
    ['throw new Error("worker-bootstrap-fault")', 'worker-bootstrap-fault'],
    [
      'require("node:worker_threads").parentPort.postMessage({}); setInterval(()=>{},1000)',
      'failed to initialize',
    ],
  ])('rejects startup termination or malformed replies: %s', async (source, message) => {
    startup.source = source;
    const path = join(await mkdtemp('/tmp/pxv-worker-startup-'), 'db');
    await expect(SqliteStore.open(path)).rejects.toThrow(message);
  });
  it('bounds storage readiness and terminates a worker that never reports initialization', async () => {
    startup.source = 'setInterval(()=>{},1000)';
    const path = join(await mkdtemp('/tmp/pxv-worker-startup-'), 'db');
    vi.useFakeTimers();
    const count = workers.length;
    const outcome = expect(SqliteStore.open(path)).rejects.toThrow('readiness timed out');
    await vi.waitFor(() => expect(workers.length).toBe(count + 1));
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });
  it('rejects an in-flight request on worker death and reopens committed WAL state without replay', async () => {
    const path = join(await mkdtemp('/tmp/pxv-worker-death-'), 'db');
    const store = await SqliteStore.open(path);
    await store.set('runs', 'reviewed', { status: 'queued' });
    const db = new DatabaseSync(path);
    db.exec('BEGIN IMMEDIATE');
    const pending = store.set('runs', 'uncommitted', { status: 'running' });
    const outcome = expect(pending).rejects.toThrow('Storage worker closed');
    const worker = workers.at(-1);
    if (!worker) throw new Error('Real storage worker was not captured');
    await worker.terminate();
    await outcome;
    db.exec('ROLLBACK');
    db.close();
    await expect(store.get('runs', 'reviewed')).rejects.toThrow('closed');
    await store.close();
    const reopened = await SqliteStore.open(path);
    try {
      expect(await reopened.get('runs', 'reviewed')).toEqual({ status: 'queued' });
      expect(await reopened.get('runs', 'uncommitted')).toBeUndefined();
      expect(await reopened.events('reviewed')).toEqual([]);
    } finally {
      await reopened.close();
    }
  });
});

type DatabaseSync = InstanceType<typeof DatabaseSync>;

type SqliteStore = typeof SqliteStore.prototype;
