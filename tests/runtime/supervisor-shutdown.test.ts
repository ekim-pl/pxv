import { afterEach, beforeEach, expect, it, vi, importModule } from '../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
const state = {
  frames: [] as Record<string, unknown>[],
  failure: undefined as Error | undefined,
  destroyed: false,
};
const finish = vi.fn(() => false),
  sent = vi.fn();
vi.mock('../../packages/runtime/src/supervisor-native.js', () => ({
  loadKernel: () => ({ prepare: () => undefined, closeOnExec: () => undefined }),
}));
vi.mock('../../packages/runtime/src/supervisor-process.js', () => ({
  terminateDescendants: () => Promise.resolve(false),
}));
vi.mock('../../packages/runtime/src/supervisor-storage.js', () => ({
  Lease: class {
    supervisor = {};
    uncertain = false;
    finish = finish;
  },
}));
vi.mock('../../packages/runtime/src/supervisor-command.js', () => ({
  runCommand: () => Promise.reject(state.failure ?? new Error('command failure')),
}));
vi.mock('../../packages/runtime/src/supervisor-protocol.js', () => ({
  Channel: class {
    socket = { destroyed: state.destroyed, end: (done: () => void) => done(), destroy: () => undefined };
    receive() {
      return Promise.resolve(state.frames.shift());
    }
    send(message: unknown) {
      sent(message);
      return Promise.resolve();
    }
  },
}));
const originalArgv = process.argv,
  originalExit = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.failure = undefined;
  state.destroyed = false;
  state.frames = [
    { type: 'acquire', device_key: 'a'.repeat(64), transport_key: 'b'.repeat(64), operation_id: 'unclean' },
    { type: 'finish', success: false },
  ];
  process.argv = [process.execPath, '/supervisor.js', '--control-root', '/unused'];
});
afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = originalExit;
});
it('flushes a failed completion and exits even when child handles could remain active', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await importModule('../../packages/runtime/src/supervisor.js', import.meta.url);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(finish).toHaveBeenCalledWith(false, false);
  expect(sent).toHaveBeenCalledWith({ type: 'finished', success: false, cleanup_proven: false });
});
it('retains uncertain reservations, flushes the error and exits on failed cleanup', async () => {
  state.frames[1] = { type: 'run' };
  state.failure = new Error('uncertain command');
  state.destroyed = true;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await importModule('../../packages/runtime/src/supervisor.js', import.meta.url);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(125));
  expect(finish).toHaveBeenCalledWith(false, false);
  expect(sent).toHaveBeenCalledWith({ type: 'error', message: 'uncertain command' });
});
