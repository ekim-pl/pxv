import { dockerEntrypoint } from './launchers.js';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, parseDocument } from '@pxv/contracts';
import { CommandRunner, hashFile, readBounded, type Runtime } from '@pxv/runtime';
import {
  copyCandidate,
  ANDROID_ARCHIVES,
  BUILDKIT_IMAGE,
  DEBIAN_SNAPSHOT,
  DOCKER_BASE,
  NODE_VERSION,
  verifyCandidate,
  type Candidate,
  type CandidateManifest,
} from './candidate.js';

export type DistributionFormat = 'portable' | 'deb' | 'npm' | 'oci' | 'sea';
export interface DistributionArtifact {
  format: DistributionFormat;
  path: string;
  sha256: string;
  size: number;
  image?: string;
}
export interface BuildFormatsOptions {
  runtime?: Runtime;
  formats: DistributionFormat[];
  outputDirectory?: string;
  signingKey?: string;
  docker?: string;
  postject?: string;
  loadDockerImage?: boolean;
}

async function uniqueWrite(path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, content, { flag: 'wx', mode });
}
function npmLauncher(manifest: CandidateManifest): string {
  const preview = manifest.preview
    ? `process.env.PXV_ROOT??=join(process.env.XDG_STATE_HOME??join(homedir(),'.local','state'),'pxv','previews',${JSON.stringify(manifest.id)});`
    : '';
  return `#!/usr/bin/env node\nimport{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{homedir}from'node:os';const root=dirname(fileURLToPath(import.meta.url));process.env.PXV_RESOURCE_ROOT=root;process.env.PXV_SUPERVISOR=join(root,'node_modules','@pxv/runtime','supervisor.js');${preview}\nawait import('./lib/main.js');\n`;
}

/** @internal Generated container contract, checked independently before Docker execution. */
export function dockerfile(manifest: CandidateManifest): string {
  return [
    `FROM ${DOCKER_BASE}`,
    `RUN printf '%s\\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main' > /etc/apt/sources.list && rm -f /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Check-Valid-Until=false update && apt-get install -y --no-install-recommends curl unzip openjdk-17-jdk-headless openssh-client ca-certificates libstdc++6 libusb-1.0-0 libnss-wrapper && rm -rf /var/lib/apt/lists/*`,
    ...ANDROID_ARCHIVES.map(
      (archive) =>
        `RUN set -eu; curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 'https://dl.google.com/android/repository/${archive.filename}' -o /tmp/pxv-tool.zip; printf '%s\\n' '${archive.sha256}  /tmp/pxv-tool.zip' | sha256sum -c -; mkdir -p /tmp/pxv-extract '${dirname(archive.destination)}'; unzip -q /tmp/pxv-tool.zip -d /tmp/pxv-extract; set -- /tmp/pxv-extract/*; test "$#" -eq 1; test -d "$1"; mv "$1" '${archive.destination}'; rm -rf /tmp/pxv-tool.zip /tmp/pxv-extract`,
    ),
    'COPY candidate /opt/pxv',
    'COPY entrypoint.sh /usr/local/bin/pxv-entrypoint',
    'ENV HOME=/tmp PXV_RESOURCE_ROOT=/opt/pxv PXV_SUPERVISOR=/opt/pxv/node_modules/@pxv/runtime/supervisor.js PXV_ROOT=/project PXV_CONTROL_ROOT=/control PXV_EXTENSION_ROOT=/extensions PXV_DOCKER_MODE=host-adb PXV_ANDROID_HOME=/opt/android-sdk PATH=/opt/platform-tools:/opt/android-sdk/build-tools/35.0.0:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ADB_MDNS_AUTO_CONNECT=0',
    `LABEL org.opencontainers.image.title=${JSON.stringify(manifest.product.name)} org.opencontainers.image.version=${JSON.stringify(manifest.version)} org.opencontainers.image.licenses="MIT" org.opencontainers.image.revision=${JSON.stringify(manifest.source.revision ?? 'working-tree')} org.pxv.source-digest=${JSON.stringify(manifest.sourceDigest)}`,
    'WORKDIR /project',
    'USER 65532:65532',
    'ENTRYPOINT ["/usr/local/bin/pxv-entrypoint"]',
    'CMD ["help"]',
    '',
  ].join('\n');
}

