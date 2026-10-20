import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { hashA } from '../contracts/fixtures.js';
import { OFFICIAL_FDROID } from '../../packages/cli/src/artifact-repository.js';
import { apkBytes, artifact, appId, checksum, updateFixture, version } from './policy-update-fixture.js';

let fixture: Awaited<ReturnType<typeof updateFixture>>;
beforeEach(async () => {
  fixture = await updateFixture();
});
afterEach(async () => {
  await fixture.close();
});

it('updates all supported source representations using one isolated session per trusted repository', async () => {
  const repository = fixture.customRepository();
  fixture.document.repositories = [repository];
  fixture.indexes.set(repository.url, {
    ...structuredClone(fixture.index),
    repo: { address: repository.url, timestamp: Date.now() },
  });
  fixture.document.apps['legacy'] = {
    packageId: appId,
    versionCode: 1,
    sha256: artifact().sha256,
    signerSha256: artifact().signerSha256,
    url: `${OFFICIAL_FDROID.url}/${appId}_1.apk`,
  };
  fixture.document.apps['direct'] = {
    ...artifact(),
    source: { kind: 'direct', url: `${repository.url}/old.apk`, redirectHosts: ['cdn.example'] },
  };
  fixture.document.apps['reference'] = {
    packageId: appId,
    versionCode: 1,
    sha256: checksum(apkBytes()),
    signerSha256: artifact().signerSha256,
    repositoryId: repository.id,
  };
  fixture.document.apps['inline'] = {
    ...artifact(),
    source: { kind: 'fdroid-repository', url: repository.url, fingerprint: repository.signerSha256 },
  };
  await fixture.save();
  await fixture.standalone(['--yes']);
  const result = JSON.parse(await readFile(fixture.path, 'utf8')) as typeof fixture.document;
  expect(fixture.output().updates).toHaveLength(5);
  expect(fixture.sessions.size).toBe(2);
  expect(result.apps['legacy']).toMatchObject({ url: `${OFFICIAL_FDROID.url}/${appId}_2.apk` });
  expect(result.apps['legacy']).not.toHaveProperty('source');
  expect(result.apps['direct']!.source).toEqual({
    kind: 'direct',
    url: `${repository.url}/${appId}_2.apk`,
    redirectHosts: ['cdn.example'],
  });
  expect(result.apps['reference']!.repositoryId).toBe(repository.id);
  expect(result.apps['reference']).not.toHaveProperty('url');
  expect(result.apps['inline']!.source).toEqual(fixture.document.apps['inline'].source);
  expect(
    fixture.run.mock.calls.filter(([args]) => args[0] === '/tools/java').map(([args]) => args[4]),
  ).toEqual([OFFICIAL_FDROID.signerSha256, repository.signerSha256]);
});

it('reports local and untrusted publisher sources as skipped without migrating matching package IDs', async () => {
  fixture.document.apps = {
    local: {
      packageId: appId,
      versionCode: 1,
      sha256: artifact().sha256,
      signerSha256: artifact().signerSha256,
      path: 'app.apk',
    },
    publisher: { ...artifact(), source: { kind: 'direct', url: 'https://publisher.example/app.apk' } },
    prefix: { ...artifact(), source: { kind: 'direct', url: 'https://f-droid.org/repo.evil/app.apk' } },
    traversal: { ...artifact(), source: { kind: 'direct', url: 'https://f-droid.org/repo/../outside.apk' } },
    encoded: {
      ...artifact(),
      source: { kind: 'direct', url: 'https://f-droid.org/repo/%2e%2e/outside.apk' },
    },
  };
  fixture.document.profiles[0]!.apps = ['local'];
  await fixture.save();
  await fixture.standalone(['--yes']);
  expect(fixture.output()).toMatchObject({ written: false, updates: [] });
  expect(fixture.output().skipped).toHaveLength(5);
  expect(fixture.requireTool).not.toHaveBeenCalled();
});

it('rejects a legacy URL that matches conflicting policy trust anchors', async () => {
  const repository = fixture.customRepository();
  fixture.document.repositories = [
    repository,
    { ...repository, id: 'another', signerSha256: 'c'.repeat(64) },
  ];
  fixture.document.apps['messenger'] = {
    ...artifact(),
    source: { kind: 'direct', url: `${repository.url}/old.apk` },
  };
  await fixture.save();
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('ambiguous trusted');
});

