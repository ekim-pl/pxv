import type * as InputModule from '../../packages/cli/src/private-input.js';
import { afterEach, beforeEach, expect, it, vi, importModule } from '../test-api.js';
import type { Writable } from 'node:stream';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';
globalThis.__pxvTestFile = import.meta.url;
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  once: vi.fn(),
  stdin: { isTTY: true },
  stderr: { isTTY: true, write: vi.fn() },
}));
vi.mock('node:process', () => ({ stdin: mocks.stdin, stderr: mocks.stderr }));
vi.mock('node:readline/promises', () => ({ createInterface: mocks.create }));
const { privateCollectionInput } = await importModule<typeof InputModule>(
  '../../packages/cli/src/private-input.js',
  import.meta.url,
);
const marker = 'SYNTHETIC-PRIVATE-ENTRY';
const context = (signal = new AbortController().signal) =>
  ({
    signal,
    io: { out: vi.fn(), error: vi.fn() },
  }) as unknown as ApplicationCliContext;
const normalize = (value: string) => (value === marker ? value : undefined);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.stdin.isTTY = true;
  mocks.stderr.isTTY = true;
  mocks.create.mockImplementation(() => ({ question: mocks.question, close: mocks.close, once: mocks.once }));
});
afterEach(() => vi.restoreAllMocks());

it('hides typed values, disables history and closes the terminal output', async () => {
  mocks.question.mockImplementationOnce(() => {
    const options = mocks.create.mock.calls[0]?.[0] as { output: Writable };
    options.output.write(marker);
    return Promise.resolve(marker);
  });
  expect(await privateCollectionInput(context(), 'Private ID', normalize)).toBe(marker);
  const options = mocks.create.mock.calls[0]?.[0] as {
    output: Writable;
    terminal: boolean;
    historySize: number;
  };
  expect(options.historySize).toBe(0);
  expect(options.terminal).toBe(true);
  expect(options.output.destroyed).toBe(true);
  expect(mocks.stderr.write.mock.calls.flat().join('')).not.toContain(marker);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('validates without echoing invalid input and accepts an explicit blank skip', async () => {
  const selected = context();
  mocks.question.mockResolvedValueOnce('SYNTHETIC-INVALID-PRIVATE').mockResolvedValueOnce('');
  expect(await privateCollectionInput(selected, 'Private ID', normalize)).toBeUndefined();
  expect(selected.io.error).toHaveBeenCalledExactlyOnceWith(
    'Invalid private value. Enter it again or leave empty to skip.',
  );
  expect(mocks.stderr.write.mock.calls.flat().join('')).not.toContain('SYNTHETIC-INVALID-PRIVATE');
});
it('requires both terminal streams when no private input hook is injected', async () => {
  mocks.stdin.isTTY = false;
  await expect(privateCollectionInput(context(), 'ID', normalize)).rejects.toThrow('local terminal');
  mocks.stdin.isTTY = true;
  mocks.stderr.isTTY = false;
  await expect(privateCollectionInput(context(), 'ID', normalize)).rejects.toThrow('local terminal');
  expect(mocks.create).not.toHaveBeenCalled();
});
it('cancels an active prompt on SIGINT and sanitizes its failure', async () => {
  mocks.question.mockImplementationOnce(
    (_label: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(marker)), { once: true });
        (mocks.once.mock.calls.at(-1)?.[1] as () => void)();
      }),
  );
  await expect(privateCollectionInput(context(), 'ID', normalize)).rejects.toThrow(
    'Private entry cancelled or interrupted',
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('rejects already-aborted collection without opening a terminal', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(privateCollectionInput(context(controller.signal), 'ID', normalize)).rejects.toThrow();
  expect(mocks.create).not.toHaveBeenCalled();
});
