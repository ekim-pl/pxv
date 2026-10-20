import { access, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/src/cli.js';
import { SqliteStore } from '@pxv/runtime';
import { OFFICIAL_FDROID } from '../../packages/cli/src/artifact-repository.js';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { artifact, appId, updateFixture, version } from './policy-update-fixture.js';

let fixture: Awaited<ReturnType<typeof updateFixture>>;
beforeEach(async () => {
  fixture = await updateFixture();
});
afterEach(async () => {
  await fixture.close();
});

it('updates standalone catalog pins after APK verification, preserving authored configuration and unused IDs', async () => {
  fixture.document.apps['unused'] = artifact('org.example.unused');
  fixture.document.apps['messenger'] = {
    ...artifact(),
    source: {
      kind: 'fdroid-repository',
      url: OFFICIAL_FDROID.url,
      fingerprint: OFFICIAL_FDROID.signerSha256,
    },
  };
  fixture.index.packages['org.example.unused'] = [
    version(1, 'org.example.unused'),
    version(2, 'org.example.unused'),
  ];
  fixture.index.apps.push({ packageName: 'org.example.unused', suggestedVersionCode: '2' });
  await fixture.save();
  const original = structuredClone(fixture.document);
  delete (fixture.document as { requiredAttestations?: unknown }).requiredAttestations;
  await fixture.save();
  expect(await fixture.standalone(['--yes'])).toBe(0);
  const saved = JSON.parse(await readFile(fixture.path, 'utf8')) as typeof original;
  expect(saved.apps['messenger']!.versionCode).toBe(2);
  expect(saved.apps['unused']!.versionCode).toBe(2);
  expect(saved.profiles).toEqual(original.profiles);
  expect(saved).not.toHaveProperty('requiredAttestations');
  expect(saved.apps['messenger']!.source).not.toHaveProperty('maxAgeDays');
  expect(fixture.output()).toMatchObject({ written: true, policyLockRequired: false });
  expect(fixture.output().updates.map((row) => row.appId)).toEqual(['messenger', 'unused']);
  expect(fixture.io.out).toHaveBeenCalledOnce();
  expect(fixture.io.confirm).not.toHaveBeenCalled();
  expect(fixture.guard).not.toHaveBeenCalled();
  await expect(access(join(fixture.root, 'pxv.project.json'))).rejects.toThrow();
});

it('measures the exact enrolled phone, updates project policy, and leaves its lock for explicit review', async () => {
  const project = await fixture.project();
  const lock = join(project.context.root, 'policy.lock.json');
  const before = await readFile(lock, 'utf8');
  expect(await project.run(['--yes'])).toBe(0);
  const saved = JSON.parse(await readFile(project.path, 'utf8')) as typeof fixture.document;
  expect(saved.apps['messenger']!.versionCode).toBe(2);
  expect(await readFile(lock, 'utf8')).toBe(before);
  expect(fixture.guard).toHaveBeenCalledOnce();
  expect(fixture.shell.mock.calls.map(([, args]) => args)).toEqual([
    ['getprop', 'ro.build.version.sdk'],
    ['getprop', 'ro.product.cpu.abilist'],
  ]);
  expect(fixture.output()).toMatchObject({ written: true, policyLockRequired: true });
});

it('honors the project freshness floor without advancing it during discovery', async () => {
  const project = await fixture.project();
  const store = await SqliteStore.open(join(project.context.root, 'state/pxv.sqlite3'));
  const { RepositoryService } = await import('@pxv/adapters');
  const key = RepositoryService.prototype.key(OFFICIAL_FDROID);
  const floor = { signerSha256: OFFICIAL_FDROID.signerSha256, timestamp: fixture.index.repo.timestamp + 1 };
  await store.set('repository-freshness', key, floor);
  await store.close();
  const before = await readFile(project.path, 'utf8');
  await expect(project.run(['--yes'])).rejects.toThrow('roll back');
  expect(await readFile(project.path, 'utf8')).toBe(before);
});

it('supports explicit compatibility for projects without inspecting a connected phone', async () => {
  const project = await fixture.project();
  await runCli(
    [
      'policy',
      'update-apps',
      '--project-root',
      project.context.root,
      '--resource-root',
      fixture.resources,
      '--sdk',
      '36',
      '--abi',
      'x86_64,arm64-v8a',
      '--dry-run',
      '--json',
    ],
    fixture.io,
  );
  expect(fixture.guard).not.toHaveBeenCalled();
  expect(fixture.shell).not.toHaveBeenCalled();
  expect(fixture.output().updates).toHaveLength(1);
});

it('refuses symlink policy inputs before downloads and leaves their targets untouched', async () => {
  const path = join(fixture.root, 'linked.json');
  await symlink(fixture.path, path);
  const before = await readFile(fixture.path, 'utf8');
  await expect(
    runCli(
      [
        'policy',
        'update-apps',
        '--policy',
        path,
        '--resource-root',
        fixture.resources,
        '--sdk',
        '36',
        '--abi',
        'arm64-v8a',
        '--yes',
      ],
      fixture.io,
    ),
  ).rejects.toThrow();
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect(fixture.run).not.toHaveBeenCalled();
});

it('renders updater help without a project or compatibility flags', async () => {
  expect(
    await runCli(['policy', 'update-apps', '--resource-root', fixture.resources, '--help'], fixture.io),
  ).toBe(0);
  expect(fixture.io.out.mock.calls[0]![0]).toContain('--sdk');
  expect(fixture.run).not.toHaveBeenCalled();
});

it('verifies proposed downloads during a dry run and emits one JSON result without confirmation or writes', async () => {
  const before = await readFile(fixture.path, 'utf8');
  await fixture.standalone();
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect(fixture.output()).toMatchObject({ dryRun: true, written: false, policyLockRequired: false });
  expect(fixture.output().updates).toHaveLength(1);
  expect(fixture.run.mock.calls.some(([args]) => args[0] === '/tools/apksigner')).toBe(true);
  expect(fixture.run.mock.calls.filter(([args]) => args[1] === 'download').map(([args]) => args[2])).toEqual([
    `${appId}:2`,
  ]);
  expect(fixture.io.out).toHaveBeenCalledOnce();
  expect(fixture.io.confirm).not.toHaveBeenCalled();
});

it('preserves a cancelled policy byte for byte after showing the verified changes', async () => {
  const before = await readFile(fixture.path, 'utf8');
  fixture.io.confirm.mockResolvedValue(false);
  await expect(fixture.standalone([])).rejects.toThrow('Cancelled');
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect(fixture.io.error.mock.calls[0]![0]).toContain('Proposed app updates');
});

it('does not rewrite or prompt for a policy already at the newest stable version', async () => {
  await fixture.standalone(['--yes']);
  fixture.io.confirm.mockClear();
  const before = await stat(fixture.path);
  await fixture.standalone([]);
  expect((await stat(fixture.path)).ino).toBe(before.ino);
  expect(fixture.io.confirm).not.toHaveBeenCalled();
  expect(fixture.output()).toMatchObject({ written: false, unchanged: ['messenger'] });
});

for (const mode of ['standalone', 'project-policy', 'project-config', 'project-inventory']) {
  it(`preserves concurrent edits to ${mode} while downloads are being verified`, async () => {
    const project = mode === 'standalone' ? undefined : await fixture.project();
    const path = !project
      ? fixture.path
      : mode === 'project-config'
        ? join(project.context.root, 'pxv.project.json')
        : mode === 'project-inventory'
          ? join(project.context.root, 'inventory.json')
          : project.path;
    const changed = (await readFile(path, 'utf8')) + '\n ';
    fixture.state.beforeDownload = async () => {
      await writeFile(path, changed);
    };
    await expect(project ? project.run(['--yes']) : fixture.standalone(['--yes'])).rejects.toThrow(/changed/);
    expect(await readFile(path, 'utf8')).toBe(changed);
  });
}

for (const flags of [
  [],
  ['--sdk', '36'],
  ['--abi', 'arm64-v8a'],
  ['--sdk', '0', '--abi', 'arm64-v8a'],
  ['--sdk', '36', '--abi', 'arm64-v8a,'],
  ['--asset', 'phone', '--sdk', '36', '--abi', 'arm64-v8a'],
  ['--policy', 'input.json', '--asset', 'phone'],
  ['--policy', 'input.json', '--project-root', '/unused', '--sdk', '36', '--abi', 'arm64-v8a'],
  ['--transport', 'usb', '--sdk', '36', '--abi', 'arm64-v8a'],
]) {
  it(`rejects invalid updater selection ${JSON.stringify(flags)} before tool or policy access`, async () => {
    await expect(runCli(['policy', 'update-apps', ...flags], fixture.io)).rejects.toThrow();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.discover).not.toHaveBeenCalled();
  });
}
