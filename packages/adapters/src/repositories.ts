import { object, positiveInteger, text, repositoryFilename, suggestedVersions } from './repository-values.js';
import { parseDocument, type ArtifactPolicy, type RepositoryPolicy } from '@pxv/contracts';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdapterError, checked, packageId, sha256Pin, type CommandRunner } from './command.js';
import { download, fileDigest, regularFile } from './files.js';
import { cacheSignedFiles } from './artifact-cache.js';

const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const REPOSITORY_INDEX_DOWNLOAD_TIMEOUT_MS = 600_000;
type Row = Record<string, unknown>;
export interface RepositoryFloor {
  signerSha256: string;
  timestamp: number;
}
/** Implement advance as compare-and-set in the project storage transaction. */
export interface RepositoryFreshness {
  read(key: string): Promise<RepositoryFloor | undefined>;
  advance(key: string, previous: RepositoryFloor | undefined, next: RepositoryFloor): Promise<void>;
}
export interface RepositoryEvidence {
  url: string;
  signerSha256: string;
  timestamp: number;
  entrySha256: string;
  indexSha256: string;
  format: 'v1' | 'v2';
  maxAgeDays: number;
  signatureMaterialId?: string;
}
export interface RepositoryApk extends ArtifactPolicy {
  compatibility: { minSdk: number; maxSdk?: number; abis: string[] };
}
export interface CandidateDevice {
  sdk: number;
  abis: readonly string[];
  versionCode?: number;
}
export interface AuthenticatedRepository {
  evidence: RepositoryEvidence;
  packages: Record<string, RepositoryApk[]>;
}
export interface AuthenticatedUpdateRepository extends AuthenticatedRepository {
  suggestedVersionCodes: Record<string, number>;
}
export interface DownloadedIndexOptions {
  signal?: AbortSignal;
  packageIds?: readonly string[];
}
export interface RepositoryOptions {
  runner: CommandRunner;
  verifierPath: string;
  freshness: RepositoryFreshness;
  cacheRoot?: string;
  java?: string;
  now?: () => number;
}
export interface IndexOptions {
  signal?: AbortSignal;
  /** Skip freshness-floor advancement; authenticated material may still be retained for later validation. */
  readOnly?: boolean;
  /** Normalize only these package records after authenticating the complete index. */
  packageIds?: readonly string[];
}

function strictJson(source: string): unknown {
  JSON.parse(source) as unknown;
  return parseDocument(source);
}

