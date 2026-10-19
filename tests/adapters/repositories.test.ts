import { afterEach, describe, expect, it, vi } from './../test-api.js';
import { createHash } from 'node:crypto';
import { repositoryFilename, type RepositoryEvidence } from '../../packages/adapters/src/index.js';
import { now, repository, row, repositoryFixture as service } from './repository-fixture.js';
function stubV1(data: unknown) {
  return vi
    .fn()
    .mockImplementation((url: URL) =>
      Promise.resolve(
        url.pathname.endsWith('/entry.jar')
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify(data)),
      ),
    );
}
afterEach(() => vi.unstubAllGlobals());
describe('pinned repository metadata', () => {
  it('rejects unsafe authenticated filenames', () => {
    expect(repositoryFilename('/nested/app.apk', '.apk')).toBe('nested/app.apk');
    for (const name of [
      '../app.apk',
      '/x/../app.apk',
      'a//app.apk',
      'a\\app.apk',
      'https://evil/app.apk',
      'app.zip',
      '//app.apk',
    ])
      expect(() => repositoryFilename(name, '.apk')).toThrow();
  });
  it('enforces freshness and rollback floors without silently resetting malformed records', () => {
    const { repo } = service();
    expect(() => repo.assertFresh(repository, now)).not.toThrow();
    expect(() => repo.assertFresh(repository, now - 31 * 86_400_000)).toThrow(/freshness window/);
    expect(() => repo.assertFresh(repository, now + 2 * 86_400_000)).toThrow(/freshness window/);
    expect(() =>
      repo.assertFresh(repository, now - 1, { signerSha256: repository.signerSha256, timestamp: now }),
    ).toThrow(/roll back/);
    expect(() => repo.assertFresh(repository, now, { signerSha256: 'd'.repeat(64), timestamp: now })).toThrow(
      /malformed/,
    );
    expect(() =>
      repo.assertFresh(repository, now, { signerSha256: repository.signerSha256, timestamp: NaN }),
    ).toThrow(/malformed/);
  });
  it('authenticates legacy indexes only after an initial v2 endpoint 404 and advances state explicitly', async () => {
    const { repo, advance } = service();
    const fetcher = stubV1({ repo: { timestamp: now }, packages: { 'org.example.app': [row] } });
    vi.stubGlobal('fetch', fetcher);
    const index = await repo.index(repository, { readOnly: true });
    expect(index.evidence.format).toBe('v1');
    expect(advance).not.toHaveBeenCalled();
    const artifact = repo.candidate(index, 'org.example.app', { sdk: 35, abis: ['arm64-v8a'] });
    expect(artifact.versionCode).toBe(7);
    expect(artifact.redirectHosts).toEqual(['cdn.example']);
    expect(artifact).not.toHaveProperty('compatibility');
    await repo.validateEvidence(repository, index.evidence, true);
    expect(advance).toHaveBeenCalledOnce();
    await expect(
      repo.validateEvidence(repository, { ...index.evidence, signerSha256: 'd'.repeat(64) }),
    ).rejects.toThrow(/identity changed/);
    await repo.index(repository);
    expect(advance).toHaveBeenCalledTimes(2);
  });
  it('checks v2 signed descriptor hashes and byte sizes before parsing a full index', async () => {
    const { repo } = service();
    const full = JSON.stringify({
      repo: { timestamp: now },
      packages: {
        'org.example.app': {
          versions: {
            v7: {
              file: { name: '/org.example.app_7.apk', sha256: row.hash, size: 500 },
              manifest: {
                versionCode: 7,
                signer: { sha256: [row.signer] },
                usesSdk: { minSdkVersion: 28 },
                nativecode: ['arm64-v8a'],
              },
            },
          },
        },
      },
    });
    const entry = {
      version: 20002,
      timestamp: now,
      index: {
        name: '/index-v2.json',
        size: Buffer.byteLength(full),
        sha256: createHash('sha256').update(full).digest('hex'),
      },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(new Response(url.pathname.endsWith('/entry.jar') ? JSON.stringify(entry) : full)),
        ),
    );
    const index = await repo.index(repository);
    expect(index.evidence.format).toBe('v2');
    expect(repo.candidate(index, 'org.example.app', { sdk: 35, abis: ['arm64-v8a'] }).versionCode).toBe(7);
    entry.index.sha256 = '0'.repeat(64);
    await expect(repo.index(repository)).rejects.toThrow(/signed size and SHA-256/);
  });
  it('rejects authenticated duplicate JSON keys, unsupported entry schemas and inconsistent timestamps', async () => {
    const { repo } = service();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(
            url.pathname.endsWith('/entry.jar')
              ? new Response(null, { status: 404 })
              : new Response('{"repo":{"timestamp":1800000000000},"packages":{},"packages":{}}'),
          ),
        ),
    );
    await expect(repo.index(repository)).rejects.toThrow(/unique|Map keys|Duplicate/i);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"version":30000}')));
    await expect(repo.index(repository)).rejects.toThrow(/Unsupported/);
    const full = JSON.stringify({ repo: { timestamp: now }, packages: {} });
    const entry = {
      version: 20002,
      timestamp: now - 1,
      index: {
        name: '/index-v2.json',
        size: full.length,
        sha256: createHash('sha256').update(full).digest('hex'),
      },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(new Response(url.pathname.endsWith('/entry.jar') ? JSON.stringify(entry) : full)),
        ),
    );
    await expect(repo.index(repository)).rejects.toThrow(/timestamps disagree/);
  });
  it('filters SDK/ABI versions and rejects ambiguous same-version artifact identities', () => {
    const { repo } = service();
    const packages = repo.normalize(
      repository,
      {
        'org.example.app': [
          row,
          { ...row, versionCode: 8, minSdkVersion: 36 },
          { ...row, versionCode: 9, nativecode: ['x86_64'] },
        ],
      },
      false,
    );
    const evidence: RepositoryEvidence = {
      url: repository.url,
      signerSha256: repository.signerSha256,
      timestamp: now,
      entrySha256: 'd'.repeat(64),
      indexSha256: 'e'.repeat(64),
      format: 'v1',
      maxAgeDays: 30,
    };
    const index = { packages, evidence };
    expect(repo.candidate(index, 'org.example.app', { sdk: 35, abis: ['arm64-v8a'] }).versionCode).toBe(7);
    expect(() => repo.candidate(index, 'org.example.app', { sdk: 26, abis: ['arm64-v8a'] })).toThrow(
      /no matching/,
    );
    expect(() => repo.candidate(index, 'org.example.app', { sdk: 35, abis: [] })).toThrow(/ABI observations/);
    const conflicting = repo.normalize(
      repository,
      { 'org.example.app': [row, { ...row, hash: 'f'.repeat(64) }] },
      false,
    );
    expect(() =>
      repo.candidate({ packages: conflicting, evidence }, 'org.example.app', {
        sdk: 35,
        abis: ['arm64-v8a'],
      }),
    ).toThrow(/conflicting/);
    expect(() =>
      repo.normalize(repository, { 'org.example.app': [{ ...row, hashType: 'md5' }] }, false),
    ).toThrow(/SHA-256/);
    expect(() =>
      repo.normalize(repository, { 'org.example.app': [{ ...row, signer: undefined }] }, false),
    ).toThrow(/signer/);
  });
});