async function portable(candidate: Candidate, output: string, runner: Runtime): Promise<string> {
  const file = join(output, `${candidate.manifest.id}-linux-x64.tar.gz`);
  await runner.run(
    [
      'tar',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      file,
      '-C',
      dirname(candidate.directory),
      basename(candidate.directory),
    ],
    { timeoutMs: 120_000 },
  );
  return file;
}

async function npm(candidate: Candidate, output: string, runner: Runtime): Promise<string> {
  const staging = join(output, 'npm-stage', 'package');
  await mkdir(staging, { recursive: true });
  await copyCandidate(candidate.directory, staging, true);
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: candidate.manifest.product.packageName,
        version: candidate.manifest.version,
        description: candidate.manifest.product.name,
        type: 'module',
        license: 'MIT',
        os: ['linux'],
        cpu: ['x64'],
        engines: { node: NODE_VERSION },
        bin: { [candidate.manifest.command]: 'npm-bin.mjs' },
        dependencies: {
          '@pxv/runtime': '0.1.0',
          '@pxv/extensions': '0.1.0',
          koffi: '3.3.3',
          '@koromix/koffi-linux-x64': '3.3.3',
        },
        bundledDependencies: ['@pxv/runtime', '@pxv/extensions', 'koffi', '@koromix/koffi-linux-x64'],
      },
      null,
      2,
    ),
  );
  await uniqueWrite(join(staging, 'npm-bin.mjs'), npmLauncher(candidate.manifest), 0o755);
  const file = join(output, `${candidate.manifest.id}.tgz`);
  await runner.run(
    [
      'tar',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      file,
      '-C',
      dirname(staging),
      'package',
    ],
    { timeoutMs: 120_000 },
  );
  return file;
}

async function deb(candidate: Candidate, output: string, runner: Runtime): Promise<string> {
  const manifest = candidate.manifest;
  const staging = join(output, 'deb-stage');
  await copyCandidate(candidate.directory, join(staging, 'opt', manifest.debName));
  await mkdir(join(staging, 'usr', 'bin'), { recursive: true });
  await symlink(
    `/opt/${manifest.debName}/bin/${manifest.command}`,
    join(staging, 'usr', 'bin', manifest.command),
  );
  const version = manifest.version.replace('-preview.', '~preview.');
  await uniqueWrite(
    join(staging, 'DEBIAN', 'control'),
    `Package: ${manifest.debName}\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: ${manifest.product.support.name} <${manifest.product.support.email}>\nDepends: libc6 (>= 2.28), libstdc++6, ca-certificates\nRecommends: adb, fastboot, apksigner, aapt, openjdk-17-jre-headless, openssh-client\nDescription: ${manifest.product.name.replace(/[\r\n]/gu, ' ')} local Pixel fleet provisioning\n Verified policy planning, supervised execution and durable recovery.\n`,
  );
  const file = join(output, `${manifest.debName}_${version}_amd64.deb`);
  await runner.run(['dpkg-deb', '--build', '--root-owner-group', staging, file], {
    timeoutMs: 120_000,
  });
  return file;
}

