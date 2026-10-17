import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  ArtifactService,
  ImageService,
  RepositoryService,
  copySnapshot,
  fileDigest,
  extractZip,
  type CommandRunner,
  type RepositoryFloor,
} from '../../packages/adapters/src/index.js';
import type { ArtifactPolicy, OsPolicy } from '@pxv/contracts';

const native: CommandRunner = {
  run: async (args, options = {}) => {
    if (options.mutation) throw new Error('Crypto fixtures must never change devices');
    const executable = args[0];
    if (!executable) throw new Error('No executable');
    return new Promise((resolveResult, reject) => {
      const child = spawn(executable, args.slice(1), {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const input = options.inputFile ? createReadStream(options.inputFile) : undefined;
      let brokenPipe: Error | undefined;
      const fail = (error: Error) => {
        input?.destroy();
        child.stdin.destroy();
        child.kill();
        reject(error);
      };
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', fail);
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        input?.destroy();
        if (error.code === 'EPIPE') brokenPipe = error;
        else fail(error);
      });
      input?.once('error', fail);
      child.once('close', (code) => {
        input?.destroy();
        if (brokenPipe && code === 0) reject(brokenPipe);
        else
          resolveResult({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          });
      });
      if (input) input.pipe(child.stdin);
      else child.stdin.end(options.input);
    });
  },
};
async function run(args: string[]): Promise<string> {
  const result = await native.run(args);
  if (result.code) throw new Error(`Fixture command failed: ${args[0]}: ${result.stderr}`);
  return result.stdout;
}
let directory: string;
let apkPolicy: ArtifactPolicy;
let artifacts: ArtifactService;
let repo: RepositoryService;
let signedJar: string;
let signer: string;
let os: OsPolicy;
let image: string;
let signature: string;
let apkAvailable = false;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-crypto-fixtures-'));
  const keyStore = join(directory, 'fixture.p12');
  await run([
    'keytool',
    '-genkeypair',
    '-alias',
    'fixture',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '30',
    '-dname',
    'CN=pxv test fixture',
    '-keystore',
    keyStore,
    '-storepass',
    'fixture-only',
    '-keypass',
    'fixture-only',
    '-storetype',
    'PKCS12',
    '-noprompt',
  ]);
  const certificate = await run([
    'keytool',
    '-exportcert',
    '-rfc',
    '-alias',
    'fixture',
    '-keystore',
    keyStore,
    '-storepass',
    'fixture-only',
  ]);
  signer = new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
  const indexDirectory = join(directory, 'repo');
  await mkdir(indexDirectory);
  await writeFile(
    join(indexDirectory, 'index-v1.json'),
    JSON.stringify({ repo: { timestamp: Date.now() }, packages: {} }),
  );
  signedJar = join(directory, 'index-v1.jar');
  await run(['jar', '--create', '--file', signedJar, '-C', indexDirectory, 'index-v1.json']);
  await run(['jarsigner', '-keystore', keyStore, '-storepass', 'fixture-only', signedJar, 'fixture']);
  const floors = new Map<string, RepositoryFloor>();
  repo = new RepositoryService({
    runner: native,
    verifierPath: resolve('resources/VerifyRepositoryIndex.java'),
    freshness: {
      read: (key) => Promise.resolve(floors.get(key)),
      advance: (key, old, next) => {
        if (JSON.stringify(floors.get(key)) !== JSON.stringify(old)) throw new Error('Floor changed');
        floors.set(key, next);
        return Promise.resolve();
      },
    },
  });
  const key = join(directory, 'ssh-key');
  await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  image = join(directory, 'factory.zip');
  await writeFile(image, 'authenticated local image fixture');
  await run(['ssh-keygen', '-Y', 'sign', '-f', key, '-n', 'factory images', image]);
  signature = `${image}.sig`;
  os = {
    codename: 'akita',
    release: '2026100600',
    url: 'https://releases.grapheneos.org/akita-install-2026100600.zip',
    signatureUrl: 'https://releases.grapheneos.org/akita-install-2026100600.zip.sig',
    signerPrincipal: 'contact@grapheneos.org',
    namespace: 'factory images',
    publicKey: (await readFile(`${key}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' '),
  };
  const sdk =
    process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? join(homedir(), 'Android/Sdk');
  const tools = process.env['PXV_BUILD_TOOLS'] ?? join(sdk, 'build-tools', '35.0.0');
  const aapt = join(tools, 'aapt');
  const apksigner = join(tools, 'apksigner');
  try {
    await access(aapt);
    await access(apksigner);
    await access(join(sdk, 'platforms/android-35/android.jar'));
    apkAvailable = true;
  } catch {
    if (process.env['PXV_SKIP_ANDROID_CRYPTO'] !== '1' || process.env['PXV_REQUIRE_CRYPTO'] === '1')
      throw new Error('Required real APK crypto tests need Android 35 SDK and Build Tools 35.0.0');
  }
  artifacts = new ArtifactService({ runner: native, aapt, apksigner });
  if (apkAvailable) {
    const manifest = join(directory, 'AndroidManifest.xml');
    await writeFile(
      manifest,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.pxv.fixture" android:versionCode="7" android:versionName="7"><uses-sdk android:minSdkVersion="28" android:targetSdkVersion="35"/><application android:hasCode="false" android:label="fixture"/></manifest>',
    );
    const unsigned = join(directory, 'unsigned.apk');
    const signed = join(directory, 'fixture.apk');
    await run([
      aapt,
      'package',
      '-f',
      '-M',
      manifest,
      '-I',
      join(sdk, 'platforms/android-35/android.jar'),
      '-F',
      unsigned,
    ]);
    await run([
      apksigner,
      'sign',
      '--ks',
      keyStore,
      '--ks-pass',
      'pass:fixture-only',
      '--out',
      signed,
      unsigned,
    ]);
    apkPolicy = {
      packageId: 'org.pxv.fixture',
      versionCode: 7,
      sha256: createHash('sha256')
        .update(await readFile(signed))
        .digest('hex'),
      signerSha256: signer,
      path: signed,
    };
  }
}, 60_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());
describe('real cryptographic artifact checks', () => {
  it('retains verifier refusal when the child exits before consuming streamed input', async () => {
    const inputFile = join(directory, 'early-exit-input');
    await writeFile(inputFile, Buffer.alloc(8 * 1024 * 1024));
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await native.run([process.execPath, '-e', 'process.exit(7)'], { inputFile });
      expect(result.code).toBe(7);
    }
  });
  it('propagates input-read and spawn failures while stopping the child and its streams', async () => {
    await expect(
      native.run([process.execPath, '-e', 'process.stdin.resume()'], {
        inputFile: join(directory, 'missing-input'),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      native.run([join(directory, 'missing-executable')], { inputFile: image }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('shares authenticated OS bytes across plans and revalidates corrupt retained signatures', async () => {
    const imageBytes = await readFile(image);
    const signatureBytes = await readFile(signature);
    const fetch = vi
      .fn()
      .mockImplementation((url: URL) =>
        Promise.resolve(new Response(url.pathname.endsWith('.sig') ? signatureBytes : imageBytes)),
      );
    vi.stubGlobal('fetch', fetch);
    const service = new ImageService({ runner: native, cacheRoot: join(directory, 'os-cache') });
    const [first, second] = await Promise.all([
      service.snapshot(os, join(directory, 'cached-plan-one/os')),
      service.snapshot(os, join(directory, 'cached-plan-two/os')),
    ]);
    const third = await service.snapshot(os, join(directory, 'cached-plan-three/os'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await stat(first.path)).ino).toBe((await stat(second.path)).ino);
    expect((await stat(first.signaturePath)).ino).toBe((await stat(third.signaturePath)).ino);
    await expect(service.snapshot(os, join(directory, 'cached-plan-one/os'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(first.path)).toEqual(imageBytes);
    await chmod(second.signaturePath, 0o600);
    await writeFile(second.signaturePath, 'changed signature');
    await expect(service.snapshot(os, join(directory, 'cached-plan-four/os'))).rejects.toThrow(
      /signature verification/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(stat(join(directory, 'cached-plan-four/os'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('downloads and seals an immutable authenticated OS pair and removes failed snapshots', async () => {
    const imageBytes = await readFile(image);
    const signatureBytes = await readFile(signature);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(new Response(url.pathname.endsWith('.sig') ? signatureBytes : imageBytes)),
        ),
    );
    const service = new ImageService({ runner: native });
    const snapshot = await service.snapshot(os, join(directory, 'nested-plan', 'os', 'image-snapshot'));
    expect(snapshot.sha256).toBe(createHash('sha256').update(imageBytes).digest('hex'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(
            new Response(url.pathname.endsWith('.sig') ? Buffer.from('bad signature') : imageBytes),
          ),
        ),
    );
    await expect(service.snapshot(os, join(directory, 'bad-image-snapshot'))).rejects.toThrow(
      /signature verification/,
    );
    await expect(readFile(join(directory, 'bad-image-snapshot', 'factory.zip'))).rejects.toThrow();
  });
  it('authenticates the actual signed JAR entry with the retained Java verifier', async () => {
    const value = await repo.verifyJar(signedJar, signer, 'index-v1.json');
    expect(value['packages']).toEqual({});
    await expect(repo.verifyJar(signedJar, '0'.repeat(64), 'index-v1.json')).rejects.toThrow(
      /authentication/,
    );
  });
  it('rejects a tampered JAR even though the original signature files remain', async () => {
    const tampered = join(directory, 'tampered.jar');
    await writeFile(tampered, await readFile(signedJar));
    const changes = join(directory, 'tamper');
    await mkdir(changes);
    await writeFile(join(changes, 'index-v1.json'), '{"repo":{"timestamp":1},"packages":{}}');
    await run(['jar', '--update', '--file', tampered, '-C', changes, 'index-v1.json']);
    await expect(repo.verifyJar(tampered, signer, 'index-v1.json')).rejects.toThrow(/authentication/);
  });
  it('verifies SSH image signatures and fails changed images and wrong keys', async () => {
    const service = new ImageService({ runner: native });
    const verified = await service.verify(image, signature, os);
    expect(verified.sha256).toHaveLength(64);
    const tampered = join(directory, 'tampered-image.zip');
    await writeFile(tampered, 'different bytes');
    await expect(service.verify(tampered, signature, os)).rejects.toThrow(/signature verification/);
    const other = join(directory, 'wrong-key');
    await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const publicKey = (await readFile(`${other}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    await expect(service.verify(image, signature, { ...os, publicKey })).rejects.toThrow(
      /signature verification/,
    );
    await expect(service.verify(image, signature, { ...os, signerPrincipal: '*' })).rejects.toThrow(
      /exact official/,
    );
    await expect(
      service.verify(image, signature, { ...os, url: 'https://example.com/image.zip' }),
    ).rejects.toThrow(/official GrapheneOS/);
    await expect(service.verify(image, signature, { ...os, namespace: 'other' })).rejects.toThrow(
      /exact official/,
    );
    await expect(service.verify(image, signature, { ...os, publicKey: 'ssh-ed25519 Zm9v' })).rejects.toThrow(
      /malformed/,
    );
    await expect(
      service.verify(image, signature, { ...os, publicKey: 'ssh-ed25519 bad key with options' }),
    ).rejects.toThrow(/pinned plain/);
    await expect(service.verify(image, signature, { ...os, release: 'invalid' })).rejects.toThrow(
      /release identity/,
    );
    await expect(service.verify(image, signature, { ...os, codename: 'other' })).rejects.toThrow(
      /URLs do not match/,
    );
  });
  it('verifies real APK package, version, bytes and signing certificate', async (context) => {
    if (!apkAvailable) {
      context.skip();
      return;
    }
    const verified = await artifacts.inspect(apkPolicy.path ?? '', apkPolicy);
    expect(verified.versionCode).toBe(7);
    expect(verified.signerSha256).toBe(signer);
    await artifacts.checkCompatibility(apkPolicy.path ?? '', 35, ['arm64-v8a']);
    await expect(artifacts.checkCompatibility(apkPolicy.path ?? '', 27, ['arm64-v8a'])).rejects.toThrow(
      /incompatible/,
    );
    await expect(
      artifacts.inspect(apkPolicy.path ?? '', { ...apkPolicy, signerSha256: 'c'.repeat(64) }),
    ).rejects.toThrow(/signer/);
    await expect(artifacts.inspect(apkPolicy.path ?? '', { ...apkPolicy, versionCode: 8 })).rejects.toThrow(
      /version/,
    );
    await expect(
      artifacts.inspect(apkPolicy.path ?? '', { ...apkPolicy, packageId: 'org.wrong.app' }),
    ).rejects.toThrow(/package/);
    await expect(
      artifacts.inspect(apkPolicy.path ?? '', { ...apkPolicy, sha256: 'c'.repeat(64) }),
    ).rejects.toThrow(/SHA-256/);
  });
  it('stages immutable APK snapshots and rejects reused or changed sources', async (context) => {
    if (!apkAvailable) {
      context.skip();
      return;
    }
    const destination = join(directory, 'snapshot.apk');
    const snapshot = await artifacts.snapshot(apkPolicy, destination);
    await expect(artifacts.snapshot(apkPolicy, destination)).rejects.toThrow();
    expect(await readFile(destination)).toEqual(await readFile(apkPolicy.path ?? ''));
    await artifacts.withStaged(snapshot, (staged) => {
      expect(staged.path).not.toBe(snapshot.path);
      expect(staged.sha256).toBe(apkPolicy.sha256);
      return Promise.resolve();
    });
    await chmod(destination, 0o600);
    await writeFile(destination, 'changed');
    await expect(artifacts.withStaged(snapshot, () => Promise.resolve())).rejects.toThrow(/SHA-256/);
  });
  it('refuses local symlinks and never overwrites an existing snapshot', async () => {
    const source = join(directory, 'source');
    await writeFile(source, 'original');
    const link = join(directory, 'source-link');
    await symlink(source, link);
    await expect(copySnapshot(link, join(directory, 'link-copy'), 128)).rejects.toThrow(/regular file/);
    const destination = join(directory, 'existing');
    await writeFile(destination, 'preserve');
    await expect(copySnapshot(source, destination, 128)).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('preserve');
    await expect(fileDigest(source, 2)).rejects.toThrow(/size limit/);
  });
  it('safely extracts regular ZIP entries and rejects symlink archives', async () => {
    const input = join(directory, 'zip-input');
    await mkdir(input);
    await writeFile(join(input, 'flash-all.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(input, 'flash-all.sh'), 0o700);
    const archive = join(directory, 'safe.zip');
    await run(['zip', '-q', '-j', archive, join(input, 'flash-all.sh')]);
    const destination = join(directory, 'extracted');
    const entries = await extractZip(archive, destination);
    expect(entries[0]?.name).toBe('flash-all.sh');
    expect(await readFile(join(destination, 'flash-all.sh'), 'utf8')).toContain('exit 0');
    await expect(extractZip(archive, destination)).rejects.toThrow();
    await symlink('/tmp', join(input, 'unsafe'));
    const unsafe = join(directory, 'unsafe.zip');
    await run(['zip', '-q', '-y', '-j', unsafe, join(input, 'unsafe')]);
    await expect(extractZip(unsafe, join(directory, 'unsafe-extracted'))).rejects.toThrow(/links/);
    await expect(
      extractZip(archive, join(directory, 'small-extracted'), { maxTotalBytes: 1 }),
    ).rejects.toThrow(/limits/);
  });
});
