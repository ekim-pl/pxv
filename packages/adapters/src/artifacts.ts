import { parseApkCompatibility } from './apk-compatibility.js';
import type { ArtifactPolicy } from '@pxv/contracts';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError, checked, packageId, sha256Pin, type CommandRunner } from './command.js';
import { copySnapshot, download, fileDigest, regularFile, seal } from './files.js';

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
}
/** The only APK acquisition and verification path, shared by CLI, MCP and workflows. */
export class ArtifactService {
  readonly runner: CommandRunner;
  readonly aapt: string;
  readonly apksigner: string;
  constructor(options: ArtifactOptions) {
    this.runner = options.runner;
    this.aapt = options.aapt ?? 'aapt';
    this.apksigner = options.apksigner ?? 'apksigner';
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
    const signers = [
      ...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$/gm),
    ].map((row) => row[1]?.toLowerCase());
    if (signers.length !== 1 || !signers[0])
      throw new AdapterError('APK requires exactly one verified signing certificate');
    return { packageId: packageId(match[1]), versionCode, signerSha256: signers[0] };
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
      const staged = await this.snapshot(
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
