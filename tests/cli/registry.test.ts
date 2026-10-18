import type * as TestModule0 from '@pxv/guides';
import type * as TestModule1 from '@pxv/contracts';
import type * as TestModule2 from 'node:fs/promises';
import type * as TestModule3 from 'node:path';
import type * as TestModule4 from '@pxv/engine';
import type * as TestModule5 from '@pxv/runtime';
import type * as TestModule6 from '../../packages/cli/src/cli.js';
import type * as TestModule7 from '../contracts/fixtures.js';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;

import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
vi.mock('@pxv/guides', async (original) => {
  const actual = await original<typeof TestModule0>();
  return { ...actual, writeCredentialInsert: vi.fn(actual.writeCredentialInsert) };
});

// Module exports are called without a receiver.

const { toPolicyDocument } = await importModule<typeof TestModule1>('@pxv/contracts', import.meta.url);
// Module exports are called without a receiver.

const { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } = await importModule<
  typeof TestModule2
>('node:fs/promises', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join } = await importModule<typeof TestModule3>('node:path', import.meta.url);
// Module exports are called without a receiver.

const guides = await importModule<typeof TestModule0>('@pxv/guides', import.meta.url);
import type { ProjectContext } from '@pxv/engine';
// Module exports are called without a receiver.

const { createProject, invalidateRegistryBindings, loadProject, readRegistryGeneration, saveInventory } =
  await importModule<typeof TestModule4>('@pxv/engine', import.meta.url);
// Module exports are called without a receiver.

const { readEncryptedRegistry, SqliteStore } = await importModule<typeof TestModule5>(
  '@pxv/runtime',
  import.meta.url,
);
import type { PhoneRegistryRecord } from '@pxv/contracts';
// Module exports are called without a receiver.

const { validatePhoneRegistryDocument } = await importModule<typeof TestModule1>(
  '@pxv/contracts',
  import.meta.url,
);
import type { CliIo } from '../../packages/cli/src/cli.js';
// Module exports are called without a receiver.

const { runCli } = await importModule<typeof TestModule6>('../../packages/cli/src/cli.js', import.meta.url);
// Module exports are called without a receiver.

