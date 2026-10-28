import { parseApkCompatibility } from './apk-compatibility.js';
import type { ArtifactPolicy } from '@pxv/contracts';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError, checked, packageId, sha256Pin, type CommandRunner } from './command.js';
import { copySnapshot, download, fileDigest, regularFile, seal } from './files.js';
import { cachedArtifact, cachePlanReference, linkCachedArtifact } from './artifact-cache.js';

const MAX_APK_BYTES = 512 * 1024 * 1024;
export interface ApkIdentity {
  packageId: string;
  versionCode: number;
  signerSha256: string;
}

export interface VerifiedArtifact extends ApkIdentity {
  path: string;
  sha256: string;
}
export interface ArtifactOptions {
  runner: CommandRunner;
  aapt?: string;
  apksigner?: string;
  cacheRoot?: string;
}

interface CachedSignatureEvidence {
  schemaVersion: 1;
  packageId: string;
  versionCode: number;
  sha256: string;
  signerSha256: string;
  signatureBytes: 'embedded-in-artifact.apk';
  verifier: 'apksigner';
  verification: 'passed';
}

function cachedSignatureEvidence(artifact: VerifiedArtifact): CachedSignatureEvidence {
  return {
    schemaVersion: 1,
    packageId: artifact.packageId,
    versionCode: artifact.versionCode,
    sha256: artifact.sha256,
    signerSha256: artifact.signerSha256,
    signatureBytes: 'embedded-in-artifact.apk',
    verifier: 'apksigner',
    verification: 'passed',
  };
}

function currentApkSigner(verification: string): string {
  let signers = [
    ...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$/gm),
  ].map((row) => row[1]?.toLowerCase());
  const rotated = [
    ...verification.matchAll(
      /^Signer \(minSdkVersion=(\d+), maxSdkVersion=(\d+)\) certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$/gm,
    ),
  ];
  if (rotated.length) {
    const counts = [...verification.matchAll(/^Number of signers:\s*(\d+)\s*$/gm)];
    if (signers.length || counts.length !== 1 || counts[0]?.[1] !== '1')
      throw new AdapterError('APK requires exactly one verified signing certificate');
    // apksigner verifies the rotation lineage; its unbounded SDK range identifies
    // the current certificate rather than a historical compatibility signer.
    signers = rotated.filter((row) => row[2] === '2147483647').map((row) => row[3]?.toLowerCase());
  }
  if (signers.length !== 1 || !signers[0])
    throw new AdapterError('APK requires exactly one verified signing certificate');
  return signers[0];
}