it('rejects malformed authenticated SDK ranges and ABI lists rather than selecting incompatible packages', () => {
  const { repo } = service();
  for (const change of [
    { maxSdkVersion: 27 },
    { minSdkVersion: 0 },
    { nativecode: 'arm64-v8a' },
    { nativecode: ['bad ABI'] },
  ])
    expect(() => repo.normalize(repository, { 'org.example.app': [{ ...row, ...change }] }, false)).toThrow();
  expect(() => repo.normalize(repository, { 'org.example.app': {} }, false)).toThrow(/APK list/);
  const normalized = repo.normalize(
    { ...repository, redirectHosts: [] },
    { 'org.example.app': [{ ...row, maxSdkVersion: 35 }] },
    false,
  );
  const app = normalized['org.example.app']?.[0];
  expect(app?.compatibility.maxSdk).toBe(35);
  expect(app).not.toHaveProperty('redirectHosts');
});

it('selects exact versions, enforces maximum SDK, and permits ABI-independent packages', () => {
  const { repo } = service();
  const packages = repo.normalize(
    repository,
    {
      'org.example.app': [
        row,
        { ...row, versionCode: 8, maxSdkVersion: 34 },
        { ...row, versionCode: 9, nativecode: [] },
      ],
    },
    false,
  );
  const evidence: RepositoryEvidence = {
    url: repository.url,
    signerSha256: repository.signerSha256,
    timestamp: now,
    entrySha256: 'd'.repeat(64),
    indexSha256: 'e'.repeat(64),
    format: 'v1',
    maxAgeDays: 30,
  };
  const index = { packages, evidence };
  const device = { sdk: 35, abis: ['arm64-v8a'] };
  expect(repo.candidate(index, 'org.example.app', device).versionCode).toBe(9);
  expect(repo.candidate(index, 'org.example.app', { ...device, versionCode: 7 }).versionCode).toBe(7);
  expect(
    repo.candidate(index, 'org.example.app', { sdk: 34, abis: ['arm64-v8a'], versionCode: 8 }).versionCode,
  ).toBe(8);
  for (const versionCode of [8, 10])
    expect(() => repo.candidate(index, 'org.example.app', { ...device, versionCode })).toThrow(/no matching/);
  expect(() => repo.candidate(index, 'org.example.absent', device)).toThrow(/no matching/);
  expect(() => repo.candidate(index, 'org.example.app', { ...device, sdk: 0 })).toThrow(/SDK/);
  expect(repo.candidate(index, 'org.example.app', { sdk: 35, abis: ['x86_64'] }).versionCode).toBe(9);
});

it('rejects malformed and ambiguous authenticated v2 signers and malformed SDK/ABI metadata', () => {
  const { repo } = service();
  const manifest = { versionCode: 7, signer: { sha256: [row.signer] } };
  const version = { file: { name: '/app.apk', sha256: row.hash, size: 500 }, manifest };
  const normalize = (value: unknown) =>
    repo.normalize(
      repository,
      {
        'org.example.app': { versions: { v7: value } },
      },
      true,
    );
  for (const signers of [undefined, [], [row.signer, 'd'.repeat(64)], [42], ['bad pin']])
    expect(() => normalize({ ...version, manifest: { ...manifest, signer: { sha256: signers } } })).toThrow(
      /signer|SHA-256/,
    );
  for (const change of [
    { usesSdk: { minSdkVersion: 0 } },
    { usesSdk: { minSdkVersion: 30, maxSdkVersion: 29 } },
    { nativecode: 'arm64-v8a' },
    { nativecode: ['bad ABI'] },
  ])
    expect(() => normalize({ ...version, manifest: { ...manifest, ...change } })).toThrow();
  expect(normalize(version)['org.example.app']?.[0]?.compatibility).toEqual({ minSdk: 1, abis: [] });
});
