import { describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CliIo } from '@pxv/cli';
import { parseCli } from '../../packages/cli/src/arguments.js';
import { guidesRebuildCommand } from '../../packages/cli/src/guide-rebuild-command.js';

const output: string[] = [];
const io: CliIo = { out: (value) => output.push(value), error: (value) => output.push(value) };

describe('guides rebuild command', () => {
  it('leaves other sections alone and rejects unknown guide commands', async () => {
    expect(await guidesRebuildCommand(await parseCli(['version'], io))).toBeUndefined();
    await expect(parseCli(['guides', 'unknown'], io)).rejects.toThrow('Choose guides rebuild');
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
        '--policy',
        'policy-packs/simple/policy.v2.json',
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
        command: process.execPath,
        args: [
          `${process.cwd()}/tools/optional/publishing/rebuild.mjs`,
          '--output-dir',
          '/tmp/guide-output',
          '--policy',
          `${process.cwd()}/policy-packs/simple/policy.v2.json`,
          '--chromium',
          '/usr/bin/chromium',
          '--html-only',
          '--no-render',
        ],
        cwd: process.cwd(),
      },
    ]);
  });

  it('resolves policy and output paths against the caller directory before changing to checkout root', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const caller = resolve('packages/cli');
    const context = await parseCli(
      [
        'guides',
        'rebuild',
        '--policy',
        '../../policy-packs/simple/policy.v2.json',
        '--output-dir',
        '../../output/profile',
      ],
      io,
    );
    await guidesRebuildCommand(context, {
      currentDirectory: caller,
      execute: (_command, args, cwd) => {
        calls.push({ args, cwd });
        return Promise.resolve();
      },
    });
    expect(calls[1]).toEqual({
      args: [
        resolve('tools/optional/publishing/rebuild.mjs'),
        '--output-dir',
        resolve('output/profile'),
        '--policy',
        resolve('policy-packs/simple/policy.v2.json'),
      ],
      cwd: process.cwd(),
    });
  });

  it('rejects policy builds without a separate explicit output before launching tools', async () => {
    let calls = 0;
    const execute = () => {
      calls++;
      return Promise.resolve();
    };
    for (const args of [
      ['--policy', 'policy-packs/simple/policy.v2.json'],
      ['--policy', 'policy-packs/simple/policy.v2.json', '--output-dir', 'guides'],
      ['--policy', 'policy-packs/simple/policy.v2.json', '--output-dir', 'guides/private'],
    ]) {
      const context = await parseCli(['guides', 'rebuild', ...args], io);
      await expect(guidesRebuildCommand(context, { execute })).rejects.toThrow(/Policy booklets require/u);
    }
    expect(calls).toBe(0);
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
    expect(calls).toEqual(['pnpm', 'corepack', process.execPath]);
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
      const configuration = JSON.parse(await readFile('guides/source/build-manifest.json', 'utf8')) as {
        editions: string[];
      };
      for (const edition of configuration.editions) await access(join(outputRoot, `${edition}.html`));
      const manifest = JSON.parse(await readFile(join(outputRoot, 'qa/manifest.json'), 'utf8')) as {
        outputCount: number;
        editions: { name: string; paperSize: string }[];
      };
      expect(manifest.outputCount).toBe(configuration.editions.length);
      for (const edition of manifest.editions)
        expect(edition.paperSize).toBe(/^(?:quickstart|credentials)-/u.test(edition.name) ? 'A5' : 'A4');
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('builds policy-specific A5 Markdown and records generated source provenance without publishing the policy', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'pxv-guide-policy-'));
    const templateFile = 'guides/source/markdown/quickstart-en.md';
    const template = await readFile(templateFile);
    const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
    try {
      const context = await parseCli(
        [
          'guides',
          'rebuild',
          '--policy',
          '../../policy-packs/simple/policy.v2.json',
          '--html-only',
          '--output-dir',
          outputRoot,
        ],
        io,
      );
      expect(await guidesRebuildCommand(context, { currentDirectory: resolve('packages/cli') })).toBe(0);
      const generated = await readFile(join(outputRoot, 'source/markdown/quickstart-en.md'));
      expect(generated).not.toEqual(template);
      expect(await readFile(templateFile)).toEqual(template);
      const manifestText = await readFile(join(outputRoot, 'qa/manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestText) as {
        installation: { policyId: string; policyVersion: string; profileCount: number };
        editions: { name: string; sourceSha256: string; templateSha256: string }[];
      };
      const policy = JSON.parse(await readFile('policy-packs/simple/policy.v2.json', 'utf8')) as {
        id: string;
        version: string;
        profiles: unknown[];
      };
      expect(manifest.installation).toEqual({
        policyId: policy.id,
        policyVersion: policy.version,
        profileCount: policy.profiles.length,
      });
      const record = manifest.editions.find(({ name }) => name === 'quickstart-en');
      expect(record?.sourceSha256).toBe(digest(generated));
      expect(record?.templateSha256).toBe(digest(template));
      expect(record?.sourceSha256).not.toBe(record?.templateSha256);
      expect(manifestText).not.toContain('policyFile');
      expect(manifestText).not.toContain('policy.v2.json');
      await expect(access(join(outputRoot, 'policy.json'))).rejects.toThrow();
      await expect(access(join(outputRoot, 'policy.v2.json'))).rejects.toThrow();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
