import { validatePolicyDocument, type PolicySourceDocument, type ArtifactPolicy } from '@pxv/contracts';
import { loadProject } from '@pxv/engine';
import { access, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../../packages/cli/src/cli.js';
import { afterEach, beforeEach, expect, it, vi } from '../test-api.js';
import { hashA, hashB, product } from '../contracts/fixtures.js';
import { apkBytes, appId, artifact, checksum, updateFixture, version } from './policy-update-fixture.js';

let fixture: Awaited<ReturnType<typeof updateFixture>>;
let document: PolicySourceDocument;
beforeEach(async () => {
  fixture = await updateFixture('resolve-apps');
  document = structuredClone(fixture.document);
  document.apps['messenger'] = { packageId: appId, source: { kind: 'fdroid' } };
});
afterEach(async () => {
  await fixture.close();
});
const save = async () => writeFile(fixture.path, JSON.stringify(document));
const output = () =>
  JSON.parse(fixture.io.out.mock.calls.at(-1)![0]) as {
    written: boolean;
    policyLockRequired: boolean;
    destination: string;
    unchanged: string[];
    resolutions: {
      appId: string;
      after: ArtifactPolicy;
      discovered: string[];
      observedSignerSha256?: string;
    }[];
  };
function publisher() {
  document.apps['messenger'] = {
    packageId: appId,
    source: { kind: 'direct', url: 'https://publisher.example/app.apk', redirectHosts: ['cdn.example'] },
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await fixture.state.beforeDownload();
    return new Response(apkBytes(appId, 2));
  });
}

it('resolves official stable apps including unused entries and preserves authored catalog and omissions', async () => {
  document.apps['unused'] = { packageId: 'org.example.unused', source: { kind: 'fdroidcl' } };
  fixture.index.packages['org.example.unused'] = [version(2, 'org.example.unused')];
  fixture.index.apps.push({ packageName: 'org.example.unused', suggestedVersionCode: 2 });
  delete (document as { requiredAttestations?: unknown }).requiredAttestations;
  await save();
  await fixture.standalone(['--yes']);
  const saved = JSON.parse(await readFile(fixture.path, 'utf8')) as typeof document;
  expect(validatePolicyDocument(saved)).toBeDefined();
  expect(saved.apps['messenger']).toEqual({
    ...artifact(),
    versionCode: 2,
    sha256: checksum(apkBytes(appId, 2)),
  });
  expect(saved.apps['unused']!.versionCode).toBe(2);
  expect(saved.profiles).toEqual(document.profiles);
  expect(saved).not.toHaveProperty('requiredAttestations');
  expect(output().resolutions.map((row) => row.appId)).toEqual(['messenger', 'unused']);
  expect(fixture.io.out).toHaveBeenCalledOnce();
  expect(fixture.guard).not.toHaveBeenCalled();
});

it('verifies complete pins without upgrading, prompting, or rewriting bytes', async () => {
  await fixture.save();
  const before = await readFile(fixture.path, 'utf8');
  const inode = (await stat(fixture.path)).ino;
  await fixture.standalone([]);
  expect(output()).toMatchObject({ unchanged: ['messenger'], written: false });
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect((await stat(fixture.path)).ino).toBe(inode);
  expect(fixture.run.mock.calls.filter(([args]) => args[1] === 'download').map(([args]) => args[2])).toEqual([
    `${appId}:1`,
  ]);
  expect(fixture.run.mock.calls.some(([args]) => args[0] === '/tools/apksigner')).toBe(true);
  expect(fixture.io.confirm).not.toHaveBeenCalled();
});

