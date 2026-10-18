import type * as TestModule0 from '../../packages/cli/src/registry-password.js';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
import { afterEach, beforeEach, expect, it, vi } from './../test-api.js';
import type { Writable } from 'node:stream';
import type { ProjectCliContext } from '../../packages/cli/src/arguments.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  once: vi.fn(),
  stdin: { isTTY: true },
  stderr: { isTTY: true, write: vi.fn() },
}));
vi.mock('@pxv/runtime', () => ({ readRegistryPrivateFile: mocks.read }));
vi.mock('node:process', () => ({ stdin: mocks.stdin, stderr: mocks.stderr }));
vi.mock('node:readline/promises', () => ({ createInterface: mocks.create }));
// Module exports are called without a receiver.

const { registryPassword } = await importModule<typeof TestModule0>(
  '../../packages/cli/src/registry-password.js',
  import.meta.url,
);

interface PromptOptions {
  output: Writable;
  terminal: boolean;
  historySize: number;
}
function context(values: Record<string, unknown> = {}): ProjectCliContext {
  return { values, value: (name: string) => values[name] } as unknown as ProjectCliContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stdin.isTTY = true;
  mocks.stderr.isTTY = true;
  mocks.create.mockImplementation(() => ({ question: mocks.question, close: mocks.close, once: mocks.once }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  ['unchanged private key', 'unchanged private key'],
  ['private key with LF\n', 'private key with LF'],
  ['private key with CRLF\r\n', 'private key with CRLF'],
  ['private key\n\n', 'private key\n'],
])('reads a private passphrase file and removes only one terminal newline: %j', async (input, expected) => {
  const source = Buffer.from(input);
  mocks.read.mockResolvedValueOnce(source);
  const password = await registryPassword(context({ 'passphrase-file': '/private/passphrase' }));
  expect(password.toString()).toBe(expected);
  expect(source.every((byte) => byte === 0)).toBe(true);
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith('/private/passphrase', 1026);
  expect(mocks.create).not.toHaveBeenCalled();
  password.fill(0);
});

it('chooses the replacement file without prompting or confirming again and propagates private reader errors', async () => {
  mocks.stdin.isTTY = false;
  mocks.read.mockResolvedValueOnce(Buffer.from('replacement private passphrase'));
  const selected = context({ 'passphrase-file': '/private/old', 'new-passphrase-file': '/private/new' });
  const password = await registryPassword(selected, true, true);
  expect(password.toString()).toBe('replacement private passphrase');
  expect(mocks.read).toHaveBeenCalledWith('/private/new', 1026);
  expect(mocks.create).not.toHaveBeenCalled();
  password.fill(0);
  mocks.read.mockRejectedValueOnce(new Error('Private registry file is unavailable or unsafe'));
  await expect(registryPassword(selected)).rejects.toThrow('Private registry file is unavailable or unsafe');
});

it('requires both a local input terminal and an output terminal when no private file is selected', async () => {
  for (const [input, output] of [
    [false, true],
    [true, false],
  ]) {
    mocks.stdin.isTTY = input!;
    mocks.stderr.isTTY = output!;
    await expect(registryPassword(context())).rejects.toThrow('local terminal or --passphrase-file');
  }
  expect(mocks.create).not.toHaveBeenCalled();
});

it('uses a muted terminal without readline history and destroys its output after returning the key', async () => {
  const secret = 'synthetic prompt passphrase';
  mocks.question.mockImplementationOnce(() => {
    const options = mocks.create.mock.calls[0]?.[0] as PromptOptions;
    options.output.write(secret);
    return Promise.resolve(secret);
  });
  const password = await registryPassword(context());
  expect(password.toString()).toBe(secret);
  const options = mocks.create.mock.calls[0]?.[0] as PromptOptions;
  expect(options.terminal).toBe(true);
  expect(options.historySize).toBe(0);
  expect(options.output.destroyed).toBe(true);
  expect(mocks.stderr.write.mock.calls.flat().join('')).toBe('Registry passphrase: \n');
  const questionOptions = mocks.question.mock.calls[0]?.[1] as { signal: AbortSignal };
  expect(mocks.question.mock.calls[0]?.[0]).toBe('');
  expect(questionOptions.signal).toBeInstanceOf(AbortSignal);
  expect(questionOptions.signal.aborted).toBe(false);
  expect(mocks.close).toHaveBeenCalledOnce();
  password.fill(0);
});

function captureSecretBuffers(secrets: string[]): Buffer[] {
  const original = Buffer.from.bind(Buffer);
  const captured: Buffer[] = [];
  vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]): Buffer => {
    const value = Reflect.apply(original, Buffer, args) as Buffer;
    if (typeof args[0] === 'string' && secrets.includes(args[0])) captured.push(value);
    return value;
  }) as typeof Buffer.from);
  return captured;
}

it('confirms a new terminal passphrase, wipes the repetition and keeps the returned key caller-owned', async () => {
  const secret = 'synthetic new confirmed passphrase';
  const captured = captureSecretBuffers([secret]);
  mocks.question.mockResolvedValueOnce(secret).mockResolvedValueOnce(secret);
  const password = await registryPassword(context(), true, true);
  expect(captured).toHaveLength(2);
  expect(password).toBe(captured[0]);
  expect(password.toString()).toBe(secret);
  expect(captured[1]?.every((byte) => byte === 0)).toBe(true);
  expect(mocks.stderr.write.mock.calls.flat().join('')).toBe(
    'New registry passphrase: \nRepeat new registry passphrase: \n',
  );
  expect(mocks.close).toHaveBeenCalledTimes(2);
  password.fill(0);
});

it('wipes both entered keys on a confirmation mismatch and closes both prompts', async () => {
  const first = 'synthetic first passphrase';
  const second = 'synthetic mismatched passphrase';
  const captured = captureSecretBuffers([first, second]);
  mocks.question.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await expect(registryPassword(context(), true, true)).rejects.toThrow('Registry passphrases do not match');
  expect(captured).toHaveLength(2);
  expect(captured.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('wipes the first key when the repeat prompt fails and exposes only a constant cancellation message', async () => {
  const secret = 'synthetic aborted confirmation';
  const captured = captureSecretBuffers([secret]);
  mocks.question.mockResolvedValueOnce(secret).mockRejectedValueOnce(new Error(secret));
  await expect(registryPassword(context(), true, true)).rejects.toThrow('Registry unlock cancelled');
  expect(captured).toHaveLength(1);
  expect(captured[0]?.every((byte) => byte === 0)).toBe(true);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('aborts a hidden prompt on SIGINT and still closes its muted output', async () => {
  mocks.question.mockImplementationOnce(
    (_label: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Synthetic terminal interruption')), {
          once: true,
        });
        const interrupt = mocks.once.mock.calls.at(-1)?.[1] as () => void;
        interrupt();
      }),
  );
  await expect(registryPassword(context())).rejects.toThrow('Registry unlock cancelled');
  expect(mocks.once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  expect(mocks.close).toHaveBeenCalledOnce();
  const options = mocks.create.mock.calls[0]?.[0] as PromptOptions;
  expect(options.output.destroyed).toBe(true);
});
