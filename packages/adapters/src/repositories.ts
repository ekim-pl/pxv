import { parseDocument, type ArtifactPolicy, type RepositoryPolicy } from '@pxv/contracts';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError, checked, packageId, sha256Pin, type CommandRunner } from './command.js';
import { download, fileDigest } from './files.js';

const MAX_INDEX_BYTES = 128 * 1024 * 1024;
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
export interface RepositoryOptions {
  runner: CommandRunner;
  verifierPath: string;
  freshness: RepositoryFreshness;
  java?: string;
  now?: () => number;
}
export interface IndexOptions {
  signal?: AbortSignal;
  readOnly?: boolean;
}
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AdapterError(`Malformed authenticated ${label}`);
  return value as Row;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new AdapterError(`Invalid authenticated ${label}`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new AdapterError(`Invalid authenticated ${label}`);
  return value;
}
function strictJson(source: string): unknown {
  JSON.parse(source) as unknown;
  return parseDocument(source);
}
export function repositoryFilename(value: unknown, suffix: '.json' | '.apk'): string {
  const raw = text(value, 'repository filename');
  const name = raw.startsWith('/') ? raw.slice(1) : raw;
  if (
    name.length > 512 ||
    !name.endsWith(suffix) ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AdapterError('Unsafe authenticated repository filename');
  return name;
}
export class RepositoryService {
  readonly runner: CommandRunner;
  readonly verifierPath: string;
  readonly freshness: RepositoryFreshness;
  readonly java: string;
  readonly now: () => number;
  constructor(options: RepositoryOptions) {
    this.runner = options.runner;
    this.verifierPath = options.verifierPath;
    this.freshness = options.freshness;
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
        const entry = await this.verifyJar(jar, signer, 'entry.json', options.signal);
        const version = positiveInteger(entry['version'], 'v2 entry version');
        if (version < 20_000 || version >= 30_000)
          throw new AdapterError('Unsupported authenticated repository entry version');
        const descriptor = object(entry['index'], 'v2 index descriptor');
        const size = positiveInteger(descriptor['size'], 'v2 index size');
        if (size > MAX_INDEX_BYTES)
          throw new AdapterError('Authenticated repository index exceeds size limit');
        const checksum = sha256Pin(text(descriptor['sha256'], 'v2 index hash'));
        const name = repositoryFilename(descriptor['name'], '.json');
        const path = join(directory, 'index.json');
        await download(path, `${url}/${name}`, { ...downloadOptions, limit: size });
        const bytes = await readFile(path);
        indexSha256 = createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== size || indexSha256 !== checksum)
          throw new AdapterError('Repository JSON does not match its signed size and SHA-256');
        index = object(strictJson(bytes.toString('utf8')), 'v2 repository index');
        timestamp = positiveInteger(object(index['repo'], 'repository')['timestamp'], 'repository timestamp');
        if (entry['timestamp'] !== timestamp)
          throw new AdapterError('V2 repository entry and index timestamps disagree');
      } else {
        await download(jar, `${url}/index-v1.jar`, { ...downloadOptions, limit: 32 * 1024 * 1024 });
        index = await this.verifyJar(jar, signer, 'index-v1.json', options.signal);
        indexSha256 = await fileDigest(jar, 32 * 1024 * 1024, options.signal);
        timestamp = positiveInteger(object(index['repo'], 'repository')['timestamp'], 'repository timestamp');
      }
      this.assertFresh(repository, timestamp, floor);
      const packages = this.normalize(repository, object(index['packages'], 'package set'), isV2);
      const evidence: RepositoryEvidence = {
        url,
        signerSha256: signer,
        timestamp,
        entrySha256: await fileDigest(jar, 32 * 1024 * 1024, options.signal),
        indexSha256,
        format: isV2 ? 'v2' : 'v1',
        maxAgeDays: repository.maxAgeDays,
      };
      if (!options.readOnly)
        await this.freshness.advance(this.key(repository), floor, { signerSha256: signer, timestamp });
      return { evidence, packages };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  normalize(repository: RepositoryPolicy, packages: Row, v2: boolean): Record<string, RepositoryApk[]> {
    const output: Record<string, RepositoryApk[]> = Object.create(null) as Record<string, RepositoryApk[]>;
    for (const [id, raw] of Object.entries(packages)) {
      packageId(id);
      const values: unknown[] = v2
        ? Object.values(object(object(raw, 'package')['versions'], 'package versions'))
        : Array.isArray(raw)
          ? raw
          : (() => {
              throw new AdapterError('Malformed authenticated APK list');
            })();
      output[id] = values.map((value) => {
        const row = object(value, 'APK record');
        let name: string;
        let hash: string;
        let signer: string;
        let version: number;
        if (v2) {
          const file = object(row['file'], 'APK file');
          const manifest = object(row['manifest'], 'APK manifest');
          const signers = object(manifest['signer'], 'APK signer')['sha256'];
          if (!Array.isArray(signers) || signers.length !== 1 || typeof signers[0] !== 'string')
            throw new AdapterError('Authenticated APK has no unambiguous signer SHA-256 pin');
          signer = sha256Pin(signers[0]);
          name = repositoryFilename(file['name'], '.apk');
          hash = sha256Pin(text(file['sha256'], 'APK hash'));
          version = positiveInteger(manifest['versionCode'], 'APK version');
          if (positiveInteger(file['size'], 'APK size') > 512 * 1024 * 1024)
            throw new AdapterError('APK exceeds approved size limit');
        } else {
          if ((row['hashType'] ?? 'sha256') !== 'sha256')
            throw new AdapterError('Authenticated APK requires SHA-256');
          signer = sha256Pin(text(row['signer'], 'APK signer'));
          name = repositoryFilename(row['apkName'], '.apk');
          hash = sha256Pin(text(row['hash'], 'APK hash'));
          version = positiveInteger(row['versionCode'], 'APK version');
        }
        const sdkSource = v2
          ? object(object(row['manifest'], 'APK manifest')['usesSdk'] ?? {}, 'APK SDK')
          : row;
        const minSdk = positiveInteger(sdkSource[v2 ? 'minSdkVersion' : 'minSdkVersion'] ?? 1, 'minimum SDK');
        const maxRaw = sdkSource['maxSdkVersion'];
        const maxSdk = maxRaw === undefined ? undefined : positiveInteger(maxRaw, 'maximum SDK');
        if (maxSdk !== undefined && maxSdk < minSdk)
          throw new AdapterError('Authenticated APK maximum SDK is below its minimum');
        const abiRaw = (v2 ? object(row['manifest'], 'APK manifest') : row)['nativecode'] ?? [];
        if (
          !Array.isArray(abiRaw) ||
          abiRaw.some((abi) => typeof abi !== 'string' || !/^[A-Za-z0-9_-]+$/.test(abi))
        )
          throw new AdapterError('Malformed authenticated APK ABIs');
        const abis = abiRaw as string[];
        return {
          compatibility: { minSdk, ...(maxSdk === undefined ? {} : { maxSdk }), abis },
          packageId: id,
          versionCode: version,
          sha256: hash,
          signerSha256: signer,
          url: `${repository.url.replace(/\/$/, '')}/${name}`,
          repositoryId: repository.id,
          ...(repository.redirectHosts.length ? { redirectHosts: repository.redirectHosts } : {}),
        };
      });
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
    if (advance)
      await this.freshness.advance(key, floor, {
        signerSha256: evidence.signerSha256,
        timestamp: evidence.timestamp,
      });
  }
}
