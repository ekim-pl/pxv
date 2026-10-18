import { expect, it, vi, beforeEach, importModule } from '../test-api.js';
import type * as Native from '../../packages/runtime/src/supervisor-native.js';
globalThis.__pxvTestFile = import.meta.url;
const state = { errno: 1, failLoad: false, enabled: 1, results: {} as Record<string, number> };
const ffi = {
  version: '3.3.3',
  errno: () => state.errno,
  load: () => ({
    func:
      (declaration: string) =>
      (...args: unknown[]) => {
        const name = declaration === 'prctl' ? 'get' : declaration.split('(')[0]!.split(' ').at(-1)!;
        if (name === 'get') (args[1] as number[])[0] = state.enabled;
        return state.results[name] ?? (name === 'syscall' ? 11 : 0);
      },
  }),
};
vi.mock('node:module', () => ({
  createRequire: () =>
    Object.assign(
      (name: string) => {
        if (state.failLoad) throw new Error('missing prebuild');
        return name === 'koffi' ? ffi : {};
      },
      { resolve: () => '/prebuild/index.js' },
    ),
}));
const { loadKernel } = await importModule<typeof Native>(
  '../../packages/runtime/src/supervisor-native.js',
  import.meta.url,
);
beforeEach(() => {
  ffi.version = '3.3.3';
  state.errno = 1;
  state.failLoad = false;
  state.enabled = 1;
  state.results = {};
});
it('fails with actionable prebuilt-only instructions', () => {
  state.failLoad = true;
  expect(() => loadKernel()).toThrow('native compilation is disabled');
});
it('validates platform before loading any addon', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'arch', { ...descriptor, value: 'arm64' });
  try {
    expect(() => loadKernel()).toThrow('Linux x64');
  } finally {
    Object.defineProperty(process, 'arch', descriptor);
  }
});
it('checks descriptor, lock, subreaper and pidfd operations independently', () => {
  const kernel = loadKernel();
  kernel.prepare();
  kernel.lock(7);
  kernel.closeOnExec(7);
  kernel.reap(123);
  for (const [name, invoke] of [
    ['flock', () => kernel.lock(7)],
    ['fcntl', () => kernel.closeOnExec(7)],
    ['prctl', () => kernel.prepare()],
    ['get', () => kernel.prepare()],
    ['close', () => kernel.close(7)],
    ['waitpid', () => kernel.reap(123)],
  ] as const) {
    state.results[name] = -1;
    expect(invoke).toThrow('errno');
    delete state.results[name];
  }
  state.enabled = 0;
  expect(() => kernel.prepare()).toThrow('could not be verified');
});
it('distinguishes gone processes from unavailable pidfd or reaping capabilities', () => {
  const kernel = loadKernel();
  state.results['syscall'] = -1;
  expect(() => kernel.openPid(123)).toThrow('pidfd_open');
  expect(() => kernel.signal(7, 9)).toThrow('pidfd_send_signal');
  state.errno = 3;
  expect(kernel.openPid(123)).toBeUndefined();
  kernel.signal(7, 9);
  expect(() => kernel.prepare()).toThrow('pidfds unavailable');
  state.results['waitpid'] = -1;
  state.errno = 10;
  kernel.reap(123);
});

it('rejects an incompatible addon version rather than using a build fallback', () => {
  ffi.version = '3.3.4';
  expect(() => loadKernel()).toThrow('prebuild unavailable or incompatible');
});