async function oci(
  candidate: Candidate,
  output: string,
  docker: string,
  loadDockerImage: boolean,
  runner: Runtime,
): Promise<string> {
  const context = join(output, 'oci-context');
  await copyCandidate(candidate.directory, join(context, 'candidate'));
  await uniqueWrite(join(context, 'Dockerfile'), dockerfile(candidate.manifest));
  const entrypoint = dockerEntrypoint();
  await uniqueWrite(join(context, 'entrypoint.sh'), entrypoint, 0o755);
  const file = join(output, `${candidate.manifest.id}.oci.tar`);
  const builder = `pxv-build-${randomUUID().slice(0, 12)}`;
  await runner.run(
    [
      docker,
      'buildx',
      'create',
      '--name',
      builder,
      '--driver',
      'docker-container',
      '--driver-opt',
      `image=${BUILDKIT_IMAGE}`,
    ],
    { timeoutMs: 60_000 },
  );
  try {
    await runner.run(
      [
        docker,
        'buildx',
        'build',
        '--builder',
        builder,
        '--platform',
        'linux/amd64',
        '--tag',
        `${candidate.manifest.product.image}:${candidate.manifest.version}`,
        '--output',
        `type=oci,dest=${file}`,
        '--provenance=mode=min',
        context,
      ],
      { timeoutMs: 86_400_000 },
    );
    if (loadDockerImage)
      await runner.run(
        [
          docker,
          'buildx',
          'build',
          '--builder',
          builder,
          '--platform',
          'linux/amd64',
          '--tag',
          `${candidate.manifest.product.image}:${candidate.manifest.version}`,
          '--load',
          '--provenance=false',
          context,
        ],
        { timeoutMs: 86_400_000 },
      );
  } finally {
    await runner.run([docker, 'buildx', 'rm', '--force', builder], { timeoutMs: 60_000, check: false });
  }
  return file;
}

