import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageRequest } from '../../packages/runtime/src/storage-handler.js';
const fixture = vi.hoisted(() => ({
  parent: true,
  openError: undefined as Error | undefined,
  requestError: undefined as Error | undefined,
  listener: undefined as undefined | ((request: StorageRequest) => void),
  postMessage: vi.fn(),
  close: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  parentPort: fixture.parent
    ? {
        postMessage: fixture.postMessage,
        close: fixture.close,
        on: (_event: string, listener: (request: StorageRequest) => void) => {
          fixture.listener = listener;
        },
      }
    : null,
  workerData: { path: '/unused', readOnly: true },
}));
vi.mock('../../packages/runtime/src/storage-handler.ts', () => ({
  openDatabase: () => {
    if (fixture.openError !== undefined) {
      throw fixture.openError;
    }
    return {};
  },
  StorageHandler: class {
    dispatch(method: string, args: unknown[]) {
      if (fixture.requestError !== undefined) {
        throw fixture.requestError;
      }
      return { method, args };
    }
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.parent = true;
  fixture.openError = undefined;
  fixture.requestError = undefined;
  fixture.listener = undefined;
});
describe('storage worker protocol failure reporting', () => {
  it('reports ready, correlates replies, closes only after close response and retains structured errors', async () => {
    await import('../../packages/runtime/src/worker.js');
    expect(fixture.postMessage).toHaveBeenCalledWith({ ready: true });
    const listener = fixture.listener;
    if (!listener) throw new Error('Storage worker did not subscribe');
    listener({ id: 7, method: 'get', args: ['c', 'k'] });
    expect(fixture.postMessage).toHaveBeenLastCalledWith({
      id: 7,
      result: { method: 'get', args: ['c', 'k'] },
    });
    expect(fixture.close).not.toHaveBeenCalled();
    for (const failure of [
      new Error('database-failed'),
      runInNewContext('new Error("foreign-protocol-fault")') as Error,
    ]) {
      fixture.requestError = failure;
      listener({ id: 8, method: 'transition', args: [] });
      expect(fixture.postMessage).toHaveBeenLastCalledWith({
        id: 8,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
    fixture.requestError = undefined;
    listener({ id: 9, method: 'close', args: [] });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it.each([
    new Error('initialization-failed'),
    runInNewContext('new Error("foreign-startup-fault")') as Error,
  ])('reports initialization failure without accepting requests %#', async (error) => {
    fixture.openError = error;
    await import('../../packages/runtime/src/worker.js');
    expect(fixture.postMessage).toHaveBeenCalledWith({
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.listener).toBeUndefined();
  });
  it('refuses to run outside a dedicated worker', async () => {
    vi.doMock('node:worker_threads', () => ({ parentPort: null, workerData: {} }));
    await expect(import('../../packages/runtime/src/worker.js')).rejects.toThrow('requires a parent');
  });
});