it('discovers direct APK pins, reports its first observed signer and always cleans the download', async () => {
  const fetch = publisher();
  await save();
  await fixture.standalone(['--yes']);
  expect(output().resolutions[0]).toMatchObject({
    discovered: ['versionCode', 'sha256', 'signerSha256'],
    observedSignerSha256: hashB,
    after: {
      packageId: appId,
      versionCode: 2,
      sha256: checksum(apkBytes(appId, 2)),
      signerSha256: hashB,
      source: document.apps['messenger']!.source,
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  const path = fixture.run.mock.calls.find(([args]) => args[0] === '/tools/aapt')![0].at(-1)!;
  await expect(access(dirname(path))).rejects.toThrow();
  expect(fixture.requireTool.mock.calls.some(([name]) => name === 'fdroidcl' || name === 'java')).toBe(false);
});

it('preserves direct constraints and legacy URL representation', async () => {
  publisher();
  document.apps['messenger'] = {
    packageId: appId,
    versionCode: 2,
    signerSha256: hashB.toUpperCase(),
    url: 'https://publisher.example/app.apk',
    redirectHosts: ['cdn.example'],
  };
  await save();
  await fixture.standalone(['--yes']);
  const after = output().resolutions[0]!.after;
  expect(after).toMatchObject({ signerSha256: hashB.toUpperCase(), url: document.apps['messenger'].url });
  expect(after).not.toHaveProperty('source');
  expect(output().resolutions[0]!.discovered).toEqual(['sha256']);
});

for (const source of ['inline', 'reference'])
  it(`resolves a trusted custom ${source} repository without injecting source defaults`, async () => {
    const repo = fixture.customRepository();
    document.repositories.push(repo);
    fixture.indexes.set(repo.url, { ...fixture.index, repo: { ...fixture.index.repo, address: repo.url } });
    document.apps['messenger'] = {
      packageId: appId,
      ...(source === 'inline'
        ? { source: { kind: 'fdroid-repository' as const, url: repo.url, fingerprint: repo.signerSha256 } }
        : { repositoryId: repo.id }),
    };
    await save();
    await fixture.standalone(['--yes']);
    expect(output().resolutions[0]!.after).toMatchObject(document.apps['messenger']);
    if (source === 'inline') expect(output().resolutions[0]!.after.source).not.toHaveProperty('maxAgeDays');
    expect(fixture.sessions.size).toBe(1);
  });

it('resolves a relative local APK using a private verified snapshot', async () => {
  await writeFile(join(fixture.root, 'local.apk'), apkBytes(appId, 2));
  document.apps['messenger'] = { packageId: appId, path: 'local.apk' };
  await save();
  await fixture.standalone(['--yes']);
  expect(output().resolutions[0]!.after).toMatchObject({
    path: 'local.apk',
    versionCode: 2,
    signerSha256: hashB,
  });
  expect(await readFile(join(fixture.root, 'local.apk'), 'utf8')).toBe(apkBytes(appId, 2));
});

it('selects compatible stable versions below the suggestion and respects supplied hash constraints', async () => {
  fixture.index.packages[appId]!.push(version(3), { ...version(4), nativecode: ['x86_64'] }, version(5));
  fixture.index.apps[0]!.suggestedVersionCode = 4;
  await save();
  await fixture.standalone();
  expect(output().resolutions[0]!.after.versionCode).toBe(3);
  document.apps['messenger']!.sha256 = version(1).hash;
  await save();
  await fixture.standalone();
  expect(output().resolutions[0]!.after.versionCode).toBe(1);
});

it('accepts an explicit version without stable metadata and never changes that version', async () => {
  document.apps['messenger']!.versionCode = 1;
  delete fixture.index.apps[0]!.suggestedVersionCode;
  await save();
  await fixture.standalone(['--yes']);
  expect(output().resolutions[0]!.after.versionCode).toBe(1);
});

it('supports verified dry runs without touching input or creating output', async () => {
  publisher();
  await save();
  const before = await readFile(fixture.path, 'utf8');
  const destination = join(fixture.root, 'pinned.json');
  await fixture.standalone(['--dry-run', '--output', destination]);
  expect(output()).toMatchObject({ written: false, destination });
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  await expect(access(destination)).rejects.toThrow();
  expect(fixture.io.confirm).not.toHaveBeenCalled();
});

it('writes a separate output without changing the source, and avoids rewriting identical output', async () => {
  await save();
  const before = await readFile(fixture.path, 'utf8');
  const destination = join(fixture.root, 'pinned.json');
  await fixture.standalone(['--output', destination, '--yes']);
  expect(validatePolicyDocument(JSON.parse(await readFile(destination, 'utf8')))).toBeDefined();
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  const inode = (await stat(destination)).ino;
  await fixture.standalone(['--output', destination]);
  expect(output().written).toBe(false);
  expect((await stat(destination)).ino).toBe(inode);
});

it('creates separate output for a fully pinned input', async () => {
  const destination = join(fixture.root, 'pinned.json');
  await fixture.standalone(['--output', destination, '--yes']);
  expect(output()).toMatchObject({ unchanged: ['messenger'], written: true });
  expect(validatePolicyDocument(JSON.parse(await readFile(destination, 'utf8')))).toBeDefined();
});

for (const separate of [false, true])
  it(`resolves an unresolved project with separate output=${separate}, leaving the lock unchanged`, async () => {
    const project = await fixture.project();
    await writeFile(project.path, JSON.stringify(document));
    await expect(loadProject(project.context.root, product, fixture.resources)).rejects.toThrow();
    const lock = join(project.context.root, 'policy.lock.json');
    const before = await readFile(lock, 'utf8');
    const destination = join(fixture.root, 'pinned.json');
    await project.run(['--yes', ...(separate ? ['--output', destination] : [])]);
    expect(fixture.guard).toHaveBeenCalledOnce();
    expect(output().policyLockRequired).toBe(!separate);
    expect(await readFile(lock, 'utf8')).toBe(before);
    if (separate) expect(JSON.parse(await readFile(project.path, 'utf8'))).toEqual(document);
    else expect((await loadProject(project.context.root, product, fixture.resources)).policy).toBeDefined();
  });

for (const reason of [
  'metadata',
  'repository-signature',
  'apk-signature',
  'hash',
  'package',
  'signer',
  'sdk',
  'abi',
  'ambiguous',
  'repository-failure',
])
  it(`aborts the entire write for ${reason}`, async () => {
    document.apps['unused'] = artifact('org.example.unused');
    fixture.index.packages['org.example.unused'] = [version(1, 'org.example.unused')];
    if (reason === 'metadata') delete fixture.index.apps[0]!.suggestedVersionCode;
    if (reason === 'repository-signature') fixture.state.fail = 'signature';
    if (reason === 'apk-signature') fixture.state.fail = 'apk-signature';
    if (reason === 'hash') fixture.index.packages[appId]![1]!.hash = hashA;
    if (reason === 'package') fixture.state.actualId = 'org.example.wrong';
    if (reason === 'signer') fixture.state.actualSigner = hashA;
    if (reason === 'sdk') fixture.state.actualSdk = 99;
    if (reason === 'abi') fixture.state.actualAbi = 'x86_64';
    if (reason === 'ambiguous') fixture.index.packages[appId]!.push({ ...version(2), hash: hashA });
    if (reason === 'repository-failure') fixture.state.fail = 'update';
    await save();
    const before = await readFile(fixture.path, 'utf8');
    await expect(fixture.standalone(['--yes'])).rejects.toThrow();
    expect(await readFile(fixture.path, 'utf8')).toBe(before);
    expect(fixture.io.confirm).not.toHaveBeenCalled();
  });

for (const constraint of ['versionCode', 'sha256', 'signerSha256'] as const)
  it(`rejects a mismatched direct ${constraint} constraint`, async () => {
    publisher();
    if (constraint === 'versionCode') document.apps['messenger']!.versionCode = 1;
    else document.apps['messenger']![constraint] = hashA;
    await save();
    const before = await readFile(fixture.path, 'utf8');
    await expect(fixture.standalone(['--yes'])).rejects.toThrow(/supplied pins/);
    expect(await readFile(fixture.path, 'utf8')).toBe(before);
  });

for (const interrupted of [false, true])
  it(`preserves input on ${interrupted ? 'interruption' : 'declined confirmation'}`, async () => {
    await save();
    const before = await readFile(fixture.path, 'utf8');
    if (interrupted)
      fixture.state.beforeDownload = async () => {
        process.emit('SIGINT');
        await Promise.resolve();
      };
    else fixture.io.confirm.mockResolvedValue(false);
    await expect(fixture.standalone([])).rejects.toThrow();
    expect(await readFile(fixture.path, 'utf8')).toBe(before);
  });

for (const source of ['input', 'output', 'config', 'inventory'])
  it(`preserves concurrent edits to ${source}`, async () => {
    const project = source === 'config' || source === 'inventory' ? await fixture.project() : undefined;
    const destination = join(fixture.root, 'pinned.json');
    await writeFile(destination, '{}');
    if (project) await writeFile(project.path, JSON.stringify(document));
    else await save();
    const path =
      source === 'input'
        ? fixture.path
        : source === 'output'
          ? destination
          : join(project!.context.root, source === 'config' ? 'pxv.project.json' : 'inventory.json');
    const changed = (await readFile(path, 'utf8')) + '\n ';
    fixture.state.beforeDownload = async () => {
      await writeFile(path, changed);
    };
    await expect(
      project
        ? project.run(['--yes', '--output', destination])
        : fixture.standalone(['--yes', '--output', destination]),
    ).rejects.toThrow(/changed/);
    expect(await readFile(path, 'utf8')).toBe(changed);
  });

it('rejects symlink input and output before downloads', async () => {
  const linked = join(fixture.root, 'linked.json');
  await symlink(fixture.path, linked);
  await expect(fixture.standalone(['--yes', '--output', linked])).rejects.toThrow();
  await expect(
    runCli(
      [
        'policy',
        'resolve-apps',
        '--policy',
        linked,
        '--sdk',
        '36',
        '--abi',
        'arm64-v8a',
        '--resource-root',
        fixture.resources,
      ],
      fixture.io,
    ),
  ).rejects.toThrow();
  expect(fixture.run).not.toHaveBeenCalled();
});

it('registers help without requiring a project or compatibility flags', async () => {
  await runCli(['policy', 'resolve-apps', '--help', '--resource-root', fixture.resources], fixture.io);
  expect(fixture.io.out.mock.calls[0]![0]).toContain('--output');
});
for (const flags of [
  [],
  ['--sdk', '36'],
  ['--abi', 'arm64-v8a'],
  ['--asset', 'phone', '--sdk', '36', '--abi', 'arm64-v8a'],
  ['--policy', 'input.json', '--asset', 'phone'],
  ['--policy', 'input.json', '--project-root', '/unused', '--sdk', '36', '--abi', 'arm64-v8a'],
  ['--sdk', '36', '--abi', 'arm64-v8a', '--output', ''],
])
  it(`rejects invalid resolver arguments ${JSON.stringify(flags)} before access`, async () => {
    await expect(runCli(['policy', 'resolve-apps', ...flags], fixture.io)).rejects.toThrow();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.discover).not.toHaveBeenCalled();
  });

it('rejects recipe pin conflicts discovered after resolving missing app pins', async () => {
  document.profiles[0]!.recipes = [
    {
      schemaVersion: 1,
      id: 'setup',
      packageId: appId,
      versionCode: 1,
      signerSha256: hashB,
      buildFingerprint: 'fingerprint',
      steps: [{ action: 'tap', selector: { resourceId: `${appId}:id/start` } }],
      postconditions: [{ resourceId: `${appId}:id/done` }],
    },
  ];
  await save();
  const before = await readFile(fixture.path, 'utf8');
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('Recipe app identity');
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect(fixture.io.confirm).not.toHaveBeenCalled();
});

it('rejects conflicting duplicate package identities after mixed source discovery', async () => {
  publisher();
  document.apps['messenger']!.versionCode = 2;
  document.apps['unused'] = { packageId: appId, versionCode: 1, source: { kind: 'fdroidcl' } };
  // Known contradictory pins are rejected even though neither entry is complete.
  await save();
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('Conflicting device-wide APK');
  expect(fixture.run).not.toHaveBeenCalled();
  delete document.apps['messenger']!.versionCode;
  delete document.apps['unused'].versionCode;
  fixture.index.apps[0]!.suggestedVersionCode = 1;
  await save();
  const before = await readFile(fixture.path, 'utf8');
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('Conflicting device-wide APK');
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
});

it('resolves mixed source catalogs and isolates two trusted repositories', async () => {
  publisher();
  const custom = fixture.customRepository();
  document.repositories.push(custom);
  document.apps['official'] = { packageId: 'org.example.official', source: { kind: 'fdroidcl' } };
  document.apps['custom'] = { packageId: 'org.example.custom', repositoryId: custom.id };
  fixture.index.packages['org.example.official'] = [version(2, 'org.example.official')];
  fixture.index.apps.push({ packageName: 'org.example.official', suggestedVersionCode: 2 });
  fixture.indexes.set(custom.url, {
    ...fixture.index,
    repo: { ...fixture.index.repo, address: custom.url },
    apps: [{ packageName: 'org.example.custom', suggestedVersionCode: 2 }],
    packages: { 'org.example.custom': [version(2, 'org.example.custom')] },
  });
  await save();
  await fixture.standalone(['--yes']);
  expect(output().resolutions.map((row) => row.appId)).toEqual(['messenger', 'official', 'custom']);
  expect(fixture.sessions.size).toBe(2);
  expect(validatePolicyDocument(JSON.parse(await readFile(fixture.path, 'utf8')))).toBeDefined();
});

it('resolves an exact version above the signed stable suggestion', async () => {
  fixture.index.packages[appId]!.push(version(3));
  document.apps['messenger']!.versionCode = 3;
  await save();
  await fixture.standalone();
  expect(output().resolutions[0]!.after.versionCode).toBe(3);
});

it('fails without compatible repository builds and refuses replacement bytes for complete pins', async () => {
  document.apps['messenger']!.sha256 = hashA;
  await save();
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('No compatible repository APK');
  document.apps['messenger'] = artifact();
  fixture.index.packages[appId]![0]!.hash = hashA;
  await save();
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('No compatible repository APK');
  expect(fixture.run.mock.calls.some(([args]) => args[1] === 'download')).toBe(false);
});

it('reviews and atomically replaces an existing output after confirmation', async () => {
  await save();
  const destination = join(fixture.root, 'pinned.json');
  await writeFile(destination, '{}');
  await fixture.standalone(['--output', destination]);
  expect(fixture.io.confirm).toHaveBeenCalledOnce();
  expect(output().written).toBe(true);
  expect(validatePolicyDocument(JSON.parse(await readFile(destination, 'utf8')))).toBeDefined();
});

for (const name of ['pxv.project.json', 'inventory.json', 'policy.lock.json'])
  it(`refuses project metadata output ${name} before downloads`, async () => {
    const project = await fixture.project();
    const destination = join(project.context.root, name);
    const before = await readFile(destination, 'utf8');
    await expect(project.run(['--yes', '--output', destination])).rejects.toThrow('--output cannot replace');
    expect(await readFile(destination, 'utf8')).toBe(before);
    expect(fixture.run).not.toHaveBeenCalled();
  });

it('enforces a project freshness floor without changing discovery state', async () => {
  const project = await fixture.project();
  await writeFile(project.path, JSON.stringify(document));
  const { RepositoryService } = await import('@pxv/adapters');
  const { SqliteStore } = await import('@pxv/runtime');
  const { OFFICIAL_FDROID } = await import('../../packages/cli/src/artifact-repository.js');
  const path = join(project.context.root, 'state/pxv.sqlite3');
  const store = await SqliteStore.open(path);
  const key = RepositoryService.prototype.key(OFFICIAL_FDROID);
  const floor = { signerSha256: OFFICIAL_FDROID.signerSha256, timestamp: fixture.index.repo.timestamp + 1 };
  await store.set('repository-freshness', key, floor);
  await store.close();
  await expect(project.run(['--yes'])).rejects.toThrow('roll back');
  const retained = await SqliteStore.open(path, { readOnly: true });
  try {
    expect(await retained.get('repository-freshness', key)).toEqual(floor);
  } finally {
    await retained.close();
  }
  expect(JSON.parse(await readFile(project.path, 'utf8'))).toEqual(document);
});
