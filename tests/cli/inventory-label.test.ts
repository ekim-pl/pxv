import type * as Guides from '@pxv/guides';
import type * as Runtime from '@pxv/runtime';
import type * as Cli from '@pxv/cli';
import { createProject, saveInventory } from '@pxv/engine';
import { toPolicyDocument } from '@pxv/contracts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, importModule, it, vi } from '../test-api.js';
import { device, policy, product } from '../contracts/fixtures.js';
import { commandHelp, parseCommandArguments } from '../../packages/cli/src/command-registry.js';
globalThis.__pxvTestFile = import.meta.url;
vi.mock('@pxv/guides', async (original) => {
  const actual = await original<typeof Guides>();
  return { ...actual, writeAssetLabel: vi.fn<typeof actual.writeAssetLabel>() };
});
vi.mock('@pxv/runtime', async (original) => {
  const actual = await original<typeof Runtime>();
  return {
    ...actual,
    readEncryptedRegistry: vi.fn<typeof actual.readEncryptedRegistry>(() =>
      Promise.reject(new Error('Registry must not be read')),
    ),
  };
});
const guides = await importModule<typeof Guides>('@pxv/guides', import.meta.url);
const runtime = await importModule<typeof Runtime>('@pxv/runtime', import.meta.url);
const { runCli } = await importModule<typeof Cli>('@pxv/cli', import.meta.url);
let root: string, projectRoot: string, resources: string;
let priorControl: string | undefined, priorDocker: string | undefined;
const output: string[] = [];
const io = { out: (value: string) => output.push(value), error: (value: string) => output.push(value) };
const args = (...extra: string[]) => [
  'inventory',
  'print-label',
  '--project-root',
  projectRoot,
  '--resource-root',
  resources,
  '--asset',
  device.assetId,
  '--output',
  join(projectRoot, 'secrets/label'),
  '--chromium',
  '/local/chromium',
  '--json',
  ...extra,
];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-label-cli-'));
  priorControl = process.env['PXV_CONTROL_ROOT'];
  priorDocker = process.env['PXV_DOCKER_MODE'];
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  delete process.env['PXV_DOCKER_MODE'];
  resources = join(root, 'resources');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  const project = await createProject(join(root, 'project'), product, toPolicyDocument(policy), resources);
  await saveInventory(project, { schemaVersion: 1, devices: [device] });
  projectRoot = project.root;
  output.length = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (priorControl === undefined) delete process.env['PXV_CONTROL_ROOT'];
  else process.env['PXV_CONTROL_ROOT'] = priorControl;
  if (priorDocker === undefined) delete process.env['PXV_DOCKER_MODE'];
  else process.env['PXV_DOCKER_MODE'] = priorDocker;
  await rm(root, { recursive: true, force: true });
});

for (const locale of ['en', 'pl']) {
  it(`exports both ${locale} label formats using inventory without opening registry or device services`, async () => {
    const open = vi.spyOn(runtime.SqliteStore, 'open');
    await runCli(args('--locale', locale, '--date', '202610', '--pdftoppm', '/local/pdftoppm'), io);
    expect(guides.writeAssetLabel).toHaveBeenCalledWith(
      { assetId: device.assetId, canonicalSerial: device.canonicalSerial, month: '202610' },
      join(projectRoot, 'secrets/label'),
      { locale, chromiumExecutable: '/local/chromium', pdftoppmExecutable: '/local/pdftoppm' },
    );
    expect(runtime.readEncryptedRegistry).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      exported: true,
      month: '202610',
      pdf: join(projectRoot, 'secrets/label.pdf'),
      png: join(projectRoot, 'secrets/label.png'),
    });
    expect(output.join()).not.toContain(device.canonicalSerial);
  });
}

it('defaults to English and the local generation month', async () => {
  const now = new Date();
  await runCli(args(), io);
  const call = vi.mocked(guides.writeAssetLabel).mock.calls[0]!;
  expect(call[0].month).toBe(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  expect(call[2]).toMatchObject({ locale: 'en', pdftoppmExecutable: 'pdftoppm' });
});

for (const [flags, message] of [
  [['--date', '202613'], 'YYYYMM'],
  [['--locale', 'de'], 'Invalid locale'],
  [['--all'], 'not supported'],
  [['--group', 'pilot'], 'not supported'],
  [['--passphrase-file', '/private/password'], 'not supported'],
  [['--execution', 'docker'], 'local host'],
] as const) {
  it(`rejects ${flags.join(' ')} before rendering`, async () => {
    await expect(runCli(args(...flags), io)).rejects.toThrow(message);
    expect(guides.writeAssetLabel).not.toHaveBeenCalled();
  });
}
it('rejects a missing asset, file extensions and public destinations', async () => {
  const base = args();
  base[base.indexOf('--asset') + 1] = 'missing';
  await expect(runCli(base, io)).rejects.toThrow('not enrolled');
  for (const [path, message] of [
    [join(root, 'label.pdf'), 'extensionless'],
    [join(projectRoot, 'label'), 'under project secrets'],
    [join(resources, 'label'), 'under project secrets'],
  ]) {
    const selected = args();
    selected[selected.indexOf('--output') + 1] = path!;
    await expect(runCli(selected, io)).rejects.toThrow(message!);
  }
  process.env['PXV_DOCKER_MODE'] = 'direct';
  await expect(runCli(args(), io)).rejects.toThrow('local host');
  expect(guides.writeAssetLabel).not.toHaveBeenCalled();
});
it('documents exact dimensions and requires asset/output/Chromium in both commands', () => {
  for (const command of [
    ['inventory', 'print-label'],
    ['registry', 'print-card'],
  ]) {
    expect(commandHelp(product, 'test', command)).toContain(
      command[0] === 'inventory' ? '40 x 15 mm' : '68 x 100 mm',
    );
    expect(() => parseCommandArguments(command)).toThrow('--asset is required');
  }
});