export class RepositoryService {
  readonly runner: CommandRunner;
  readonly verifierPath: string;
  readonly freshness: RepositoryFreshness;
  readonly cacheRoot?: string;
  readonly java: string;
  readonly now: () => number;
  constructor(options: RepositoryOptions) {
    this.runner = options.runner;
    this.verifierPath = options.verifierPath;
    this.freshness = options.freshness;
    if (options.cacheRoot) this.cacheRoot = options.cacheRoot;
    this.java = options.java ?? 'java';
    this.now = options.now ?? Date.now;
  }
  key(repository: RepositoryPolicy): string {
    return createHash('sha256')
      .update(`${repository.url.replace(/\/$/, '')}\0${sha256Pin(repository.signerSha256)}`)
      .digest('hex');
  }
  assertFresh(repository: RepositoryPolicy, timestamp: number, floor?: RepositoryFloor): void {
    positiveInteger(timestamp, 'repository timestamp');
    if (
      floor &&
      (floor.signerSha256 !== repository.signerSha256.toLowerCase() ||
        !Number.isSafeInteger(floor.timestamp) ||
        floor.timestamp < 1)
    )
      throw new AdapterError('Repository freshness record is malformed; preserve it for recovery');
    const age = this.now() - timestamp;
    if (age < -86_400_000 || age > repository.maxAgeDays * 86_400_000)
      throw new AdapterError('Authenticated repository index is outside its approved freshness window');
    if (timestamp < (floor?.timestamp ?? 0))
      throw new AdapterError('Authenticated repository timestamp would roll back the freshness floor');
  }
  async verifyJar(
    path: string,
    signer: string,
    entry: 'entry.json' | 'index-v1.json',
    signal?: AbortSignal,
  ): Promise<Row> {
    const stdout = checked(
      await this.runner.run([this.java, '-Xmx256m', this.verifierPath, path, sha256Pin(signer), entry], {
        timeoutMs: 120_000,
        ...(signal ? { signal } : {}),
      }),
      'Repository JAR authentication',
    );
    if (Buffer.byteLength(stdout) > (entry === 'entry.json' ? 1024 * 1024 : 64 * 1024 * 1024))
      throw new AdapterError('Authenticated repository JSON exceeds its size limit');
    return object(strictJson(stdout), 'repository index');
  }
  /** Authenticate fdroidcl's downloaded v1 index without advancing the execution freshness floor. */
  async indexFromJar(
    repository: RepositoryPolicy,
    path: string,
    options: DownloadedIndexOptions = {},
  ): Promise<AuthenticatedUpdateRepository> {
    const { signal } = options;
    const before = await fileDigest(path, 32 * 1024 * 1024, signal);
    const index = await this.downloadedJarJson(path, repository.signerSha256, signal);
    const repo = object(index['repo'], 'repository');
    const url = repository.url.replace(/\/$/, '');
    if (text(repo['address'], 'repository address').replace(/\/$/, '') !== url)
      throw new AdapterError('Authenticated repository address differs from the configured repository');
    const timestamp = positiveInteger(repo['timestamp'], 'repository timestamp');
    this.assertFresh(repository, timestamp, await this.freshness.read(this.key(repository)));
    const selected = options.packageIds ? new Set(options.packageIds) : undefined;
    const rawPackages = object(index['packages'], 'package set');
    const selectedPackages = selected
      ? Object.fromEntries(
          [...selected].filter((id) => Object.hasOwn(rawPackages, id)).map((id) => [id, rawPackages[id]]),
        )
      : rawPackages;
    const packages = this.normalize(repository, selectedPackages, false);
    const suggestedVersionCodes = suggestedVersions(index['apps'], selected);
    if ((await fileDigest(path, 32 * 1024 * 1024, signal)) !== before)
      throw new AdapterError('Repository JAR changed during authentication');
    return {
      packages,
      suggestedVersionCodes,
      evidence: {
        url,
        signerSha256: sha256Pin(repository.signerSha256),
        timestamp,
        entrySha256: before,
        indexSha256: before,
        format: 'v1',
        maxAgeDays: repository.maxAgeDays,
      },
    };
  }
  private async downloadedJarJson(path: string, signer: string, signal?: AbortSignal): Promise<Row> {
    const directory = await mkdtemp(join(tmpdir(), 'pxv-repository-json-'));
    const output = join(directory, 'index.json');
    try {
      // Full official v1 indexes exceed the command runner's bounded stdout channel.
      checked(
        await this.runner.run(
          [this.java, '-Xmx512m', this.verifierPath, path, sha256Pin(signer), 'index-v1.json', output],
          { timeoutMs: 120_000, check: false, ...(signal ? { signal } : {}) },
        ),
        'Repository JAR authentication',
      );
      await regularFile(output, MAX_INDEX_BYTES);
      return object(strictJson(await readFile(output, 'utf8')), 'repository index');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async index(repository: RepositoryPolicy, options: IndexOptions = {}): Promise<AuthenticatedRepository> {
    const url = repository.url.replace(/\/$/, '');
    const signer = sha256Pin(repository.signerSha256);
    const floor = await this.freshness.read(this.key(repository));
    const directory = await mkdtemp(join(tmpdir(), 'pxv-repository-'));
    try {
      const jar = join(directory, 'index.jar');
      const downloadOptions = {
        hosts: repository.redirectHosts,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const isV2 = await download(jar, `${url}/entry.jar`, {
        ...downloadOptions,
        limit: 4 * 1024 * 1024,
        allow404: true,
      });
      let index: Row;
      let timestamp: number;
      let indexSha256: string;
      if (isV2) {
        const loaded = await this.v2Index(repository, jar, directory, options);
        index = loaded.index;
        timestamp = loaded.timestamp;
        indexSha256 = loaded.indexSha256;
      } else {
        await download(jar, `${url}/index-v1.jar`, { ...downloadOptions, limit: 32 * 1024 * 1024 });
        index = await this.verifyJar(jar, signer, 'index-v1.json', options.signal);
        indexSha256 = await fileDigest(jar, 32 * 1024 * 1024, options.signal);
        timestamp = positiveInteger(object(index['repo'], 'repository')['timestamp'], 'repository timestamp');
      }
      this.assertFresh(repository, timestamp, floor);
      const rawPackages = object(index['packages'], 'package set');
      const selected = options.packageIds ? new Set(options.packageIds.map(packageId)) : undefined;
      const selectedPackages = selected
        ? Object.fromEntries(
            [...selected].filter((id) => Object.hasOwn(rawPackages, id)).map((id) => [id, rawPackages[id]]),
          )
        : rawPackages;
      const packages = this.normalize(repository, selectedPackages, isV2);
      const entrySha256 = await fileDigest(jar, 32 * 1024 * 1024, options.signal);
      const materialFiles = isV2
        ? [
            { name: 'entry.jar', source: jar, sha256: entrySha256, limit: 4 * 1024 * 1024 },
            {
              name: 'index.json',
              source: join(directory, 'index.json'),
              sha256: indexSha256,
              limit: MAX_INDEX_BYTES,
            },
          ]
        : [{ name: 'index-v1.jar', source: jar, sha256: entrySha256, limit: 32 * 1024 * 1024 }];
      const format = isV2 ? 'v2' : 'v1';
      const signatureMaterialId = repositoryMaterialId(format, entrySha256, indexSha256);
      const cacheRoot = this.cacheRoot;
      if (cacheRoot) await cacheSignedFiles(cacheRoot, signatureMaterialId, materialFiles);
      const evidence: RepositoryEvidence = {
        url,
        signerSha256: signer,
        timestamp,
        entrySha256,
        indexSha256,
        format,
        maxAgeDays: repository.maxAgeDays,
        ...(cacheRoot ? { signatureMaterialId } : {}),
      };
      if (!options.readOnly)
        await this.freshness.advance(this.key(repository), floor, { signerSha256: signer, timestamp });
      return { evidence, packages };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async v2Index(
    repository: RepositoryPolicy,
    jar: string,
    directory: string,
    options: IndexOptions,
  ): Promise<{ index: Row; timestamp: number; indexSha256: string }> {
    const url = repository.url.replace(/\/$/, '');
    const signer = sha256Pin(repository.signerSha256);
    const downloadOptions = {
      hosts: repository.redirectHosts,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const entry = await this.verifyJar(jar, signer, 'entry.json', options.signal);
    const version = positiveInteger(entry['version'], 'authenticated repository entry version');
    const isV2Entry = version >= 20_000 && version < 30_000;
    const isV3Entry = version >= 30_000 && version < 40_000;
    if (!isV2Entry && !isV3Entry)
      throw new AdapterError('Unsupported authenticated repository entry version');
    // Entry 3.x adds age/diff metadata but still publishes a complete index-v2 descriptor.
    const descriptor = object(entry['index'], 'v2 index descriptor');
    const size = positiveInteger(descriptor['size'], 'v2 index size');
    if (size > MAX_INDEX_BYTES) throw new AdapterError('Authenticated repository index exceeds size limit');
    const checksum = sha256Pin(text(descriptor['sha256'], 'v2 index hash'));
    const name = repositoryFilename(descriptor['name'], '.json');
    const path = join(directory, 'index.json');
    await download(path, `${url}/${name}`, {
      ...downloadOptions,
      limit: size,
      timeoutMs: REPOSITORY_INDEX_DOWNLOAD_TIMEOUT_MS,
    });
    const bytes = await readFile(path);
    const indexSha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== size || indexSha256 !== checksum)
      throw new AdapterError('Repository JSON does not match its signed size and SHA-256');
    const index = object(strictJson(bytes.toString('utf8')), 'v2 repository index');
    const timestamp = positiveInteger(
      object(index['repo'], 'repository')['timestamp'],
      'repository timestamp',
    );
    if (entry['timestamp'] !== timestamp)
      throw new AdapterError('V2 repository entry and index timestamps disagree');
    return { index, timestamp, indexSha256 };
  }
  normalize(repository: RepositoryPolicy, packages: Row, v2: boolean): Record<string, RepositoryApk[]> {
    const output = Object.create(null) as Record<string, RepositoryApk[]>;
    for (const [id, raw] of Object.entries(packages)) {
      packageId(id);
      output[id] = packageVersions(raw, v2).map((value) =>
        normalizeApk(repository, id, object(value, 'APK record'), v2),
      );
    }
    return output;
  }
  candidate(index: AuthenticatedRepository, id: string, device: CandidateDevice): ArtifactPolicy {
    positiveInteger(device.sdk, 'device SDK');
    if (!device.abis.length)
      throw new AdapterError('Device ABI observations are required for repository APK selection');
    packageId(id);
    const rows = (index.packages[id] ?? [])
      .filter(
        (row) =>
          (device.versionCode === undefined || row.versionCode === device.versionCode) &&
          row.compatibility.minSdk <= device.sdk &&
          (row.compatibility.maxSdk === undefined || row.compatibility.maxSdk >= device.sdk) &&
          (!row.compatibility.abis.length || row.compatibility.abis.some((abi) => device.abis.includes(abi))),
      )
      .sort((a, b) => b.versionCode - a.versionCode);
    const selected = rows[0];
    if (!selected) throw new AdapterError('The approved repository has no matching APK candidate');
    if (
      rows.some(
        (row) =>
          row.versionCode === selected.versionCode &&
          (row.sha256 !== selected.sha256 || row.signerSha256 !== selected.signerSha256),
      )
    )
      throw new AdapterError(
        'Authenticated repository contains conflicting APK identities for the same version',
      );
    const policy: ArtifactPolicy & { compatibility?: unknown } = structuredClone(selected);
    delete policy.compatibility;
    return policy;
  }
  async validateEvidence(
    repository: RepositoryPolicy,
    evidence: RepositoryEvidence,
    advance = false,
  ): Promise<void> {
    if (
      evidence.url !== repository.url.replace(/\/$/, '') ||
      evidence.signerSha256 !== sha256Pin(repository.signerSha256) ||
      evidence.maxAgeDays !== repository.maxAgeDays ||
      !['v1', 'v2'].includes(evidence.format)
    )
      throw new AdapterError('Reviewed repository identity changed');
    sha256Pin(evidence.entrySha256);
    sha256Pin(evidence.indexSha256);
    const key = this.key(repository);
    const floor = await this.freshness.read(key);
    this.assertFresh(repository, evidence.timestamp, floor);
    if (this.cacheRoot) await this.validateCachedSignatures(repository, evidence);
    if (advance)
      await this.freshness.advance(key, floor, {
        signerSha256: evidence.signerSha256,
        timestamp: evidence.timestamp,
      });
  }
  private async validateCachedSignatures(
    repository: RepositoryPolicy,
    evidence: RepositoryEvidence,
  ): Promise<void> {
    const expectedId = repositoryMaterialId(evidence.format, evidence.entrySha256, evidence.indexSha256);
    if (evidence.signatureMaterialId !== expectedId)
      throw new AdapterError('Authenticated repository signature material is not retained');
    const directory = join(this.cacheRoot!, 'repository-signatures', expectedId);
    if ((await realpath(directory)) !== resolve(directory) || !(await lstat(directory)).isDirectory())
      throw new AdapterError('Cached repository signature directory is invalid');
    const signer = sha256Pin(repository.signerSha256);
    if (evidence.format === 'v2') return this.validateV2Signature(directory, signer, evidence);
    const jar = join(directory, 'index-v1.jar');
    const actual = await fileDigest(jar, 32 * 1024 * 1024);
    if (actual !== evidence.entrySha256 || actual !== evidence.indexSha256)
      throw new AdapterError('Cached authenticated v1 index has changed');
    const index = await this.verifyJar(jar, signer, 'index-v1.json');
    const timestamp = positiveInteger(
      object(index['repo'], 'repository')['timestamp'],
      'repository timestamp',
    );
    if (timestamp !== evidence.timestamp)
      throw new AdapterError('Cached authenticated v1 index timestamp differs from the reviewed evidence');
  }
  private async validateV2Signature(
    directory: string,
    signer: string,
    evidence: RepositoryEvidence,
  ): Promise<void> {
    const jar = join(directory, 'entry.jar');
    if ((await fileDigest(jar, 4 * 1024 * 1024)) !== evidence.entrySha256)
      throw new AdapterError('Cached authenticated repository entry has changed');
    const entry = await this.verifyJar(jar, signer, 'entry.json');
    const descriptor = object(entry['index'], 'v2 index descriptor');
    const size = positiveInteger(descriptor['size'], 'v2 index size');
    if (size > MAX_INDEX_BYTES) throw new AdapterError('Authenticated repository index exceeds size limit');
    const checksum = sha256Pin(text(descriptor['sha256'], 'v2 index hash'));
    repositoryFilename(descriptor['name'], '.json');
    const indexPath = join(directory, 'index.json');
    const indexSha256 = await fileDigest(indexPath, size);
    const bytes = await readFile(indexPath);
    if (bytes.length !== size || indexSha256 !== checksum || indexSha256 !== evidence.indexSha256)
      throw new AdapterError('Cached repository index differs from its signed entry');
    const index = object(strictJson(bytes.toString('utf8')), 'v2 repository index');
    const timestamp = positiveInteger(
      object(index['repo'], 'repository')['timestamp'],
      'repository timestamp',
    );
    if (entry['timestamp'] !== timestamp || timestamp !== evidence.timestamp)
      throw new AdapterError('Cached repository entry and index timestamps disagree');
  }
}

function repositoryMaterialId(format: 'v1' | 'v2', entrySha256: string, indexSha256: string): string {
  const material =
    format === 'v2'
      ? `entry.jar\0${entrySha256}\0index.json\0${indexSha256}`
      : `index-v1.jar\0${entrySha256}`;
  return createHash('sha256').update(material).digest('hex');
}

function packageVersions(raw: unknown, v2: boolean): unknown[] {
  if (v2) return Object.values(object(object(raw, 'package')['versions'], 'package versions'));
  if (!Array.isArray(raw)) throw new AdapterError('Malformed authenticated APK list');
  return raw;
}
interface ApkMetadata {
  name: string;
  hash: string;
  signer: string;
  version: number;
}
function v2Apk(row: Row): ApkMetadata {
  const file = object(row['file'], 'APK file'),
    manifest = object(row['manifest'], 'APK manifest');
  const signers = object(manifest['signer'], 'APK signer')['sha256'];
  if (!Array.isArray(signers) || signers.length !== 1 || typeof signers[0] !== 'string')
    throw new AdapterError('Authenticated APK has no unambiguous signer SHA-256 pin');
  if (positiveInteger(file['size'], 'APK size') > 512 * 1024 * 1024)
    throw new AdapterError('APK exceeds approved size limit');
  return {
    signer: sha256Pin(signers[0]),
    name: repositoryFilename(file['name'], '.apk'),
    hash: sha256Pin(text(file['sha256'], 'APK hash')),
    version: positiveInteger(manifest['versionCode'], 'APK version'),
  };
}
function v1Apk(row: Row): ApkMetadata {
  if ((row['hashType'] ?? 'sha256') !== 'sha256')
    throw new AdapterError('Authenticated APK requires SHA-256');
  return {
    signer: sha256Pin(text(row['signer'], 'APK signer')),
    name: repositoryFilename(row['apkName'], '.apk'),
    hash: sha256Pin(text(row['hash'], 'APK hash')),
    version: positiveInteger(row['versionCode'], 'APK version'),
  };
}
function apkCompatibility(row: Row, v2: boolean): RepositoryApk['compatibility'] {
  const manifest = v2 ? object(row['manifest'], 'APK manifest') : row;
  const sdkSource = v2 ? object(manifest['usesSdk'] ?? {}, 'APK SDK') : row;
  const minSdk = positiveInteger(sdkSource['minSdkVersion'] ?? 1, 'minimum SDK');
  const maxRaw = sdkSource['maxSdkVersion'];
  const maxSdk = maxRaw === undefined ? undefined : positiveInteger(maxRaw, 'maximum SDK');
  if (maxSdk !== undefined && maxSdk < minSdk)
    throw new AdapterError('Authenticated APK maximum SDK is below its minimum');
  return { minSdk, ...(maxSdk === undefined ? {} : { maxSdk }), abis: apkAbis(manifest) };
}
function normalizeApk(repository: RepositoryPolicy, id: string, row: Row, v2: boolean): RepositoryApk {
  const { name, hash, signer, version } = v2 ? v2Apk(row) : v1Apk(row);
  return {
    compatibility: apkCompatibility(row, v2),
    packageId: id,
    versionCode: version,
    sha256: hash,
    signerSha256: signer,
    url: repository.url.replace(/\/$/, '') + '/' + name,
    repositoryId: repository.id,
    ...(repository.redirectHosts.length ? { redirectHosts: repository.redirectHosts } : {}),
  };
}

function apkAbis(manifest: Row): string[] {
  const raw = manifest['nativecode'] ?? [];
  if (!Array.isArray(raw) || raw.some((abi) => typeof abi !== 'string' || !/^[A-Za-z0-9_-]+$/.test(abi)))
    throw new AdapterError('Malformed authenticated APK ABIs');
  return raw as string[];
}
