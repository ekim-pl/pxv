import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactService,
  parseApkCompatibility,
  packageId,
  sha256Pin,
  shellQuote,
  type CommandRunner,
} from '../../packages/adapters/src/index.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-apk-edges-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
function runner(
  badging: string,
  signers = `Signer #1 certificate SHA-256 digest: ${'b'.repeat(64)}\n`,
): CommandRunner {
  return {
    run: (args) =>
      Promise.resolve({ code: 0, stdout: args.includes('badging') ? badging : signers, stderr: '' }),
  };
}
describe('strict APK identity and compatibility failures', () => {
  it('rejects malformed and future SDK declarations, duplicate metadata and incompatible ABIs', async () => {
    expect(
      parseApkCompatibility("sdkVersion:'28'\nmaxSdkVersion:'35'\nnative-code: 'arm64-v8a' 'x86_64'\n"),
    ).toEqual({ minSdk: 28, maxSdk: 35, abis: ['arm64-v8a', 'x86_64'] });
    for (const malformed of [
      "sdkVersion:'Preview'",
      "sdkVersion:'28'\nsdkVersion:'29'",
      "sdkVersion:'35'\nmaxSdkVersion:'28'",
      "sdkVersion:'0'",
      'native-code: unquoted',
      "native-code: 'arm64-v8a'\nnative-code: 'x86_64'",
    ])
      expect(() => parseApkCompatibility(malformed)).toThrow();
    const service = new ArtifactService({
      runner: runner("sdkVersion:'28'\nmaxSdkVersion:'35'\nnative-code: 'arm64-v8a'\n"),
    });
    await expect(service.checkCompatibility('/fixture.apk', 36, ['arm64-v8a'])).rejects.toThrow(
      /incompatible/,
    );
    await expect(service.checkCompatibility('/fixture.apk', 35, ['x86_64'])).rejects.toThrow(/incompatible/);
    await expect(service.checkCompatibility('/fixture.apk', 35, [])).rejects.toThrow(/observations/);
  });
  it('requires exactly one verified package and signer and a positive safe version', async () => {
    const path = join(directory, 'fixture.apk');
    await writeFile(path, 'signed-byte-fixture');
    for (const badging of [
      '',
      "package: name='org.example.app' versionCode='0'",
      "package: name='org.example.app' versionCode='999999999999999999999999'",
      "package: name='org.example.app' versionCode='1'\npackage: name='org.example.app' versionCode='2'",
    ])
      await expect(new ArtifactService({ runner: runner(badging) }).identity(path)).rejects.toThrow();
    const badging = "package: name='org.example.app' versionCode='1'";
    await expect(new ArtifactService({ runner: runner(badging, '') }).identity(path)).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      new ArtifactService({
        runner: runner(
          badging,
          `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\nSigner #2 certificate SHA-256 digest: ${'b'.repeat(64)}\n`,
        ),
      }).identity(path),
    ).rejects.toThrow(/exactly one/);
  });
  it('downloads only explicit approved sources, verifies bytes and removes failed snapshots', async () => {
    const data = 'apk bytes';
    const policy = {
      packageId: 'org.example.app',
      versionCode: 1,
      signerSha256: 'b'.repeat(64),
      sha256: createHash('sha256').update(data).digest('hex'),
      url: 'https://example.com/app.apk',
      redirectHosts: ['cdn.example'],
    };
    const service = new ArtifactService({
      runner: runner("package: name='org.example.app' versionCode='1'"),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response(data))),
    );
    const destination = join(directory, 'download.apk');
    expect((await service.snapshot(policy, destination)).sha256).toBe(policy.sha256);
    await expect(
      service.snapshot({ ...policy, sha256: '0'.repeat(64) }, join(directory, 'failed.apk')),
    ).rejects.toThrow(/SHA-256/);
    await expect(readFile(join(directory, 'failed.apk'))).rejects.toThrow();
    await expect(
      service.snapshot({ ...policy, path: destination }, join(directory, 'two-sources.apk')),
    ).rejects.toThrow(/exactly one/);
    await expect(
      service.snapshot(
        { ...policy, url: undefined } as unknown as typeof policy,
        join(directory, 'no-source.apk'),
      ),
    ).rejects.toThrow(/exactly one/);
  });
  it('validates shell arguments and digest/package pins before execution', () => {
    expect(shellQuote("x'y")).toBe("'x'\\''y'");
    for (const text of ['a\nb', 'a\rb', 'a\0b']) expect(() => shellQuote(text)).toThrow(/Unsafe/);
    expect(() => sha256Pin('bad')).toThrow(/SHA-256/);
    expect(() => packageId('bad package')).toThrow(/package ID/);
  });
});
