import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:os';
import type * as TestModule2 from 'node:path';
import type * as TestModule3 from 'node:process';
import type * as TestModule4 from '../contracts/fixtures.js';
import type * as TestModule5 from '../../packages/cli/src/arguments.js';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;

import { afterEach, beforeEach, describe, it, expect, vi } from './../test-api.js';

const prompt = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => prompt }));
// Module exports are called without a receiver.

const { mkdtemp, writeFile, rm } = await importModule<typeof TestModule0>(
  'node:fs/promises',
  import.meta.url,
);
// Module exports are called without a receiver.

const { tmpdir } = await importModule<typeof TestModule1>('node:os', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join } = await importModule<typeof TestModule2>('node:path', import.meta.url);
// Module exports are called without a receiver.

const { stdin, stdout } = await importModule<typeof TestModule3>('node:process', import.meta.url);
// Module exports are called without a receiver.

const { product } = await importModule<typeof TestModule4>('../contracts/fixtures.js', import.meta.url);
// Module exports are called without a receiver.

const { confirmation, parseCli, introductoryCommand } = await importModule<typeof TestModule5>(
  '../../packages/cli/src/arguments.js',
  import.meta.url,
);

let root: string;
let saved: PropertyDescriptor | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-arguments-'));
  await writeFile(join(root, 'product.json'), JSON.stringify(product));
  saved = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
  vi.clearAllMocks();
});
afterEach(async () => {
  if (saved) Object.defineProperty(stdin, 'isTTY', saved);
  else Reflect.deleteProperty(stdin, 'isTTY');
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
describe('CLI argument and consent boundaries', () => {
  it('requires interactive consent and always closes the terminal prompt', async () => {
    const io = { out: vi.fn(), error: vi.fn() };
    Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
    prompt.question
      .mockResolvedValueOnce(' Y ')
      .mockResolvedValueOnce('no')
      .mockRejectedValueOnce(new Error('terminal closed'));
    await confirmation(io, 'Review the device', false);
    await expect(confirmation(io, 'Review the device', false)).rejects.toThrow('Cancelled');
    await expect(confirmation(io, 'Review the device', false)).rejects.toThrow('terminal closed');
    expect(prompt.close).toHaveBeenCalledTimes(3);
    Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
    await expect(confirmation(io, 'Review', false)).rejects.toThrow('non-interactive');
  });
  it('honors package identity only when candidate metadata contains strings', async () => {
    const out = vi.fn();
    const io = { out, error: vi.fn() };
    await writeFile(join(root, 'candidate.json'), JSON.stringify({ version: 3, command: false }));
    const fallback = await parseCli(['--resource-root', root, 'version'], io);
    expect(introductoryCommand(fallback)).toBe(0);
    expect(out).toHaveBeenLastCalledWith(product.upstreamVersion);
    await writeFile(
      join(root, 'candidate.json'),
      JSON.stringify({ version: '0.1.0-preview.fixture', command: 'custom-pxv' }),
    );
    const branded = await parseCli(['--resource-root', root, 'help'], io);
    expect(introductoryCommand(branded)).toBe(0);
    expect(out).toHaveBeenLastCalledWith(expect.stringContaining('custom-pxv 0.1.0-preview.fixture'));
    expect(() => branded.value('asset')).toThrow('--asset is required');
    expect(branded.value('asset', 'fallback')).toBe('fallback');
  });
  it('uses the default output for a project-free version query', async () => {
    const write = vi.spyOn(stdout, 'write').mockImplementation(() => true);
    expect(introductoryCommand(await parseCli(['--resource-root', root, 'version']))).toBe(0);
    expect(write).toHaveBeenCalledWith('0.1.0\n');
  });
});

describe('command registry validation before project access', () => {
  it.each(['inspect', 'connections', 'backup', 'restore', 'connect', 'disconnect'])(
    'requires one exact Seedvault asset for %s before reading resources',
    async (command) => {
      for (const flag of ['--all', '--group'])
        await expect(
          parseCli([
            'seedvault',
            command,
            flag,
            ...(flag === '--group' ? ['visit'] : []),
            '--resource-root',
            '/missing-pxv-resources',
          ]),
        ).rejects.toThrow(`${flag} is not supported`);
      await expect(
        parseCli(['seedvault', command, '--resource-root', '/missing-pxv-resources']),
      ).rejects.toThrow('--asset is required');
    },
  );
  it.each(['finalize', 'attest', 'recover'])(
    'rejects unsupported dry-run on %s before resource reads',
    async (command) => {
      await expect(
        parseCli(['device', command, '--dry-run', '--resource-root', '/missing-pxv-resources']),
      ).rejects.toThrow('--dry-run is not supported');
    },
  );
  it('rejects extra positionals, wrong flags and missing required input before resource reads', async () => {
    for (const [args, message] of [
      [['policy', 'validate', 'extra'], 'Unexpected positional'],
      [['agent', 'runs', '--operator', 'ignored'], '--operator is not supported'],
      [['agent', 'execute', '--plan', 'plan'], '--review-file is required'],
    ] as const)
      await expect(parseCli([...args, '--resource-root', '/missing-pxv-resources'])).rejects.toThrow(message);
  });
  it('rejects irrelevant attestation evidence before opening resources or project state', async () => {
    await expect(
      parseCli([
        'device',
        'attest',
        '--asset',
        'phone',
        '--check',
        'normal_credentials',
        '--operator',
        'operator',
        '--evidence',
        '/private/ignored.json',
        '--resource-root',
        '/missing-pxv-resources',
      ]),
    ).rejects.toThrow('--evidence is supported only for --check emulator_image_provenance');
  });
  it('prints contextual flags without requiring mutation arguments or opening a project', async () => {
    const out = vi.fn();
    const context = await parseCli(['device', 'finalize', '--help', '--resource-root', root], {
      out,
      error: vi.fn(),
    });
    expect(introductoryCommand(context)).toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('--operator VALUE (required)'));
    expect(out).not.toHaveBeenCalledWith(expect.stringContaining('--dry-run'));
  });
});