const { device, policy, product } = await importModule<typeof TestModule7>(
  '../contracts/fixtures.js',
  import.meta.url,
);
describe('local encrypted registry operator commands', () => {
  let root: string;
  let resources: string;
  let project: ProjectContext;
  let passwordFile: string;
  let inputFile: string;
  let vault: string;
  let output: string[];
  let io: CliIo;
  let previousControl: string | undefined;
  const password = 'synthetic registry passphrase only';
  const secret = 'SYNTHETIC-PRIVATE-REGISTRY-VALUE';
  const input = (value = secret) => ({
    fields: { duressPin: { value: '11112222', state: 'current' } },
    profiles: [
      {
        profileId: 'admin',
        user: { userId: 0, serialNo: 0, name: 'Administrator' },
        fields: {
          password: { value, state: 'current' },
          oblivionNotificationWipeKey: { value: `${value}-wipe`, state: 'initial' },
          sessionMessengerId: { value: `${value}-session`, state: 'current' },
          protonVpnUsername: { value: `${value}-vpn`, state: 'current' },
          protonVpnPassword: { value: `${value}-vpn-pass`, state: 'current' },
          phoneNumber: { value: '+48000000000', state: 'unknown' },
        },
      },
    ],
  });
  const args = (...values: string[]) => [
    'registry',
    ...values,
    '--json',
    '--project-root',
    project.root,
    '--resource-root',
    resources,
    '--passphrase-file',
    passwordFile,
  ];
  const run = (...values: string[]) => runCli(args(...values), io);
  const update = (revision = '0', asset = device.assetId) =>
    run('update', '--asset', asset, '--file', inputFile, '--record-revision', revision);
  const snapshot = async () =>
    (
      await readEncryptedRegistry(
        vault,
        project.config.id,
        Buffer.from(password),
        validatePhoneRegistryDocument,
      )
    ).value;

  beforeEach(async () => {
    root = await mkdtemp('/tmp/pxv-registry-cli-');
    previousControl = process.env['PXV_CONTROL_ROOT'];
    process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
    resources = join(root, 'resources');
    await mkdir(resources, { mode: 0o700 });
    await writeFile(join(resources, 'product.json'), JSON.stringify(product));
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), resources);
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    project = await loadProject(created.root, product, resources);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    await store.close();
    passwordFile = join(root, 'password');
    inputFile = join(root, 'input.json');
    vault = join(project.root, 'secrets/phone-registry.pxv');
    await writeFile(passwordFile, `${password}\r\n`, { mode: 0o600 });
    await writeFile(inputFile, JSON.stringify(input()), { mode: 0o600 });
    output = [];
    io = {
      out: (value) => output.push(value),
      error: (value) => output.push(value),
      confirm: () => Promise.resolve(true),
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousControl === undefined) delete process.env['PXV_CONTROL_ROOT'];
    else process.env['PXV_CONTROL_ROOT'] = previousControl;
    await rm(root, { recursive: true, force: true });
  });

  it('prints only the latest effectively bound record and returns no secrets', async () => {
    expect(await run('init')).toBe(0);
    expect(await update()).toBe(0);
    await writeFile(inputFile, JSON.stringify(input(`${secret}-latest`)));
    expect(await update('1')).toBe(0);
    const writer = vi.spyOn(guides, 'writeCredentialInsert').mockResolvedValue();
    const destination = join(project.root, 'secrets', 'insert.pdf');
    expect(
      await run(
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        destination,
        '--chromium',
        '/local/chromium',
      ),
    ).toBe(0);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]![0].revision).toBe(2);
    expect(writer.mock.calls[0]![0].profiles[0]!.fields.password?.value).toBe(`${secret}-latest`);
    expect(writer.mock.calls[0]![2].locale).toBe('en');
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    try {
      await invalidateRegistryBindings(store, device, undefined, '2026-10-18T12:00:00.000Z');
    } finally {
      await store.close();
    }
    expect(
      await run(
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        destination,
        '--chromium',
        '/local/chromium',
        '--locale',
        'pl',
      ),
    ).toBe(0);
    expect(writer.mock.calls[1]![0].profiles[0]!.fields.password?.state).toBe('stale');
    expect(writer.mock.calls[1]![2].locale).toBe('pl');
    expect(output.join()).not.toContain(secret);
    expect(output.join()).not.toContain('11112222');
    expect(output.join()).not.toContain(device.canonicalSerial);
    for (const invalid of [join(project.root, 'public.pdf'), join(resources, 'insert.pdf')]) {
      await expect(
        run('print-insert', '--asset', device.assetId, '--output', invalid, '--chromium', '/local/chromium'),
      ).rejects.toThrow();
    }
    await expect(
      run(
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        destination,
        '--chromium',
        '/local/chromium',
        '--record-revision',
        '1',
      ),
    ).rejects.toThrow();
    await expect(
      run(
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        destination,
        '--chromium',
        '/local/chromium',
        '--locale',
        'de',
      ),
    ).rejects.toThrow();
  });

  it('retains current and initial revisions encrypted; exposes only metadata unless privately revealed', async () => {
    expect(await run('init')).toBe(0);
    expect(await run('list')).toBe(0);
    expect(await update()).toBe(0);
    await writeFile(inputFile, JSON.stringify(input(`${secret}-changed`)));
    expect(await update('1')).toBe(0);
    await run('show', '--asset', device.assetId);
    await run('history', '--asset', device.assetId);
    const history = JSON.parse(output.at(-1)!) as { revision: number }[];
    expect(history.map((record) => record.revision)).toEqual([1, 2]);
    expect(output.join()).not.toContain(secret);
    expect(output.join()).not.toContain('11112222');
    expect(output.join()).not.toContain('+48000000000');
    expect(output.join()).not.toContain(device.canonicalSerial);
    expect(await readFile(vault, 'utf8')).not.toContain(secret);
    expect((await stat(vault)).mode & 0o777).toBe(0o600);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'), { readOnly: true });
    try {
      expect(JSON.stringify(await store.entries('registry-anchor'))).not.toContain(secret);
      expect(JSON.stringify(await store.entries('registry-generation'))).not.toContain(secret);
    } finally {
      await store.close();
    }
    const exported = join(root, 'private-export.json');
    await run('reveal', '--asset', device.assetId, '--output', exported);
    const record = JSON.parse(await readFile(exported, 'utf8')) as PhoneRegistryRecord;
    expect(record.profiles[0]?.fields.password?.value).toBe(`${secret}-changed`);
    expect(record.profiles[0]?.fields.password?.state).toBe('current');
    expect((await stat(exported)).mode & 0o777).toBe(0o600);
    await expect(run('reveal', '--asset', device.assetId, '--output', exported)).rejects.toThrow();
    const old = join(root, 'old.json');
    await run('reveal', '--asset', device.assetId, '--record-revision', '1', '--output', old);
    const previous = JSON.parse(await readFile(old, 'utf8')) as PhoneRegistryRecord;
    expect(previous.profiles[0]?.fields.password).toMatchObject({ value: secret, state: 'stale' });
    expect((await snapshot()).history).toHaveLength(2);
    const alias = join(root, 'resource-alias');
    await symlink(resources, alias);
    await mkdir(join(resources, 'private'), { mode: 0o700 });
    await expect(
      run(
        'reveal',
        '--asset',
        device.assetId,
        '--resource-root',
        alias,
        '--output',
        join(resources, 'private/secret.json'),
      ),
    ).rejects.toThrow('under project secrets');
    await run('reveal', '--asset', device.assetId, '--output', join(project.root, 'secrets/export.json'));
  });

  it('shows an individual phone in a multi-phone registry and retains retired inventory records', async () => {
    const second = {
      ...device,
      assetId: 'phone-two',
      canonicalSerial: 'PIXEL2',
      codename: 'husky',
      transports: [{ kind: 'usb' as const, serial: 'PIXEL2' }],
    };
    await saveInventory(project, { schemaVersion: 1, devices: [device, second] });
    project = await loadProject(project.root, product, resources);
    await run('init');
    await update();
    await update('0', second.assetId);
    await run('show', '--asset', device.assetId);
    expect((JSON.parse(output.at(-1)!) as { devices: unknown[] }).devices).toHaveLength(1);
    await saveInventory(project, { schemaVersion: 1, devices: [second] });
    project = await loadProject(project.root, product, resources);
    await run('show', '--asset', device.assetId);
    expect(output.at(-1)).toContain('stale');
    await run('reveal', '--asset', device.assetId, '--output', join(root, 'removed.json'));
    await expect(update('1')).rejects.toThrow('not enrolled');
  });

  it('rejects canceled updates, stale record revisions and unsafe or malformed input without echoing values', async () => {
    await run('init');
    io.confirm = () => Promise.resolve(false);
    await expect(update()).rejects.toThrow('Cancelled');
    io.confirm = () => Promise.resolve(true);
    await update();
    await expect(update()).rejects.toThrow('revision changed');
    await expect(update('invalid')).rejects.toThrow('Invalid registry record revision');
    await chmod(inputFile, 0o644);
    await expect(update('1')).rejects.toThrow('Private registry file');
    await chmod(inputFile, 0o600);
    await writeFile(inputFile, `{"private":"${secret}"`);
    await expect(update('1')).rejects.toThrow('Invalid private registry record input');
    await writeFile(inputFile, '{"fields":{},"fields":{},"profiles":[]}');
    await expect(update('1')).rejects.toThrow('Invalid private registry record input');
    for (const value of [
      [],
      null,
      { ...input(), extra: secret },
      { ...input(), profiles: [{ ...input().profiles[0], profileId: 'missing' }] },
      {
        ...input(),
        profiles: [{ ...input().profiles[0], user: { userId: 10, serialNo: 10, name: 'bad-owner' } }],
      },
    ]) {
      await writeFile(inputFile, JSON.stringify(value));
      await expect(update('1')).rejects.toThrow('Invalid private registry record input');
    }
    await writeFile(inputFile, JSON.stringify({ ...input(), canonicalSerial: 'WRONG' }));
    await expect(update('1')).rejects.toThrow('identity differs');
    expect((await snapshot()).revision).toBe(1);
    expect(output.join()).not.toContain(secret);
  });

  it('requires exact asset selectors and explicit existing record revisions', async () => {
    await run('init');
    await expect(run('show', '--asset', 'missing')).rejects.toThrow('no registry record');
    await expect(run('history', '--asset', device.assetId)).rejects.toThrow('no registry record');
    await expect(
      run('update', '--all', '--asset', device.assetId, '--file', inputFile, '--record-revision', '0'),
    ).rejects.toThrow('is not supported');
    await expect(
      run('update', '--group', 'pilot', '--file', inputFile, '--record-revision', '0'),
    ).rejects.toThrow('is not supported');
    await expect(run('update', '--asset', device.assetId, '--file', inputFile)).rejects.toThrow(
      '--record-revision',
    );
    await update();
    await expect(
      run(
        'reveal',
        '--asset',
        device.assetId,
        '--record-revision',
        '9',
        '--output',
        join(root, 'absent.json'),
      ),
    ).rejects.toThrow('does not exist');
  });

  it('refuses a generation change during private review and marks retained credentials stale', async () => {
    await run('init');
    await update();
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    try {
      io.confirm = async () => {
        await invalidateRegistryBindings(store, device);
        return true;
      };
      await expect(update('1')).rejects.toThrow('Encrypted registry');
      expect((await snapshot()).revision).toBe(1);
      await run('show', '--asset', device.assetId);
      expect(output.at(-1)).toContain('stale');
      expect((await readRegistryGeneration(store, device)).deviceEpoch).not.toBe('');
    } finally {
      await store.close();
    }
  });

  it('rotates the passphrase and refuses the old one without deleting retained records', async () => {
    await run('init');
    await update();
    const nextFile = join(root, 'next-password');
    const next = `${password}-replacement`;
    await writeFile(nextFile, next, { mode: 0o600 });
    await run('rekey', '--new-passphrase-file', nextFile);
    await expect(run('list')).rejects.toThrow('Encrypted registry');
    await writeFile(passwordFile, next);
    await run('list');
    const document = (
      await readEncryptedRegistry(vault, project.config.id, Buffer.from(next), validatePhoneRegistryDocument)
    ).value;
    expect(document.history).toHaveLength(1);
  });

  it('detects ciphertext rollback and recovers only by explicitly making all values stale', async () => {
    await run('init');
    await update();
    const previous = await readFile(vault);
    await writeFile(inputFile, JSON.stringify(input(`${secret}-new`)));
    await update('1');
    await writeFile(vault, previous);
    await expect(run('list')).rejects.toThrow('reconciliation');
    io.confirm = () => Promise.resolve(false);
    await expect(run('reconcile')).rejects.toThrow('Cancelled');
    io.confirm = () => Promise.resolve(true);
    await run('reconcile');
    await run('show', '--asset', device.assetId);
    expect(output.at(-1)).toContain('stale');
    expect((await snapshot()).devices[0]?.profiles[0]?.fields.password).toMatchObject({
      value: secret,
      state: 'stale',
    });
    expect((await snapshot()).history).toHaveLength(2);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    try {
      const anchor = await store.get<Record<string, unknown>>('registry-anchor', project.config.id);
      await store.set('registry-anchor', project.config.id, { ...anchor, state: 'pending' });
    } finally {
      await store.close();
    }
    await expect(run('list')).rejects.toThrow('reconciliation');
    await run('reconcile');
    expect((await snapshot()).history).toHaveLength(3);
  });

  it('keeps registry commands local and rejects unsupported commands or missing private unlock input', async () => {
    await expect(run('init', '--execution', 'docker')).rejects.toThrow('local host');
    await expect(run('delete')).rejects.toThrow('Unknown registry command');
    const noPassword = args('init').slice(0, -2);
    await expect(runCli(noPassword, io)).rejects.toThrow('local terminal');
    await writeFile(passwordFile, 'short');
    await expect(run('init')).rejects.toThrow('Encrypted registry');
  });
});
