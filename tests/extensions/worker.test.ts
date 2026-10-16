import { describe, expect, it } from 'vitest';
import { executeExtension, extensionResponse } from '../../packages/extensions/src/worker-handler.js';
import { validateWorkerInput, validateWorkerResult } from '../../packages/extensions/src/worker-protocol.js';
const action = {
  kind: 'manual' as const,
  capability: 'operator_signoff',
  instructions: 'Review the selected device',
};
const request = {
  entry: 'file:///extension/index.js',
  mode: 'command' as const,
  command: 'prepare.v1',
  input: { enabled: true },
};
describe('extension worker boundary', () => {
  it('returns only validated actions or sanitized validation failures across IPC', async () => {
    expect(
      await extensionResponse(request, () =>
        Promise.resolve({ default: { apiVersion: 1, commands: { 'prepare.v1': () => [action] } } }),
      ),
    ).toEqual({ ok: true, actions: [action] });
    expect(
      await extensionResponse({ ...request, input: 'x'.repeat(1_048_577) }, () => Promise.resolve({})),
    ).toEqual({ ok: false, error: 'Extension input exceeds size limit' });
    expect(
      await extensionResponse(request, () => Promise.reject(new Error('Extension result private sentinel'))),
    ).toEqual({ ok: false, error: 'Extension worker failed' });
  });

  it('uses the shared v1 definition for commands, named exports and adapters', async () => {
    const definition = { apiVersion: 1, commands: { 'prepare.v1': () => [action] } };
    expect(await executeExtension(request, () => Promise.resolve({ default: definition }))).toEqual([action]);
    expect(await executeExtension(request, () => Promise.resolve({ extension: definition }))).toEqual([
      action,
    ]);
    expect(
      await executeExtension({ ...request, mode: 'adapter' }, () =>
        Promise.resolve({ default: { apiVersion: 1, plan: () => [action] } }),
      ),
    ).toEqual([action]);
  });
  it('requires command handlers to be own properties while preserving authored constructor commands', async () => {
    const constructorRequest = { ...request, command: 'constructor', input: [action] };
    await expect(
      executeExtension(constructorRequest, () =>
        Promise.resolve({ default: { apiVersion: 1, commands: {} } }),
      ),
    ).rejects.toThrow('Unknown extension command');
    expect(
      await executeExtension(constructorRequest, () =>
        Promise.resolve({ default: { apiVersion: 1, commands: { constructor: () => [action] } } }),
      ),
    ).toEqual([action]);
  });
  it.each([
    null,
    4,
    { default: null },
    { default: { apiVersion: 2, commands: {} } },
    { default: { apiVersion: 1 } },
    { default: { apiVersion: 1, commands: {} } },
  ])('rejects invalid command module before returning actions: %s', async (module) => {
    await expect(executeExtension(request, () => Promise.resolve(module))).rejects.toThrow();
  });
  it.each([null, { apiVersion: 2, plan: () => [] }, { apiVersion: 1, plan: 0 }])(
    'rejects incompatible adapters: %s',
    async (definition) => {
      await expect(
        executeExtension({ ...request, mode: 'adapter' }, () => Promise.resolve({ default: definition })),
      ).rejects.toThrow('Incompatible integration adapter');
    },
  );
  it('rejects large UTF-8 inputs before loading executable code', async () => {
    let loaded = false;
    await expect(
      executeExtension({ ...request, input: 'ą'.repeat(600_000) }, () => {
        loaded = true;
        return Promise.resolve({});
      }),
    ).rejects.toThrow('input exceeds size');
    expect(loaded).toBe(false);
  });
  it('rejects large result bytes and malformed actions before IPC', async () => {
    for (const result of [
      [{ ...action, instructions: 'ą'.repeat(600_000) }],
      new Array(10_001).fill(action),
      [{ kind: 'shell', command: 'wipe' }],
      { approved: true },
    ]) {
      await expect(
        executeExtension(request, () =>
          Promise.resolve({ default: { apiVersion: 1, commands: { 'prepare.v1': () => result } } }),
        ),
      ).rejects.toThrow();
    }
  });
  it('rejects cycles, invalid primitives, deep inputs and sparse arrays with bounded work', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    let deep: unknown = {};
    for (let i = 0; i < 66; i++) deep = { child: deep };
    const decorated: unknown[] = [];
    Object.assign(decorated, { secret: 'value' });
    for (const value of [
      { [Symbol('hidden')]: 'sentinel' },
      cycle,
      undefined,
      () => [],
      NaN,
      Infinity,
      1n,
      new Date(),
      new Array(2),
      decorated,
      deep,
    ])
      expect(() => validateWorkerInput(value)).toThrow();
  });
  it('counts JSON escaping, keys and aggregate array/object bytes', () => {
    expect(() => validateWorkerInput({ ['ą'.repeat(600_000)]: true })).toThrow('input exceeds size');
    expect(() => validateWorkerInput('\n'.repeat(600_000))).toThrow('input exceeds size');
    expect(() => validateWorkerInput(new Array(1_048_577))).toThrow('input exceeds size');
    expect(() => validateWorkerInput(new Array(300_000).fill(null))).toThrow('input exceeds size');
    expect(() => validateWorkerInput({ a: 'a'.repeat(600_000), b: 'b'.repeat(600_000) })).toThrow(
      'input exceeds size',
    );
    expect(() =>
      validateWorkerInput(
        Object.assign(Object.create(null) as object, {
          enabled: false,
          threshold: 1.5,
          absent: null,
          profiles: [1, true, 'ok'],
        }),
      ),
    ).not.toThrow();
    expect(validateWorkerResult([action])).toEqual([action]);
  });
});
