import { performance } from 'node:perf_hooks';
import { expect, it, vi, beforeEach, afterEach, importModule } from '../test-api.js';
import type * as ProcessModule from '../../packages/runtime/src/supervisor-process.js';
import type { Kernel } from '../../packages/runtime/src/supervisor-native.js';
globalThis.__pxvTestFile = import.meta.url;
const state = { files: new Map<string, string>(), error: undefined as Error | undefined };
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (state.error) throw state.error;
    const value = state.files.get(path);
    if (value === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return value;
  },
  statSync: () => ({ uid: 1000 }),
}));
const p = await importModule<typeof ProcessModule>(
  '../../packages/runtime/src/supervisor-process.js',
  import.meta.url,
);
const kernel = {
  lock: vi.fn(),
  closeOnExec: vi.fn(),
  prepare: vi.fn(),
  openPid: vi.fn<(pid: number) => number | undefined>(() => 7),
  signal: vi.fn(),
  close: vi.fn(),
  reap: vi.fn(),
} satisfies Kernel;
function stat(pid: number, parent: number | string) {
  return `${pid} (child) ${['S', parent, ...Array<string>(17).fill('0'), '11'].join(' ')}`;
}
beforeEach(() => {
  state.files.clear();
  state.files.set('/proc/sys/kernel/random/boot_id', 'boot');
  state.error = undefined;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());
it('fails closed on malformed and inaccessible process identities', () => {
  state.files.set('/proc/999/stat', 'bad');
  expect(() => p.identity(999)).toThrow('start time');
  state.files.set('/proc/999/stat', stat(999, 'bad'));
  expect(() => p.ownedDescendant(999)).toThrow('Malformed');
  state.error = Object.assign(new Error('denied'), { code: 'EACCES' });
  expect(() => p.existingIdentity(999)).toThrow('denied');
  expect(() => p.ownedDescendant(999)).toThrow('denied');
});
it('rejects gone and cyclic ancestry without signaling an unrelated PID', () => {
  expect(p.ownedDescendant(999)).toBe(false);
  p.signalPid(kernel, 999, 9);
  expect(kernel.openPid).not.toHaveBeenCalled();
  state.files.set('/proc/999/stat', stat(999, 999));
  expect(() => p.ownedDescendant(999)).toThrow('ancestry');
  state.files.set('/proc/999/stat', stat(999, 1));
  p.signalPid(kernel, 999, 9);
  expect(kernel.signal).not.toHaveBeenCalled();
  expect(kernel.close).toHaveBeenCalledWith(7);
});
it('uses pidfds for verified descendants and leaves direct children to libuv', () => {
  state.files.set('/proc/999/stat', stat(999, process.pid));
  p.signalPid(kernel, 999, 9);
  expect(kernel.signal).toHaveBeenCalledWith(7, 9);
  vi.mocked(kernel.openPid).mockReturnValueOnce(undefined);
  p.signalPid(kernel, 999, 9);
  state.files.set(`/proc/${process.pid}/task/${process.pid}/children`, '999 1000');
  p.reapAdopted(kernel, new Set([999]));
  expect(kernel.reap).toHaveBeenCalledWith(1000);
  expect(kernel.reap).not.toHaveBeenCalledWith(999);
});
it('retains cleanup uncertainty on enumeration failure and bounded cleanup timeout', async () => {
  state.error = new Error('enumeration failed');
  expect(await p.terminateDescendants(kernel, new Set())).toBe(false);
  state.error = undefined;
  state.files.set(`/proc/${process.pid}/task/${process.pid}/children`, '999');
  state.files.set('/proc/999/task/999/children', '');
  state.files.set('/proc/999/stat', stat(999, process.pid));
  vi.mocked(kernel.signal).mockImplementationOnce(() => {
    throw new Error('signal failed');
  });
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(6000);
  expect(await p.terminateDescendants(kernel, new Set([999]))).toBe(false);
});