/** The only APK acquisition and verification path, shared by CLI, MCP and workflows. */
export class ArtifactService {
  private readonly verifiedIdentities = new Map<string, ApkIdentity>();
  readonly runner: CommandRunner;
  readonly aapt: string;
  readonly apksigner: string;
  readonly cacheRoot?: string;
  constructor(options: ArtifactOptions) {
    this.runner = options.runner;
    this.aapt = options.aapt ?? 'aapt';
    this.apksigner = options.apksigner ?? 'apksigner';
    if (options.cacheRoot) this.cacheRoot = options.cacheRoot;
  }
  async checkCompatibility(
    path: string,
    sdk: number,
    abis: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(sdk) || sdk < 1 || !abis.length)
      throw new AdapterError('Device SDK and ABI observations are required before installing');
    const badging = checked(
      await this.runner.run([this.aapt, 'dump', 'badging', path], {
        timeoutMs: 120_000,
        ...(signal ? { signal } : {}),
      }),
      'APK compatibility inspection',
    );
    const compatibility = parseApkCompatibility(badging);
    if (
      sdk < compatibility.minSdk ||
      (compatibility.maxSdk !== undefined && sdk > compatibility.maxSdk) ||
      (compatibility.abis.length && !compatibility.abis.some((abi) => abis.includes(abi)))
    )
      throw new AdapterError('Verified APK is incompatible with the observed device SDK or ABI');
  }
  async identity(path: string, signal?: AbortSignal): Promise<ApkIdentity> {
    await regularFile(path, MAX_APK_BYTES);
    const options = { timeoutMs: 120_000, ...(signal ? { signal } : {}) };
    const badging = checked(
      await this.runner.run([this.aapt, 'dump', 'badging', path], options),
      'APK package inspection',
    );
    const matches = [...badging.matchAll(/^package: name='([^']+)' versionCode='(\d+)'/gm)];
    if (matches.length !== 1) throw new AdapterError('APK package identity is missing or ambiguous');
    const match = matches[0];
    if (!match?.[1] || !match[2]) throw new AdapterError('APK package identity is malformed');
    const versionCode = Number(match[2]);
    if (!Number.isSafeInteger(versionCode) || versionCode < 1)
      throw new AdapterError('APK version is invalid');
    const verification = checked(
      await this.runner.run(
        [this.apksigner, 'verify', '--verbose', '--print-certs', '--min-sdk-version', '24', path],
        options,
      ),
      'APK cryptographic verification',
    );
    return { packageId: packageId(match[1]), versionCode, signerSha256: currentApkSigner(verification) };
  }
  /** Hash exactly the bytes authenticated by the package and signature inspectors. */
  async contentIdentity(path: string, signal?: AbortSignal): Promise<ApkIdentity & { sha256: string }> {
    const sha256 = await fileDigest(path, MAX_APK_BYTES, signal);
    const identity = await this.identity(path, signal);
    if ((await fileDigest(path, MAX_APK_BYTES, signal)) !== sha256)
      throw new AdapterError('APK changed during verification');
    this.verifiedIdentities.set(sha256, { ...identity });
    return { ...identity, sha256 };
  }
  /** Only identities authenticated from actual APK bytes may populate this cache. */
  verifiedIdentity(sha256: string): ApkIdentity | undefined {
    const identity = this.verifiedIdentities.get(sha256);
    return identity ? { ...identity } : undefined;
  }
  async inspect(
    path: string,
    policy: Pick<ArtifactPolicy, 'packageId' | 'versionCode' | 'sha256' | 'signerSha256'>,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    const expectedHash = sha256Pin(policy.sha256);
    const expectedSigner = sha256Pin(policy.signerSha256);
    packageId(policy.packageId);
    const hash = await fileDigest(path, MAX_APK_BYTES, signal);
    if (hash !== expectedHash) throw new AdapterError('APK bytes do not match the reviewed SHA-256');
    const identity = await this.identity(path, signal);
    if (
      identity.packageId !== policy.packageId ||
      identity.versionCode !== policy.versionCode ||
      identity.signerSha256 !== expectedSigner
    )
      throw new AdapterError('APK package, version or signer does not match the reviewed artifact');
    if ((await fileDigest(path, MAX_APK_BYTES, signal)) !== hash)
      throw new AdapterError('APK changed during verification');
    this.verifiedIdentities.set(hash, { ...identity });
    return { ...identity, path, sha256: hash };
  }
  async snapshot(
    policy: ArtifactPolicy,
    destination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    if ((policy.path ? 1 : 0) + (policy.url ? 1 : 0) !== 1)
      throw new AdapterError('APK requires exactly one approved source');
    sha256Pin(policy.sha256);
    sha256Pin(policy.signerSha256);
    packageId(policy.packageId);
    if (!this.cacheRoot) return this.privateSnapshot(policy, destination, signal);
    const artifact = await cachedArtifact(
      {
        root: join(this.cacheRoot, 'apk'),
        key: sha256Pin(policy.sha256),
        build: async (directory) => {
          const value = await this.privateSnapshot(policy, join(directory, 'artifact.apk'), signal);
          await cachePlanReference(join(directory, 'signature.json'), cachedSignatureEvidence(value));
          return value;
        },
        verify: async (directory) => {
          const value = await this.inspect(join(directory, 'artifact.apk'), policy, signal);
          const evidencePath = join(directory, 'signature.json');
          const expected = cachedSignatureEvidence(value);
          let retained: unknown;
          let evidenceFile: Awaited<ReturnType<typeof open>>;
          try {
            evidenceFile = await open(
              evidencePath,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              // Upgrade older content-addressed APK entries after re-verifying the APK bytes.
              await cachePlanReference(evidencePath, expected);
              return value;
            }
            throw new AdapterError('Cached APK signature evidence is malformed');
          }
          try {
            const info = await evidenceFile.stat();
            if (!info.isFile() || info.size < 1 || info.size > 4096)
              throw new AdapterError('Cached APK signature evidence is malformed');
            retained = JSON.parse((await evidenceFile.readFile('utf8')).trim()) as unknown;
          } catch {
            throw new AdapterError('Cached APK signature evidence is malformed');
          } finally {
            await evidenceFile.close();
          }
          assertCachedSignatureEvidence(retained, expected);
          return value;
        },
        contentId: (value) => value.sha256,
        relocate: (value, directory) => ({ ...value, path: join(directory, 'artifact.apk') }),
      },
      signal,
    );
    if (
      artifact.packageId !== policy.packageId ||
      artifact.versionCode !== policy.versionCode ||
      artifact.signerSha256 !== sha256Pin(policy.signerSha256)
    )
      throw new AdapterError('Cached APK identity differs from the reviewed artifact');
    await linkCachedArtifact(artifact.path, destination);
    try {
      await cachePlanReference(`${destination}.ref.json`, artifact);
      return { ...artifact, path: destination };
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }
  private async privateSnapshot(
    policy: ArtifactPolicy,
    destination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    let created = false;
    try {
      if (policy.path) await copySnapshot(policy.path, destination, MAX_APK_BYTES, signal);
      else if (policy.url)
        await download(destination, policy.url, {
          limit: MAX_APK_BYTES,
          hosts: policy.redirectHosts ?? [],
          timeoutMs: 600_000,
          ...(signal ? { signal } : {}),
        });
      created = true;
      const artifact = await this.inspect(destination, policy, signal);
      await seal(destination);
      return artifact;
    } catch (error) {
      if (created) await unlink(destination).catch(() => undefined);
      throw error;
    }
  }
  /** Use a fresh private copy so installation consumes exactly the inspected bytes. */
  async withStaged<T>(
    artifact: VerifiedArtifact,
    action: (staged: VerifiedArtifact) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'pxv-verified-apk-'));
    try {
      const staged = await this.privateSnapshot(
        { ...artifact, path: artifact.path },
        join(directory, 'verified.apk'),
        signal,
      );
      return await action(staged);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function assertCachedSignatureEvidence(retained: unknown, expected: CachedSignatureEvidence): void {
  if (
    !retained ||
    typeof retained !== 'object' ||
    Array.isArray(retained) ||
    JSON.stringify(Object.keys(retained).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
    JSON.stringify(retained, Object.keys(retained).sort()) !==
      JSON.stringify(expected, Object.keys(expected).sort())
  )
    throw new AdapterError('Cached APK signature evidence does not match the verified APK');
}
