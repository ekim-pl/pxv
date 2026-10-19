import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, type ArtifactPolicy } from '@pxv/contracts';
import { afterEach, beforeEach, expect, it, vi } from '../test-api.js';
import { device, hashA } from '../contracts/fixtures.js';
import {
  artifactFixture,
  evidence,
  repository,
  reviewed,
  type AcquisitionFailure,
} from './artifact-port-fixture.js';

const target = { device, transport: device.transports[0]! };
let fixture: Awaited<ReturnType<typeof artifactFixture>>;
beforeEach(async () => {
  fixture = await artifactFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});
const acquire = (artifact = reviewed, signal?: AbortSignal) =>
  fixture.port.snapshot(artifact, fixture.destination, signal, target);

it('authenticates and selects measured SDK/ABIs before exact-version fdroidcl download and verification', async () => {
  const signal = new AbortController().signal;
  const result = await acquire(reviewed, signal);
  expect(result.path).toBe(fixture.destination);
  expect(fixture.state.order).toEqual(['index', 'candidate', 'update', 'download', 'verify', 'store']);
  expect(fixture.requireTool.mock.calls.map(([name]) => name)).toEqual([
    'aapt',
    'apksigner',
    'java',
    'fdroidcl',
  ]);
  const official = {
    id: 'fdroid-official',
    url: 'https://f-droid.org/repo',
    signerSha256: '43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab',
    maxAgeDays: 30,
    redirectHosts: [],
  };
  expect(fixture.index).toHaveBeenCalledExactlyOnceWith(official, { signal });
  expect(fixture.candidate).toHaveBeenCalledExactlyOnceWith({ evidence, packages: {} }, reviewed.packageId, {
    sdk: 35,
    abis: ['arm64-v8a', 'armeabi-v7a'],
    versionCode: 42,
  });
  expect(fixture.shell.mock.calls.map(([, args, options]) => ({ args, options }))).toEqual([
    { args: ['getprop', 'ro.build.version.sdk'], options: { signal } },
    { args: ['getprop', 'ro.product.cpu.abilist'], options: { signal } },
  ]);
  expect(fixture.run.mock.calls.map(([args]) => args)).toEqual([
    ['/tools/fdroidcl', 'update'],
    ['/tools/fdroidcl', 'download', 'org.example.app:42'],
  ]);
  for (const [, options] of fixture.run.mock.calls) {
    expect(options).toMatchObject({ cwd: fixture.state.acquisitionRoot, timeoutMs: 600_000, signal });
    expect(options?.env).toMatchObject({
      XDG_CACHE_HOME: join(fixture.state.acquisitionRoot, 'cache'),
      XDG_CONFIG_HOME: join(fixture.state.acquisitionRoot, 'config'),
      PATH: process.env['PATH'],
    });
    expect(options?.env).not.toBe(process.env);
  }
  expect(fixture.snapshot).toHaveBeenCalledExactlyOnceWith(
    {
      packageId: reviewed.packageId,
      versionCode: 42,
      sha256: reviewed.sha256,
      signerSha256: reviewed.signerSha256,
      path: join(fixture.state.acquisitionRoot, 'cache/fdroidcl/app.apk'),
    },
    fixture.destination,
    signal,
  );
  expect(fixture.set).toHaveBeenCalledExactlyOnceWith('artifact-provenance', digest(fixture.destination), {
    repository: official,
    evidence,
  });
  await expect(access(fixture.state.acquisitionRoot)).rejects.toThrow();
});

it('writes a private official-only configuration before either command', async () => {
  const original = fixture.run.getMockImplementation()!;
  fixture.run.mockImplementation(async (args, options) => {
    expect(await readFile(join(options!.env!['XDG_CONFIG_HOME']!, 'fdroidcl/config.toml'), 'utf8')).toBe(
      '[[repos]]\nid = "f-droid"\nurl = "https://f-droid.org/repo"\nenabled = true\n',
    );
    return original(args, options);
  });
  await acquire();
  expect(fixture.index.mock.calls[0]?.[1]).toEqual({});
});

for (const failure of [
  'update',
  'download',
  'missing-location',
  'ambiguous-location',
  'missing-file',
  'outside',
  'cache-itself',
  'symlink-escape',
  'verify',
  'store',
] satisfies AcquisitionFailure[]) {
  it(`removes isolated acquisition files after ${failure} failure`, async () => {
    fixture.state.failure = failure;
    await expect(acquire()).rejects.toThrow();
    expect(fixture.state.acquisitionRoot).not.toBe('');
    await expect(access(fixture.state.acquisitionRoot)).rejects.toThrow();
    if (failure !== 'store') expect(fixture.set).not.toHaveBeenCalled();
    if (!['verify', 'store'].includes(failure)) expect(fixture.snapshot).not.toHaveBeenCalled();
    if (failure === 'update') expect(fixture.run).toHaveBeenCalledTimes(1);
  });
}

it('cleans up when the runner rejects on cancellation', async () => {
  const controller = new AbortController();
  fixture.run.mockImplementation((_args, options) => {
    fixture.state.acquisitionRoot = options!.cwd!;
    expect(options?.signal).toBe(controller.signal);
    controller.abort();
    return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  });
  await expect(acquire(reviewed, controller.signal)).rejects.toThrow();
  await expect(access(fixture.state.acquisitionRoot)).rejects.toThrow();
  expect(fixture.snapshot).not.toHaveBeenCalled();
});

