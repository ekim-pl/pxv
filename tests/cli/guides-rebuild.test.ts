import { describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '@pxv/cli';
import { parseCli } from '../../packages/cli/src/arguments.js';
import { guidesRebuildCommand } from '../../packages/cli/src/guide-rebuild-command.js';

const output: string[] = [];
const io: CliIo = { out: (value) => output.push(value), error: (value) => output.push(value) };

describe('guides rebuild command', () => {
  it('leaves other sections alone and rejects unknown guide commands', async () => {
    expect(await guidesRebuildCommand(await parseCli(['version'], io))).toBeUndefined();
    await expect(guidesRebuildCommand(await parseCli(['guides', 'unknown'], io))).rejects.toThrow(
      'Choose guides rebuild',
    );
  });

  it('requires the renderer source checkout before launching tools', async () => {
    const context = await parseCli(['guides', 'rebuild'], io);
    await expect(
      guidesRebuildCommand(context, { currentDirectory: '/tmp/pxv-guides-no-checkout' }),
    ).rejects.toThrow('requires a pxv source checkout');
  });

  it('builds first and forwards all requested renderer options', async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const context = await parseCli(
      [
        'guides',
        'rebuild',
        '--output-dir',
        '/tmp/guide-output',
        '--chromium',
        '/usr/bin/chromium',
        '--html-only',
        '--no-render',
      ],
      io,
    );
    const result = await guidesRebuildCommand(context, {
      execute: (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return Promise.resolve();
      },
    });
    expect(result).toBe(0);
    expect(calls).toEqual([
      { command: 'pnpm', args: ['build'], cwd: process.cwd() },
      {
        command: `${process.cwd()}/guides/rebuild.sh`,
        args: [
          '--output-dir',
          '/tmp/guide-output',
          '--chromium',
          '/usr/bin/chromium',
          '--html-only',
          '--no-render',
        ],
        cwd: process.cwd(),
      },
    ]);
  });

  it('uses corepack only when the pnpm executable is missing', async () => {
    const calls: string[] = [];
    const context = await parseCli(['guides', 'rebuild', '--html-only'], io);
    const result = await guidesRebuildCommand(context, {
      execute: (command) => {
        calls.push(command);
        if (command === 'pnpm')
          return Promise.reject(Object.assign(new Error('missing pnpm'), { code: 'ENOENT' }));
        return Promise.resolve();
      },
    });
    expect(result).toBe(0);
    expect(calls).toEqual(['pnpm', 'corepack', `${process.cwd()}/guides/rebuild.sh`]);
  });

  it('stops on a failed build instead of running the renderer', async () => {
    const calls: string[] = [];
    const context = await parseCli(['guides', 'rebuild', '--html-only'], io);
    await expect(
      guidesRebuildCommand(context, {
        execute: (command) => {
          calls.push(command);
          return Promise.reject(new Error('build failed'));
        },
      }),
    ).rejects.toThrow('build failed');
    expect(calls).toEqual(['pnpm']);
  });

  it('runs the source-checkout HTML pipeline without project initialization', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'pxv-guide-html-'));
    try {
      const context = await parseCli(['guides', 'rebuild', '--html-only', '--output-dir', outputRoot], io);
      expect(await guidesRebuildCommand(context)).toBe(0);
      await access(join(outputRoot, 'b2b-en.html'));
      await access(join(outputRoot, 'b2b-pl.html'));
      expect(await readFile(join(outputRoot, 'qa/manifest.json'), 'utf8')).toContain('"outputCount": 8');
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
