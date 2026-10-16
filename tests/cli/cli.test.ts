import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliIo } from '@pxv/cli';
import { product, policy } from '../contracts/fixtures.js';

let root: string;
let resources: string;
let project: string;
let output: string[];
let io: CliIo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-cli-'));
  resources = join(root, 'resources');
  project = join(root, 'project');
  output = [];
  await mkdir(join(resources, 'policy-packs/reference-five'), { recursive: true });
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  await writeFile(join(resources, product.defaultPolicy), JSON.stringify(policy));
  io = { out: (value) => output.push(value), error: (value) => output.push(value) };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const args = (values: string[]) => [...values, '--resource-root', resources, '--project-root', project];

describe('public CLI and project isolation', () => {
  it('prints help and version without any project or device access', async () => {
    expect(await runCli(['--help'], io)).toBe(0);
    expect(output[0]).toContain('fleet provision');
    expect(await runCli(['version'], io)).toBe(0);
    expect(output[1]).toBe('0.1.0');
    expect(await readdir(root)).toEqual(['resources']);
  });
  it('rejects unknown flags and requires explicit values', async () => {
    await expect(runCli(['--unrecognized'], io)).rejects.toThrow();
    await expect(runCli(args(['project', 'init']), io)).rejects.toThrow('--path');
  });
  it('initializes a new isolated project and refuses an overwrite', async () => {
    expect(await runCli(args(['project', 'init', '--path', project]), io)).toBe(0);
    expect(JSON.parse(await readFile(join(project, 'pxv.project.json'), 'utf8'))).toMatchObject({
      format: 'pxv-ts',
      productId: 'pxv',
    });
    await expect(runCli(args(['project', 'init', '--path', project]), io)).rejects.toThrow('existing');
    expect(await runCli(args(['policy', 'validate']), io)).toBe(0);
    expect(await runCli(args(['policy', 'lock', '--yes']), io)).toBe(0);
    expect(await runCli(args(['inventory', 'list']), io)).toBe(0);
  });
  it('takes an explicit policy and rejects malformed project boundaries', async () => {
    const custom = join(root, 'custom.yaml');
    await writeFile(custom, JSON.stringify({ ...policy, id: 'custom' }));
    await runCli(args(['project', 'init', '--path', project, '--policy', custom]), io);
    expect(JSON.parse(await readFile(join(project, 'policy.yaml'), 'utf8'))).toMatchObject({ id: 'custom' });
    await expect(runCli(args(['policy', 'unknown']), io)).rejects.toThrow('Unknown policy');
    await expect(runCli(args(['inventory', 'unknown']), io)).rejects.toThrow('Unknown inventory');
  });
  it('does not rewrite retained Python projects', async () => {
    await mkdir(join(project, 'config'), { recursive: true });
    await writeFile(join(project, 'config/manifest.yaml'), '{"schema_version":5}');
    await expect(runCli(args(['policy', 'validate']), io)).rejects.toThrow('Python');
    expect(await readFile(join(project, 'config/manifest.yaml'), 'utf8')).toBe('{"schema_version":5}');
  });
  it('supports explicit positive/negative confirmations without a terminal', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    await expect(
      runCli(args(['policy', 'lock']), { ...io, confirm: () => Promise.resolve(false) }),
    ).rejects.toThrow('Cancelled');
    expect(await runCli(args(['policy', 'lock']), { ...io, confirm: () => Promise.resolve(true) })).toBe(0);
  });
  it('imports only explicitly reviewed enrollment and treats asset all literally', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    const input = join(root, 'inventory.json');
    const fixture = {
      schemaVersion: 1,
      devices: [
        {
          assetId: 'all',
          kind: 'pixel',
          canonicalSerial: 'SERIAL',
          model: 'Pixel 8a',
          codename: 'akita',
          transports: [{ kind: 'usb', serial: 'SERIAL' }],
          groups: [],
        },
      ],
    };
    await writeFile(input, JSON.stringify(fixture));
    await runCli(args(['inventory', 'import', '--file', input, '--yes']), io);
    expect(JSON.parse(await readFile(join(project, 'inventory.json'), 'utf8'))).toEqual(fixture);
    await expect(runCli(args(['device', 'inspect', '--all', '--asset', 'all']), io)).rejects.toThrow(
      'one exact',
    );
  });
  it('serves only fixed public guides in selected supported languages', async () => {
    await mkdir(join(resources, 'guides/source/markdown'), { recursive: true });
    await writeFile(join(resources, 'guides/source/markdown/user-pl.md'), '# Telefon');
    expect(await runCli(args(['guide', 'recipient', '--locale', 'pl']), io)).toBe(0);
    expect(output.at(-1)).toBe('# Telefon');
    await expect(runCli(args(['guide', '../../secret']), io)).rejects.toThrow('Choose');
    await expect(runCli(args(['guide', 'operator', '--locale', 'fr']), io)).rejects.toThrow('locale');
  });
  it('generates project guidance from the selected policy and emulator capabilities', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    expect(await runCli(args(['guide', 'project', '--locale', 'pl', '--kind', 'emulator']), io)).toBe(0);
    expect(output.at(-1)).toContain('emulator_image_provenance');
    await expect(runCli(args(['guide', 'project', '--kind', 'unknown']), io)).rejects.toThrow('kind');
    await expect(runCli(args(['guide', 'project', '--locale', 'unknown']), io)).rejects.toThrow('locale');
  });
  it('rejects invalid execution and transport declarations before device execution', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    await expect(runCli(args(['device', 'inspect', '--transport', 'bluetooth']), io)).rejects.toThrow(
      'Invalid transport',
    );
    await expect(
      runCli(
        args(['policy', 'validate', '--execution', 'docker', '--image', 'x', '--docker-mode', 'privileged']),
        io,
      ),
    ).rejects.toThrow('Invalid Docker');
  });
  it('lists extension storage without creating a store or contacting a registry', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    const original = process.env['PXV_EXTENSION_ROOT'];
    process.env['PXV_EXTENSION_ROOT'] = join(root, 'extensions');
    try {
      expect(await runCli(args(['extension', 'list']), io)).toBe(0);
      await expect(readFile(join(root, 'extensions'))).rejects.toThrow();
    } finally {
      if (original === undefined) delete process.env['PXV_EXTENSION_ROOT'];
      else process.env['PXV_EXTENSION_ROOT'] = original;
    }
  });
  it('refuses unsupported extension and local lifecycle inputs', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    await expect(runCli(args(['extension', 'inspect', '--extension', 'missing']), io)).rejects.toThrow(
      'not pinned',
    );
    await expect(runCli(args(['lifecycle', 'wipe']), io)).rejects.toThrow('Unknown lifecycle');
    await expect(runCli(args(['unknown']), io)).rejects.toThrow('Unknown command');
  });
  it('can run from an unrelated working directory with explicit resources and project', async () => {
    await runCli(args(['project', 'init', '--path', project]), io);
    const previous = process.cwd();
    process.chdir(resolve('/tmp'));
    try {
      expect(await runCli(args(['agent', 'runs']), io)).toBe(0);
      expect(output.at(-1)).toBe('[]');
    } finally {
      process.chdir(previous);
    }
  });
});