it('cleans up after a supervised command timeout without verification or provenance', async () => {
  fixture.run.mockImplementation((_args, options) => {
    fixture.state.acquisitionRoot = options!.cwd!;
    expect(options?.timeoutMs).toBe(600_000);
    return Promise.reject(new Error('Command timed out'));
  });
  await expect(acquire()).rejects.toThrow('timed out');
  await expect(access(fixture.state.acquisitionRoot)).rejects.toThrow();
  expect(fixture.snapshot).not.toHaveBeenCalled();
  expect(fixture.set).not.toHaveBeenCalled();
});

for (const mismatch of ['sha256', 'signerSha256', 'url'] as const) {
  it(`rejects authenticated candidate ${mismatch} mismatch before download`, async () => {
    fixture.candidate.mockReturnValue({
      ...reviewed,
      url: 'https://example.test/a.apk',
      [mismatch]: mismatch === 'url' ? '' : 'f'.repeat(64),
    });
    await expect(acquire()).rejects.toThrow();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
}
it('requires a measured target and a known repository', async () => {
  await expect(fixture.port.snapshot(reviewed, fixture.destination)).rejects.toThrow('measured target');
  await expect(
    acquire({
      packageId: reviewed.packageId,
      versionCode: 42,
      sha256: reviewed.sha256,
      signerSha256: reviewed.signerSha256,
      repositoryId: 'missing',
    }),
  ).rejects.toThrow('Unknown');
  expect(fixture.index).not.toHaveBeenCalled();
});

for (const kind of ['direct', 'project', 'inline', 'named'] as const) {
  it(`dispatches ${kind} acquisition through the verifier`, async () => {
    const pins = {
      packageId: reviewed.packageId,
      versionCode: 42,
      sha256: reviewed.sha256,
      signerSha256: reviewed.signerSha256,
    };
    const artifact: ArtifactPolicy =
      kind === 'direct'
        ? {
            ...pins,
            source: {
              kind: 'direct',
              url: 'https://example.test/direct.apk',
              redirectHosts: ['cdn.example.test'],
            },
          }
        : kind === 'project'
          ? { ...pins, path: 'app.apk' }
          : kind === 'named'
            ? { ...pins, repositoryId: repository.id }
            : {
                ...pins,
                source: {
                  kind: 'fdroid-repository',
                  url: repository.url,
                  fingerprint: repository.signerSha256,
                },
              };
    await writeFile(join(fixture.deps.project.root, 'app.apk'), 'synthetic APK');
    await acquire(artifact);
    const acquisition = fixture.snapshot.mock.calls[0]![0];
    expect(acquisition).toEqual(
      kind === 'project'
        ? { ...pins, path: join(fixture.deps.project.root, 'app.apk') }
        : {
            ...pins,
            url: kind === 'direct' ? 'https://example.test/direct.apk' : 'https://example.test/repo/app.apk',
            redirectHosts: ['cdn.example.test'],
          },
    );
    expect(fixture.run).not.toHaveBeenCalled();
    if (kind === 'direct' || kind === 'project') {
      expect(fixture.index).not.toHaveBeenCalled();
      expect(fixture.set).not.toHaveBeenCalled();
    } else {
      const selected = fixture.index.mock.calls[0]![0];
      expect(selected).toEqual(
        kind === 'named'
          ? repository
          : {
              id: `inline-${digest({ url: repository.url, fingerprint: repository.signerSha256 }).slice(0, 32)}`,
              url: repository.url,
              signerSha256: repository.signerSha256,
              maxAgeDays: 30,
              redirectHosts: [],
            },
      );
      expect(fixture.set).toHaveBeenCalledExactlyOnceWith(
        'artifact-provenance',
        digest(fixture.destination),
        { repository: selected, evidence },
      );
    }
  });
}
for (const legacy of [false, true]) {
  it(`revalidates ${legacy ? 'legacy' : 'current'} provenance against policy`, async () => {
    vi.spyOn(fixture.deps.store, 'get').mockResolvedValue(legacy ? evidence : { repository, evidence });
    await fixture.port.validateBeforeExecution!(
      { ...reviewed, path: fixture.destination, repositoryId: repository.id },
      target,
    );
    expect(fixture.validate).toHaveBeenCalledExactlyOnceWith(repository, evidence);
  });
}
for (const failure of [
  'changed-repository',
  'missing-policy',
  'missing-evidence',
  'legacy-direct',
] as const) {
  it(`rejects ${failure} provenance before execution`, async () => {
    vi.spyOn(fixture.deps.store, 'get').mockResolvedValue(
      failure === 'missing-evidence'
        ? undefined
        : failure === 'legacy-direct'
          ? evidence
          : { repository: { ...repository, maxAgeDays: 99 }, evidence },
    );
    await expect(
      fixture.port.validateBeforeExecution!(
        {
          ...reviewed,
          path: fixture.destination,
          ...(failure === 'legacy-direct'
            ? {}
            : { repositoryId: failure === 'missing-policy' ? 'missing' : repository.id }),
        },
        target,
      ),
    ).rejects.toThrow();
    expect(fixture.validate).not.toHaveBeenCalled();
  });
}
it('validates retained inline evidence and leaves untracked direct artifacts alone', async () => {
  const get = vi.spyOn(fixture.deps.store, 'get').mockResolvedValue({ repository, evidence });
  await fixture.port.validateBeforeExecution!({ ...reviewed, path: fixture.destination }, target);
  expect(fixture.validate).toHaveBeenCalledExactlyOnceWith(repository, evidence);
  fixture.validate.mockClear();
  get.mockResolvedValue(undefined);
  await fixture.port.validateBeforeExecution!({ ...reviewed, path: fixture.destination }, target);
  await fixture.port.validateBeforeExecution!({ ...reviewed, sha256: hashA }, target);
  expect(fixture.validate).not.toHaveBeenCalled();
});