async function sea(
  candidate: Candidate,
  output: string,
  postject: string | undefined,
  runner: Runtime,
): Promise<string> {
  if (!postject)
    throw new Error(
      'Experimental SEA requires an explicit postject executable; portable remains the supported baseline',
    );
  const directory = join(output, 'sea-experiment');
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'bootstrap.cjs');
  await uniqueWrite(
    source,
    `const{spawnSync}=require('node:child_process');const{join,dirname}=require('node:path');const root=process.env.PXV_SEA_RESOURCES;if(!root)throw new Error('Set PXV_SEA_RESOURCES to the matching immutable candidate');const child=spawnSync(join(root,'bin','node'),[join(root,'lib','main.js'),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,PXV_RESOURCE_ROOT:root,PXV_SUPERVISOR:join(root,'node_modules','@pxv/runtime','supervisor.js')}});process.exit(child.status??1);\n`,
  );
  const blob = join(directory, 'sea.blob');
  const config = join(directory, 'sea-config.json');
  await uniqueWrite(
    config,
    JSON.stringify({
      main: source,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  const node = join(candidate.directory, 'bin', 'node');
  const file = join(output, `${candidate.manifest.id}-experimental-sea`);
  await runner.run([node, '--experimental-sea-config', config]);
  await copyFile(node, file);
  await chmod(file, 0o755);
  await runner.run([
    postject,
    file,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
  return file;
}

async function buildFormat(
  format: DistributionFormat,
  candidate: Candidate,
  output: string,
  options: BuildFormatsOptions,
  runner: Runtime,
): Promise<string> {
  switch (format) {
    case 'portable':
      return await portable(candidate, output, runner);
    case 'npm':
      return await npm(candidate, output, runner);
    case 'deb':
      return await deb(candidate, output, runner);
    case 'oci':
      return await oci(
        candidate,
        output,
        options.docker ?? 'docker',
        options.loadDockerImage ?? true,
        runner,
      );
    case 'sea':
      return await sea(candidate, output, options.postject, runner);
    default:
      throw new Error('Unsupported distribution format');
  }
}
async function artifactEvidence(
  format: DistributionFormat,
  path: string,
  candidate: Candidate,
  options: BuildFormatsOptions,
): Promise<DistributionArtifact> {
  return {
    format,
    path,
    sha256: await hashFile(path),
    size: (await lstat(path)).size,
    ...(format === 'oci' && options.loadDockerImage !== false
      ? { image: `${candidate.manifest.product.image}:${candidate.manifest.version}` }
      : {}),
  };
}
async function writeProvenance(
  candidate: Candidate,
  output: string,
  artifacts: DistributionArtifact[],
  signed: boolean,
): Promise<string> {
  const provenancePath = join(output, 'provenance.json');
  await uniqueWrite(
    provenancePath,
    JSON.stringify(
      {
        schemaVersion: 2,
        candidateId: candidate.manifest.id,
        sourceDigest: candidate.manifest.sourceDigest,
        toolchain: candidate.manifest.toolchain,
        candidateManifestSha256: await hashFile(join(candidate.directory, 'candidate.json')),
        artifacts: artifacts.map(({ format, path, sha256, size }) => ({
          format,
          file: basename(path),
          sha256,
          size,
        })),
        signed,
      },
      null,
      2,
    ),
  );

  return provenancePath;
}
export async function buildFormats(
  candidate: Candidate,
  options: BuildFormatsOptions,
): Promise<DistributionArtifact[]> {
  const runner = options.runtime ?? new CommandRunner();
  candidate = { ...candidate, manifest: await verifiedBuildManifest(candidate) };
  if (!candidate.manifest.preview && !options.signingKey)
    throw new Error('Stable release artifacts require an explicit signing key');
  if (!options.formats.length || new Set(options.formats).size !== options.formats.length)
    throw new Error('Select unique distribution formats');
  const output = resolve(options.outputDirectory ?? join(dirname(candidate.directory), 'artifacts'));
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error('Artifact output must be empty; existing results are retained');
  const artifacts: DistributionArtifact[] = [];
  for (const format of options.formats) {
    const path = await buildFormat(format, candidate, output, options, runner);
    artifacts.push(await artifactEvidence(format, path, candidate, options));
  }
  const provenancePath = await writeProvenance(
    candidate,
    output,
    artifacts,
    options.signingKey !== undefined,
  );
  // Provenance is part of the same signed byte set as every installable artifact.
  const checksums =
    [
      ...artifacts.map((artifact) => `${artifact.sha256}  ${basename(artifact.path)}`),
      `${await hashFile(provenancePath)}  provenance.json`,
    ].join('\n') + '\n';
  const checksumPath = join(output, 'SHA256SUMS');
  await uniqueWrite(checksumPath, checksums);
  if (options.signingKey) {
    await runner.run([
      'ssh-keygen',
      '-Y',
      'sign',
      '-f',
      resolve(options.signingKey),
      '-n',
      'pxv-release',
      checksumPath,
    ]);
  }
  await verifyCandidate(candidate.directory);
  return artifacts;
}

interface ReleaseProvenance {
  schemaVersion: 2;
  candidateId: string;
  sourceDigest: string;
  toolchain: CandidateManifest['toolchain'];
  candidateManifestSha256: string;
  artifacts: { format: DistributionFormat; file: string; sha256: string; size: number }[];
  signed: boolean;
}
const RELEASE_HASH = /^[a-f0-9]{64}$/u;
const RELEASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,254}$/u;
function provenanceRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid release provenance record');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error('Invalid release provenance fields');
  return record;
}
function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}
function toolchainVersions(toolchain: Record<string, unknown>): void {
  if (
    toolchain.node !== NODE_VERSION ||
    !matches(toolchain.typescript, /^(?:npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@)?\d+\.\d+\.\d+$/u)
  )
    throw new Error('Invalid release provenance toolchain');
  if (toolchain.pnpm !== 'pnpm@12.11.2') throw new Error('Invalid release provenance toolchain');
  if (
    toolchain.addonVersion !== '3.3.3' ||
    toolchain.addonPlatform !== 'linux_x64' ||
    toolchain.addonNodeApi !== 8
  )
    throw new Error('Invalid release provenance addon baseline');
}
function toolchainDigests(toolchain: Record<string, unknown>): void {
  for (const key of ['nodeSha256', 'supervisorSha256', 'addonSha256', 'loaderSha256'])
    if (!matches(toolchain[key], RELEASE_HASH)) throw new Error('Invalid release provenance toolchain');
  for (const key of ['dockerBase', 'buildkitImage'])
    if (!matches(toolchain[key], /^[a-zA-Z0-9/._:-]+@sha256:[a-f0-9]{64}$/u))
      throw new Error('Invalid release provenance toolchain');
}
function toolchainArchives(toolchain: Record<string, unknown>): void {
  if (
    !matches(toolchain.debianSnapshot, /^\d{8}T\d{6}Z$/u) ||
    !Array.isArray(toolchain.androidArchives) ||
    !toolchain.androidArchives.length ||
    toolchain.androidArchives.length > 32
  )
    throw new Error('Invalid release provenance toolchain');
  const archives = new Set<string>();
  for (const value of toolchain.androidArchives) {
    const archive = provenanceRecord(value, ['filename', 'sha256']);
    if (
      !matches(archive.filename, RELEASE_FILE) ||
      !matches(archive.sha256, RELEASE_HASH) ||
      archives.has(String(archive.filename))
    )
      throw new Error('Invalid release provenance Android archive');
    archives.add(String(archive.filename));
  }
}
function validateToolchain(value: unknown): void {
  const toolchain = provenanceRecord(value, [
    'node',
    'nodeSha256',
    'supervisorSha256',
    'typescript',
    'pnpm',
    'addonVersion',
    'addonPlatform',
    'addonNodeApi',
    'addonSha256',
    'loaderSha256',
    'dockerBase',
    'buildkitImage',
    'debianSnapshot',
    'androidArchives',
  ]);

  toolchainVersions(toolchain);
  toolchainDigests(toolchain);
  toolchainArchives(toolchain);
}
function artifactContents(artifact: Record<string, unknown>): void {
  if (
    !matches(artifact.sha256, RELEASE_HASH) ||
    typeof artifact.size !== 'number' ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0
  )
    throw new Error('Invalid release provenance artifact');
}
function validateArtifactRecord(value: unknown): Record<string, unknown> {
  const artifact = provenanceRecord(value, ['format', 'file', 'sha256', 'size']);
  if (
    typeof artifact.format !== 'string' ||
    !['portable', 'deb', 'npm', 'oci', 'sea'].includes(artifact.format) ||
    !matches(artifact.file, RELEASE_FILE) ||
    artifact.file === 'provenance.json' ||
    artifact.file === 'SHA256SUMS'
  )
    throw new Error('Invalid release provenance artifact');

  artifactContents(artifact);
  return artifact;
}
function validateArtifactSet(record: Record<string, unknown>): void {
  if (!Array.isArray(record.artifacts) || !record.artifacts.length || record.artifacts.length > 5)
    throw new Error('Invalid release provenance artifacts');

  const files = new Set<string>(),
    formats = new Set<string>();
  for (const value of record.artifacts as unknown[]) {
    const artifact = validateArtifactRecord(value);
    if (files.has(String(artifact.file)) || formats.has(String(artifact.format)))
      throw new Error('Invalid release provenance artifact');
    files.add(String(artifact.file));
    formats.add(String(artifact.format));
  }
}
function validateProvenance(value: unknown): ReleaseProvenance {
  const record = provenanceRecord(value, [
    'schemaVersion',
    'candidateId',
    'sourceDigest',
    'toolchain',
    'candidateManifestSha256',
    'artifacts',
    'signed',
  ]);
  if (record.schemaVersion !== 2)
    throw new Error('Release provenance schema 2 required; regenerate the candidate and distributions');
  if (
    record.schemaVersion !== 2 ||
    !matches(record.candidateId, RELEASE_FILE) ||
    !matches(record.sourceDigest, RELEASE_HASH) ||
    !matches(record.candidateManifestSha256, RELEASE_HASH) ||
    typeof record.signed !== 'boolean'
  )
    throw new Error('Invalid release provenance identity');

  validateToolchain(record.toolchain);
  validateArtifactSet(record);
  return record as unknown as ReleaseProvenance;
}

function checksumRecord(line: string, checksums: Map<string, string>): [string, string, string] {
  const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
  if (
    !match?.[1] ||
    !match[2] ||
    !RELEASE_FILE.test(match[2]) ||
    checksums.has(match[2]) ||
    match[2] === 'SHA256SUMS' ||
    match[2] === 'SHA256SUMS.sig'
  )
    throw new Error('Invalid release checksum record');

  return [match[0], match[1], match[2]];
}

/** @internal Shared release verification used by promotion and independent artifact acceptance. */
export async function verifyArtifacts(directory: string): Promise<void> {
  const lines = (await readBounded(join(directory, 'SHA256SUMS'), 1024 * 1024))
    .toString('utf8')
    .trim()
    .split('\n');
  const checksums = new Map<string, string>();
  for (const line of lines) {
    const match = checksumRecord(line, checksums);
    checksums.set(match[2], match[1]);
    if ((await hashFile(join(directory, match[2]))) !== match[1])
      throw new Error('Release artifact checksum mismatch');
  }
  if (!checksums.has('provenance.json')) throw new Error('Release provenance is absent from checksums');
  const provenance = validateProvenance(
    parseDocument((await readBounded(join(directory, 'provenance.json'), 1024 * 1024)).toString('utf8')),
  );
  if (checksums.size !== provenance.artifacts.length + 1)
    throw new Error('Release provenance does not cover the complete checksum set');
  for (const artifact of provenance.artifacts) {
    if (
      checksums.get(artifact.file) !== artifact.sha256 ||
      (await lstat(join(directory, artifact.file))).size !== artifact.size
    )
      throw new Error('Release provenance artifact does not match reviewed bytes');
  }
  if (provenance.signed) await readBounded(join(directory, 'SHA256SUMS.sig'), 16 * 1024);
}

export interface PromotionOptions {
  runtime?: Runtime;
  artifactDirectory: string;
  registry: string;
  packageFile: string;
  allowedSigners: string;
  signer: string;
  dryRun?: boolean;
}
/** Publication is a separate explicit command and accepts only verified signed
 * artifacts. Authentication remains in npm's external credential configuration. */
export async function promoteNpm(options: PromotionOptions): Promise<void> {
  const runner = options.runtime ?? new CommandRunner();
  const registry = promotionRegistry(options.registry);
  const directory = resolve(options.artifactDirectory);
  await verifyArtifacts(directory);
  const packageFile = resolve(options.packageFile);
  if (dirname(packageFile) !== directory || !packageFile.endsWith('.tgz'))
    throw new Error('Promotion requires a reviewed npm artifact from this candidate');
  const provenance = validateProvenance(
    parseDocument((await readBounded(join(directory, 'provenance.json'), 1024 * 1024)).toString('utf8')),
  );
  if (
    !provenance.signed ||
    !provenance.artifacts.some(
      (artifact) => artifact.format === 'npm' && artifact.file === basename(packageFile),
    )
  )
    throw new Error('Promotion requires an npm artifact identified by signed release provenance');
  const checksums = await readBounded(join(directory, 'SHA256SUMS'), 1024 * 1024);
  await runner.run(
    [
      'ssh-keygen',
      '-Y',
      'verify',
      '-f',
      resolve(options.allowedSigners),
      '-I',
      options.signer,
      '-n',
      'pxv-release',
      '-s',
      join(directory, 'SHA256SUMS.sig'),
    ],
    { input: checksums },
  );
  if (!options.dryRun)
    await runner.run(['npm', 'publish', packageFile, '--registry', registry.href, '--ignore-scripts'], {
      timeoutMs: 120_000,
    });
}

function promotionRegistry(value: string): URL {
  const registry = new URL(value);
  if (
    registry.protocol !== 'https:' ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash
  )
    throw new Error('Promotion registry must be credential-free HTTPS');
  return registry;
}

async function verifiedBuildManifest(candidate: Candidate): Promise<CandidateManifest> {
  const verified = await verifyCandidate(candidate.directory);
  if (canonicalJson(verified) !== canonicalJson(candidate.manifest))
    throw new Error('Candidate metadata differs from the frozen manifest');
  return verified;
}
