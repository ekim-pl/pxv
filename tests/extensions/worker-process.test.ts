import type * as TestModule1 from '../../packages/extensions/src/worker-process.js';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
import type { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from './../test-api.js';

const state = vi.hoisted(() => ({ workers: [] as TestWorker[] }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      stdout = { resume: vi.fn() };
      stderr = { resume: vi.fn() };
      terminate = vi.fn(() => Promise.resolve(0));
      constructor() {
        super();
        state.workers.push(this);
      }
    },
  };
});
// Module exports are called without a receiver.

const { invokeWorker } = await importModule<typeof TestModule1>(
  '../../packages/extensions/src/worker-process.js',
  import.meta.url,
);

interface TestWorker extends EventEmitter {
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
}
beforeEach(() => {
  state.workers.length = 0;
});
const request = { entry: 'file:///fixture.js', mode: 'command' as const, command: 'review', input: null };

test('a response is not returned until worker termination settles', async () => {
  let settle!: (code: number) => void;
  const response = invokeWorker('/fixture.js', request, 1000);
  const worker = state.workers[0]!;
  worker.terminate.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  let resolved = false;
  void response.then(() => {
    resolved = true;
  });
  worker.emit('message', { ok: true, actions: [] });
  worker.emit('exit', 0);
  await Promise.resolve();
  expect(resolved).toBe(false);
  settle(0);
  await expect(response).resolves.toEqual({ ok: true, actions: [] });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test.each(['error', 'exit'])('%s waits for settlement and rejects once', async (event) => {
  const response = invokeWorker('/fixture.js', request, 1000);
  const worker = state.workers[0]!;
  worker.emit(event, new Error('private worker details'));
  await expect(response).rejects.toThrow(
    event === 'error' ? 'Extension worker failed' : 'without planned actions',
  );
  expect(worker.terminate).toHaveBeenCalledOnce();
});

test('timeout waits for termination before reporting failure', async () => {
  const response = invokeWorker('/fixture.js', request, 1);
  await expect(response).rejects.toThrow('Extension worker timed out');
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});

test.each([new Error('termination failed'), 'unexpected failure'])(
  'a termination failure is reported as an Error',
  async (failure) => {
    const response = invokeWorker('/fixture.js', request, 1000);
    state.workers[0]!.terminate.mockRejectedValue(failure);
    state.workers[0]!.emit('message', { ok: true });
    await expect(response).rejects.toThrow(failure instanceof Error ? failure.message : 'termination failed');
  },
);
