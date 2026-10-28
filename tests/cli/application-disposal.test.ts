import { expect, it, vi } from '../test-api.js';
import { usingApplicationStore } from '../../packages/cli/src/application-disposal.js';
import { startCli } from '../../packages/cli/src/entrypoint.js';

it('preserves success, primary failures, disposal failures and thrown undefined while closing once', async () => {
  const original = new Error('Original operation failed');
  const secondary = new Error('Secondary disposal failed');
  for (const failAction of [false, true])
    for (const failClose of [false, true]) {
      const close = vi.fn(() => (failClose ? Promise.reject(secondary) : Promise.resolve()));
      const result = usingApplicationStore({ close }, () =>
        failAction ? Promise.reject(original) : Promise.resolve(42),
      );
      if (failAction && failClose) {
        const error: unknown = await result.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([original, secondary]);
        expect((error as Error).cause).toBe(original);
        expect((error as Error).message).toContain(original.message);
        expect((error as Error).message).toContain(secondary.message);
      } else if (failAction || failClose)
        await expect(result).rejects.toBe(failAction ? original : secondary);
      else expect(await result).toBe(42);
      expect(close).toHaveBeenCalledOnce();
    }
  const close = vi.fn<() => Promise<void>>().mockRejectedValue('untyped disposal');
  const action = vi.fn<() => Promise<never>>().mockRejectedValue(undefined);
  await expect(usingApplicationStore({ close }, action)).rejects.toMatchObject({
    errors: [undefined, 'untyped disposal'],
    message: 'Application failed: Operation failed; storage disposal failed: Operation failed',
  });
});
it('renders both failures at the actual CLI entrypoint without serializing exception payloads', async () => {
  const original = Object.assign(new Error('Original execution lost'), { input: 'private-input-sentinel' });
  const secondary = new Error('Storage worker lost');
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const saved = process.exitCode;
  try {
    await startCli(
      () => usingApplicationStore({ close: () => Promise.reject(secondary) }, () => Promise.reject(original)),
      [],
    );
    expect(process.exitCode).toBe(2);
    const output = write.mock.calls.map(([text]) => text).join('');
    expect(output).toContain(original.message);
    expect(output).toContain(secondary.message);
    expect(output).not.toContain('private-input-sentinel');
  } finally {
    process.exitCode = saved;
    write.mockRestore();
  }
});