it('selects a stable compatible build below the suggested cap, excluding newer SDK, ABI and beta builds', async () => {
  fixture.index.apps[0]!.suggestedVersionCode = '4';
  fixture.index.packages[appId] = [
    version(1),
    version(2),
    { ...version(3), minSdkVersion: 37 },
    { ...version(4), nativecode: ['x86_64'] },
    version(5),
  ];
  await fixture.standalone();
  expect(fixture.output().updates[0]!.after.versionCode).toBe(2);
});

it('ignores unsupported ABI labels belonging to apps outside the policy catalog', async () => {
  fixture.index.packages['org.example.unrelated'] = [{ ...version(2), nativecode: ['amd64-Linux-gpp/jni'] }];
  await fixture.standalone();
  expect(fixture.output().updates).toHaveLength(1);
});

for (const reason of ['missing-metadata', 'missing-package', 'maximum-sdk', 'newer-policy']) {
  it(`skips ${reason} without downloading or rewriting the policy`, async () => {
    if (reason === 'missing-metadata') fixture.index.apps = [];
    if (reason === 'missing-package') fixture.index.packages = {};
    if (reason === 'maximum-sdk') for (const row of fixture.index.packages[appId]!) row.maxSdkVersion = 35;
    if (reason === 'newer-policy') {
      fixture.document.apps['messenger'] = {
        ...artifact(),
        versionCode: 3,
        sha256: checksum(apkBytes(appId, 3)),
      };
      fixture.index.packages[appId]!.push(version(3));
      await fixture.save();
    }
    const before = await readFile(fixture.path, 'utf8');
    await fixture.standalone(['--yes']);
    expect(fixture.output().skipped).toHaveLength(1);
    expect(fixture.output().updates).toHaveLength(0);
    expect(fixture.run.mock.calls.some(([args]) => args[1] === 'download')).toBe(false);
    expect(await readFile(fixture.path, 'utf8')).toBe(before);
  });
}

for (const failure of [
  'signature',
  'update',
  'apk-signature',
  'hash',
  'package',
  'version',
  'signer',
  'sdk',
  'abi',
  'rotation',
  'ambiguous',
  'replacement',
  'timeout',
]) {
  it(`refuses the entire policy update after ${failure} verification failure and cleans temporary files`, async () => {
    const rows = fixture.index.packages[appId]!;
    if (['signature', 'update', 'apk-signature'].includes(failure)) fixture.state.fail = failure;
    if (failure === 'hash') rows[1]!.hash = hashA;
    if (failure === 'package') fixture.state.actualId = 'org.example.wrong';
    if (failure === 'version') fixture.state.actualCode = 99;
    if (failure === 'signer') fixture.state.actualSigner = hashA;
    if (failure === 'sdk') fixture.state.actualSdk = 40;
    if (failure === 'abi') fixture.state.actualAbi = 'x86_64';
    if (failure === 'rotation') rows[1]!.signer = hashA;
    if (failure === 'ambiguous') rows.push({ ...version(2), hash: hashA });
    if (failure === 'replacement') rows[0]!.hash = hashA;
    if (failure === 'timeout') fixture.state.timeout = true;
    const before = await readFile(fixture.path, 'utf8');
    await expect(fixture.standalone(['--yes'])).rejects.toThrow();
    expect(await readFile(fixture.path, 'utf8')).toBe(before);
    expect(fixture.io.confirm).not.toHaveBeenCalled();
  });
}

it('commits no updates when a later app fails after the first app passed verification', async () => {
  fixture.document.apps['second'] = artifact('org.example.second');
  fixture.index.apps.push({ packageName: 'org.example.second', suggestedVersionCode: 2 });
  fixture.index.packages['org.example.second'] = [
    version(1, 'org.example.second'),
    version(2, 'org.example.second'),
  ];
  await fixture.save();
  let count = 0;
  fixture.state.beforeDownload = () => {
    if (++count === 2) fixture.state.actualSigner = hashA;
    return Promise.resolve();
  };
  const before = await readFile(fixture.path, 'utf8');
  await expect(fixture.standalone(['--yes'])).rejects.toThrow('signer');
  expect(count).toBe(2);
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
});

it('cleans up an interrupted download and removes its signal handlers', async () => {
  const listeners = process.listenerCount('SIGINT');
  fixture.state.beforeDownload = () => {
    process.emit('SIGINT');
    return Promise.resolve();
  };
  const before = await readFile(fixture.path, 'utf8');
  await expect(fixture.standalone(['--yes'])).rejects.toThrow();
  expect(await readFile(fixture.path, 'utf8')).toBe(before);
  expect(process.listenerCount('SIGINT')).toBe(listeners);
});
