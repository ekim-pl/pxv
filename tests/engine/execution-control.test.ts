import { afterEach, describe, expect, it, vi } from './../test-api.js';
import type { Store } from '@pxv/runtime';
import { ExecutionControl } from '../../packages/engine/src/execution-control.js';
const backing = (get: Store['get']): Store => ({ get }) as Store;
afterEach(() => vi.useRealTimers());
describe('execution cancellation lifetime', () => {
  it('observes persisted cancellation, already-aborted signals and removes listeners on dispose', async () => {
    const source = new AbortController();
    source.abort();
    const early = new ExecutionControl(backing(vi.fn().mockResolvedValue(undefined)), 'run', source.signal);
    await expect(early.check()).rejects.toThrow('cancelled');
    early.dispose();
    const external = new AbortController();
    const normal = new ExecutionControl(
      backing(vi.fn().mockResolvedValue(undefined)),
      'run',
      external.signal,
    );
    await normal.check();
    normal.dispose();
    external.abort();
    expect(normal.signal.aborted).toBe(false);
    const persisted = new ExecutionControl(backing(vi.fn().mockResolvedValue({ requested: true })), 'run');
    await expect(persisted.check()).rejects.toThrow('cancelled');
    persisted.dispose();
  });
  it('prevents overlapping polls, treats storage failure as cancellation and stops polling after dispose', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const get = vi.fn(
      (): Promise<undefined> =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const control = new ExecutionControl(backing(get), 'run');
    await vi.advanceTimersByTimeAsync(250);
    expect(get).toHaveBeenCalledTimes(1);
    reject(new Error('database unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(control.signal.aborted).toBe(true);
    control.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('aborts an active check when the caller cancels', async () => {
    const source = new AbortController();
    const control = new ExecutionControl(backing(vi.fn().mockResolvedValue(undefined)), 'run', source.signal);
    source.abort();
    await expect(control.check()).rejects.toThrow('cancelled');
    control.dispose();
  });
});
