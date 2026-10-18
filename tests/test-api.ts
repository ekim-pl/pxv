import type { TestContext } from 'node:test';
import {
  after as nodeAfter,
  afterEach as nodeAfterEach,
  before as nodeBefore,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  it as nodeIt,
} from 'node:test';
import { setTimeout as realDelay } from 'node:timers/promises';
import { format } from 'node:util';
import { expect as jestExpect } from 'expect';
import type { Expect } from 'expect';
import { ModuleMocker, type Mock } from 'jest-mock';
import FakeTimers from '@sinonjs/fake-timers';
import { state, sourceURL } from '../tools/test-hooks.mjs';
declare global {
  var __pxvTestFile: string;
  var __pxvTestMocks: Map<string, Record<string, unknown>>;
}
type CompatExpect = Omit<Expect, never> &
  ((actual: unknown, message?: string) => ReturnType<Expect>) & {
    poll(
      callback: () => unknown,
      options?: { timeout?: number },
    ): { toBe(value: unknown): Promise<void>; toBeUndefined(): Promise<void> };
  };
const expect = Object.assign((value: unknown, _message?: string) => {
  void _message;
  return jestExpect(value);
}, jestExpect) as CompatExpect;
const realNow = Date.now;
function describe(name: string, callback: () => unknown): void {
  void nodeDescribe(name, async () => {
    await callback();
  });
}
const mocker = new ModuleMocker(globalThis);
expect.extend({
  toHaveBeenCalledExactlyOnceWith(received: { mock: { calls: unknown[][] } }, ...args: unknown[]) {
    return {
      pass: received.mock.calls.length === 1 && this.equals(received.mock.calls[0], args),
      message: () => 'Expected exactly one call with supplied arguments',
    };
  },
  toHaveBeenCalledOnce(received: { mock: { calls: unknown[] } }) {
    return {
      pass: received.mock.calls.length === 1,
      message: () => `Expected one call, received ${received.mock.calls.length}`,
    };
  },
});
// Keep call counts and standard Jest matcher typing shared with existing assertions.
declare module 'expect' {
  interface Matchers<R> {
    toHaveBeenCalledOnce(): R;
    toHaveBeenCalledExactlyOnceWith(...args: unknown[]): R;
  }
}
type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Row<T> = [T] extends [readonly unknown[]] ? Mutable<T> : [Mutable<T>];
type CaseFunction<T> = (name: string, callback: (...args: Row<T>) => unknown, timeout?: number) => void;
function test(name: string, callback: (context: TestContext) => unknown, timeout = 30_000): void {
  void nodeIt(name, { timeout }, async (context) => {
    await callback(context);
  });
}
function before(callback: () => unknown, timeout = 30_000): void {
  nodeBefore(
    async () => {
      await callback();
    },
    { timeout },
  );
}
function after(callback: () => unknown, timeout = 30_000): void {
  nodeAfter(
    async () => {
      await callback();
    },
    { timeout },
  );
}
function beforeEach(callback: () => unknown, timeout = 30_000): void {
  nodeBeforeEach(
    async () => {
      await callback();
    },
    { timeout },
  );
}
function afterEach(callback: () => unknown, timeout = 30_000): void {
  nodeAfterEach(
    async () => {
      await callback();
    },
    { timeout },
  );
}
const it = Object.assign(test, {
  each:
    <const T>(cases: readonly T[]): CaseFunction<T> =>
    (name, callback, timeout) => {
      cases.forEach((row, index) => {
        const args = cases.every(Array.isArray) && Array.isArray(row) ? row : [row];
        test(
          format(name.replace(/%#/gu, String(index)), ...args),
          () => Reflect.apply(callback, undefined, args),
          timeout,
        );
      });
    },
  skip: (name: string, callback: () => unknown) =>
    nodeIt.skip(name, async () => {
      await callback();
    }),
});
let clock: ReturnType<typeof FakeTimers.install> | undefined;
const env = new Map<string, string | undefined>(),
  globals = new Map<string, PropertyDescriptor | undefined>();
function mockPriority(key: string): number {
  if (key.startsWith('node:')) return 0;
  for (const [index, name] of ['runtime', 'adapters', 'extensions', 'engine'].entries())
    if (key.includes('/packages/' + name + '/')) return index + 1;
  return 10;
}
async function importModule<T = Record<string, never>>(specifier: string, parent: string): Promise<T> {
  for (const [key, factory] of [...state.mocks].sort(([a], [b]) => mockPriority(a) - mockPriority(b))) {
    const original = async <T>() => {
      state.bypass.add(key);
      try {
        return (await import(key.startsWith('file:') ? key + '?pxv-original=1' : key)) as T;
      } finally {
        state.bypass.delete(key);
      }
    };
    const value: unknown = await factory(original);
    if (!value || typeof value !== 'object') throw new Error('Module mock factory must return exports');
    state.values.set(key, value as Record<string, unknown>);
  }
  const url = sourceURL(specifier, parent);
  return import(url.startsWith('file:') ? url + '?pxv-generation=' + state.generation : url) as Promise<T>;
}
const vi = {
  // Default mocks intentionally accept arbitrary signatures, as in the former test API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: <T extends (...args: any[]) => any = (...args: any[]) => any>(implementation?: T): Mock<T> =>
    mocker.fn(implementation),
  spyOn: mocker.spyOn.bind(mocker),
  mocked: mocker.mocked.bind(mocker),
  hoisted: <T>(factory: () => T): T => factory(),
  mock: (specifier: string, factory: (original: <T = Record<string, never>>() => Promise<T>) => unknown) => {
    state.mocks.set(sourceURL(specifier, globalThis.__pxvTestFile), factory);
  },
  doMock: (
    specifier: string,
    factory: (original: <T = Record<string, never>>() => Promise<T>) => unknown,
  ) => {
    state.mocks.set(sourceURL(specifier, globalThis.__pxvTestFile), factory);
    state.generation++;
  },
  doUnmock: (specifier: string) => {
    const key = sourceURL(specifier, globalThis.__pxvTestFile);
    state.mocks.delete(key);
    state.values.delete(key);
    state.generation++;
  },
  resetModules: () => {
    state.generation++;
  },
  clearAllMocks: () => {
    mocker.clearAllMocks();
  },
  restoreAllMocks: () => {
    mocker.restoreAllMocks();
    mocker.clearAllMocks();
  },
  useFakeTimers: () => {
    clock = FakeTimers.install();
  },
  useRealTimers: () => {
    clock?.uninstall();
    clock = undefined;
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    await clock!.tickAsync(ms);
  },
  stubEnv: (key: string, value: string | undefined) => {
    if (!env.has(key)) env.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  },
  unstubAllEnvs: () => {
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    env.clear();
  },
  stubGlobal: (key: string, value: unknown) => {
    if (!globals.has(key)) globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  },
  unstubAllGlobals: () => {
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  },
  waitFor: async (callback: () => unknown, options: { timeout?: number; interval?: number } = {}) => {
    const deadline = realNow() + (options.timeout ?? 1000);
    for (;;) {
      try {
        return await callback();
      } catch (error) {
        if (realNow() >= deadline) throw error;
        if (clock) await clock.tickAsync(options.interval ?? 10);
        await realDelay(options.interval ?? 10);
      }
    }
  },
};
export {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  expect,
  it,
  it as test,
  after as afterAll,
  before as beforeAll,
  vi,
  importModule,
};

expect.poll = (callback, options = {}) => ({
  toBe: async (value) => {
    await vi.waitFor(async () => expect(await callback()).toBe(value), options);
  },
  toBeUndefined: async () => {
    await vi.waitFor(async () => expect(await callback()).toBeUndefined(), options);
  },
});
export type { Mock };
export function expectTypeOf<T>(_value: T) {
  void _value;
  return {
    returns: {
      toEqualTypeOf: <U extends ReturnType<Extract<T, (...args: never[]) => unknown>>>() => {
        const check: U | undefined = undefined;
        return check;
      },
    },
  };
}
