import { shellLauncher } from './launchers.js';
import { build, type Metafile } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  canonicalJson,
  parseDocument,
  validatePolicy,
  validateProduct,
  type ProductDescriptor,
} from '@pxv/contracts';
import { CommandRunner, hashFile, readBounded, supervisorPath, type Runtime } from '@pxv/runtime';
import { validateAddon, installKoffi, koffiFiles } from './native.js';

export const NODE_VERSION = '24.22.0';
export const DOCKER_BASE =
  'debian:12-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91';
export const DEBIAN_SNAPSHOT = '20261015T000000Z';
export const BUILDKIT_IMAGE =
  'moby/buildkit:v0.20.2@sha256:8c8514715aab54e12f65b6a38a219084ab926d49c52d519ac17a8e79befb9c75';
export const ANDROID_ARCHIVES = [
  {
    filename: 'platform-tools_r37.0.1-linux.zip',
    sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
    destination: '/opt/platform-tools',
  },
  {
    filename: 'platform-35_r02.zip',
    sha256: '0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0',
    destination: '/opt/android-sdk/platforms/android-35',
  },
  {
    filename: 'build-tools_r35_linux.zip',
    sha256: 'bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88',
    destination: '/opt/android-sdk/build-tools/35.0.0',
  },
] as const;
const PUBLIC_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.md',
  '.html',
  '.css',
  '.java',
  '.kt',
  '.xml',
  '.txt',
  '.sh',
  '.pub',
  '.woff2',
  '.ttf',
  '.mjs',
]);
const OMIT_DIRECTORIES = new Set(['build', 'dist', 'node_modules', '.git', '.venv', '__pycache__']);
const PUBLIC_DOCUMENTS = [
  'SECURITY.md',
  'CONTRIBUTING.md',
  'guides/README.md',
  'guides/index.html',
  'guides/source/BUILD.txt',
  'guides/source/build-manifest.json',
];
const PRIVATE_PART =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.aws|\.codex|\.agents|secrets|state|cache|backups|credentials(?:\.[^/]*)?|signing-password(?:\.[^/]*)?)(?:\/|$)|\.(?:keystore|jks|p12|key|pem)$/u;

export interface CandidateOptions {
  runtime?: Runtime;
  sourceRoot?: string;
  outputRoot?: string;
  preview?: boolean;
  nodePath?: string;
  supervisorEntry?: string;
}
interface FileEvidence {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}
export interface CandidateManifest {
  schemaVersion: 2;
  id: string;
  version: string;
  preview: boolean;
  product: ProductDescriptor;
  command: string;
  debName: string;
  sourceDigest: string;
  source: { revision: string | null; dirty: boolean; files: FileEvidence[] };
  toolchain: {
    node: string;
    nodeSha256: string;
    supervisorSha256: string;
    typescript: string;
    pnpm: string;
    addonVersion: '3.3.3';
    addonPlatform: 'linux_x64';
    addonNodeApi: 8;
    addonSha256: string;
    loaderSha256: string;
    dockerBase: string;
    buildkitImage: string;
    debianSnapshot: string;
    androidArchives: { filename: string; sha256: string }[];
  };
  createdAt: string;
  files: FileEvidence[];
}
export interface Candidate {
  root: string;
  directory: string;
  manifest: CandidateManifest;
}

function publicPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || part === '.') ||
    PRIVATE_PART.test(path)
  )
    throw new Error(`Forbidden release resource path: ${path}`);
}

export async function walkPublic(
  root: string,
  subdirectory: string,
  extensions = PUBLIC_EXTENSIONS,
): Promise<string[]> {
  publicPath(subdirectory);
  const absolute = join(root, subdirectory);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return [];
  if (metadata.isSymbolicLink()) throw new Error(`Release inputs cannot contain symlinks: ${subdirectory}`);
  if (metadata.isFile()) {
    publicPath(subdirectory);
    return extensions.has(extname(subdirectory)) ||
      /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[._-]|$)/iu.test(basename(subdirectory))
      ? [subdirectory]
      : [];
  }
  if (!metadata.isDirectory()) throw new Error(`Release input must be a regular file: ${subdirectory}`);
  const files: string[] = [];
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (OMIT_DIRECTORIES.has(entry.name)) continue;
    const path = `${subdirectory}/${entry.name}`;
    publicPath(path);
    files.push(...(await walkPublic(root, path, extensions)));
  }
  return files;
}

async function isSourceFile(root: string, name: string): Promise<boolean> {
  const file = await lstat(join(root, name)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (file?.isSymbolicLink()) throw new Error(`Release inputs cannot contain symlinks: ${name}`);
  return file?.isFile() ?? false;
}

async function packageSources(root: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const name of await readdir(join(root, 'packages'))) {
    if (!/^[a-z-]+$/u.test(name)) throw new Error('Invalid source package name');
    for (const file of await walkPublic(root, `packages/${name}/src`, new Set(['.ts']))) paths.add(file);
    for (const file of await walkPublic(root, `packages/${name}/package.json`)) paths.add(file);
    for (const file of await walkPublic(root, `packages/${name}/tsconfig.json`)) paths.add(file);
  }

  return [...paths];
}

async function sourceFiles(root: string): Promise<string[]> {
  const paths = new Set<string>();
  const roots = [
    'product.json',
    'assets',
    'policy-packs',
    'manifests',
    'config/templates',
    'starter',
    'resources',
    'android',
    'guides/source/markdown',
    'guides/assets',
    ...PUBLIC_DOCUMENTS,
    'docs',
    'tools/build-android.mjs',
    'tools/lib/build-command.mjs',
    'tools/lib/android-build.mjs',
    'tools/check-native-baseline.mjs',
  ];
  for (const path of roots) for (const file of await walkPublic(root, path)) paths.add(file);
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'LICENSE',
  ]) {
    if (await isSourceFile(root, name)) paths.add(name);
  }
  for (const file of await packageSources(root)) paths.add(file);
  return [...paths].sort();
}

async function evidence(root: string, paths: string[]): Promise<FileEvidence[]> {
  return await Promise.all(
    paths.map(async (path) => {
      const stat = await lstat(join(root, path));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release file changed type: ${path}`);
      return {
        path,
        sha256: await hashFile(join(root, path)),
        size: stat.size,
        executable: (stat.mode & 0o111) !== 0,
      };
    }),
  );
}

async function destinationWrite(path: string, data: string, executable = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, data, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
}

async function copy(root: string, path: string, destination: string): Promise<void> {
  publicPath(path);
  const origin = join(root, path);
  const actual = await realpath(origin);
  if (actual !== resolve(origin) || !actual.startsWith(`${root}${sep}`))
    throw new Error(`Release resource escapes source root: ${path}`);
  if (!(await lstat(origin)).isFile()) throw new Error('Release resources must be regular files');
  const target = join(destination, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(origin, target);
  await chmod(target, 0o644);
}

async function bundled(root: string, directory: string): Promise<Metafile[]> {
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node' as const,
    target: 'node24',
    format: 'esm' as const,
    metafile: true as const,
    legalComments: 'eof' as const,
    banner: {
      js: 'import { createRequire as __pxvCreateRequire } from "node:module";const require=__pxvCreateRequire(import.meta.url);',
    },
  };
  const jobs = [
    { entry: 'packages/cli/src/main.ts', out: 'lib/main.js', external: ['@pxv/runtime', '@pxv/extensions'] },
    {
      entry: 'packages/runtime/src/index.ts',
      out: 'node_modules/@pxv/runtime/index.js',
      external: ['koffi', '@koromix/koffi-linux-x64'],
    },
    {
      entry: 'packages/runtime/src/supervisor.ts',
      out: 'node_modules/@pxv/runtime/supervisor.js',
      external: ['koffi', '@koromix/koffi-linux-x64'],
    },
    { entry: 'packages/runtime/src/worker.ts', out: 'node_modules/@pxv/runtime/worker.js', external: [] },
    {
      entry: 'packages/extensions/src/index.ts',
      out: 'node_modules/@pxv/extensions/index.js',
      external: ['@pxv/runtime'],
    },
    {
      entry: 'packages/extensions/src/worker.ts',
      out: 'node_modules/@pxv/extensions/worker.js',
      external: ['@pxv/runtime'],
    },
  ];
  const manifests: Metafile[] = [];
  for (const job of jobs) {
    const result = await build({
      ...common,
      entryPoints: [job.entry],
      outfile: join(directory, job.out),
      external: job.external,
    });
    manifests.push(result.metafile);
  }
  for (const name of ['runtime', 'extensions'])
    await destinationWrite(
      join(directory, 'node_modules', `@pxv/${name}`, 'package.json'),
      JSON.stringify({
        name: `@pxv/${name}`,
        version: '0.1.0',
        type: 'module',
        exports: './index.js',
        ...(name === 'runtime'
          ? { dependencies: { koffi: '3.3.3', '@koromix/koffi-linux-x64': '3.3.3' } }
          : {}),
      }),
    );
  return manifests;
}

interface ThirdParty {
  name: string;
  version: string;
  license: string;
  directory: string;
  ecosystem: 'npm';
  checksum?: string;
}
async function npmDependency(root: string, file: string): Promise<ThirdParty | undefined> {
  let cursor = dirname(resolve(root, file));
  while (cursor !== dirname(cursor)) {
    const metadata = await readFile(join(cursor, 'package.json'), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata) {
      const data = JSON.parse(metadata) as { name?: string; version?: string; license?: string };
      if (data.name && data.version) {
        return {
          name: data.name,
          version: data.version,
          license: typeof data.license === 'string' ? data.license : 'NOASSERTION',
          directory: cursor,
          ecosystem: 'npm',
        };
      }
    }
    cursor = dirname(cursor);
  }

  return undefined;
}

async function notices(root: string, directory: string, metafiles: Metafile[]): Promise<ThirdParty[]> {
  const found = new Map<string, ThirdParty>();
  for (const path of koffiFiles(root)) {
    const dependency = await npmDependency(root, path);
    if (dependency) found.set('npm:' + dependency.name, dependency);
  }
  for (const metafile of metafiles)
    for (const file of Object.keys(metafile.inputs)) {
      if (!file.includes('node_modules/')) continue;
      const dependency = await npmDependency(root, file);
      if (dependency) found.set(`npm:${dependency.name}@${dependency.version}`, dependency);
    }
  const packages = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  let text = 'Third-party components bundled in this engine candidate.\n\n';
  for (const dependency of packages) {
    text += `${dependency.ecosystem}:${dependency.name}@${dependency.version} (${dependency.license})\n`;
    const names = (await readdir(dependency.directory)).filter((name) =>
      /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[._-]|$)/iu.test(name),
    );
    for (const name of names) {
      const source = join(dependency.directory, name);
      if (!(await lstat(source)).isFile()) continue;
      const content = (await readBounded(source, 2 * 1024 * 1024)).toString('utf8');
      text += `\n${content}\n`;
    }
    text += '\n';
  }
  await destinationWrite(join(directory, 'THIRD-PARTY-NOTICES.txt'), text);
  return packages;
}

async function freeze(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await freeze(path);
    else {
      const stat = await lstat(path);
      await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function walkCandidate(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Candidate cannot contain symlinks');
    if (entry.isDirectory()) result.push(...(await walkCandidate(directory, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Candidate contains a special file');
  }
  return result;
}

/** Freeze one candidate before deriving any installable format. Never reads
 * operator projects, local configuration, environment files or signing keys. */
interface BuildContext {
  root: string;
  product: ProductDescriptor;
  source: FileEvidence[];
  digest: string;
  now: Date;
  nonce: string;
  preview: boolean;
  version: string;
  id: string;
  directory: string;
}
function validateReleaseProduct(product: ProductDescriptor): void {
  if (!/^[a-z][a-z0-9-]{0,50}$/u.test(product.command) || !/^[a-z][a-z0-9-]{0,50}$/u.test(product.debName))
    throw new Error('Product executable and package names must be safe Linux names');
  if (
    /[\r\n]/u.test(product.name) ||
    /[\r\n]/u.test(product.support.name) ||
    !/^[a-z0-9][a-z0-9./:_-]*$/u.test(product.image)
  )
    throw new Error('Invalid release product metadata');
}
async function prepareCandidate(options: CandidateOptions): Promise<BuildContext> {
  const root = await realpath(options.sourceRoot ?? process.cwd());
  const product = validateProduct(
    parseDocument((await readBounded(join(root, 'product.json'), 64 * 1024)).toString('utf8')),
  );
  validateReleaseProduct(product);
  const source = await evidence(root, await sourceFiles(root));
  const digest = createHash('sha256').update(canonicalJson(source)).digest('hex');
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/gu, '')
    .slice(0, 14);
  const nonce = randomUUID().slice(0, 8);
  const preview = options.preview ?? true;
  const version = preview ? `0.1.0-preview.${stamp}.${nonce}` : '0.1.0';
  const id = `${product.id}-${version}-${digest.slice(0, 12)}`;
  const outputRoot = resolve(options.outputRoot ?? join(root, 'dist', 'preview'));
  const directory = join(outputRoot, id, 'candidate');
  await mkdir(directory, { recursive: true, mode: 0o755 });
  if ((await readdir(directory)).length) throw new Error('Candidate output already exists');

  return { root, product, source, digest, now, nonce, preview, version, id, directory };
}
async function validateSupervisor(entry: string, node: string, runner: Runtime): Promise<void> {
  const info = JSON.parse((await runner.run([node, entry, '--build-info'])).stdout) as Record<
    string,
    unknown
  >;
  if (
    info['protocol'] !== 1 ||
    info['addon'] !== '3.3.3' ||
    info['platform'] !== 'linux_x64' ||
    info['nodeApi'] !== 8 ||
    info['pidfd'] !== true ||
    info['subreaper'] !== true
  )
    throw new Error('Supervisor addon/kernel capabilities are incompatible');
}
async function releaseBinaries(
  options: CandidateOptions,
): Promise<{ nodePath: string; supervisorEntry: string }> {
  const runner = options.runtime ?? new CommandRunner();
  const nodePath = options.nodePath ?? process.execPath;
  const supervisorEntry = options.supervisorEntry ?? (await supervisorPath());
  if ((await runner.run([nodePath, '--version'])).stdout.trim() !== `v${NODE_VERSION}`)
    throw new Error(`Release requires Node ${NODE_VERSION}`);
  await validateSupervisor(supervisorEntry, nodePath, runner);
  for (const binary of [nodePath, supervisorEntry])
    if (!(await lstat(binary)).isFile() || (await lstat(binary)).isSymbolicLink())
      throw new Error('Bundled binaries must be regular files');

  return { nodePath, supervisorEntry };
}
async function copyPublicResources(context: BuildContext): Promise<void> {
  const { root, directory, product, source } = context;
  const publicFiles = source
    .map((file) => file.path)
    .filter(
      (path) =>
        path === 'product.json' ||
        path === 'LICENSE' ||
        PUBLIC_DOCUMENTS.includes(path) ||
        /^(?:assets|policy-packs|manifests|config\/templates|resources|android|guides\/assets|guides\/source\/markdown|docs)\//u.test(
          path,
        ) ||
        path === 'tools/build-android.mjs' ||
        path === 'tools/lib/build-command.mjs' ||
        path === 'tools/lib/android-build.mjs',
    );
  for (const path of publicFiles) await copy(root, path, directory);
  for (const path of [product.defaultPolicy, ...Object.values(product.assets)])
    if (!publicFiles.includes(path))
      throw new Error('Declared product policy or asset is absent from public release resources');
  validatePolicy(
    parseDocument(
      (await readBounded(join(directory, product.defaultPolicy), 2 * 1024 * 1024)).toString('utf8'),
    ),
  );
}
async function installRuntimes(
  root: string,
  directory: string,
  nodePath: string,
  supervisorEntry: string,
): Promise<Metafile[]> {
  const metafiles = await bundled(root, directory);
  await mkdir(join(directory, 'bin'), { recursive: true });
  await copyFile(nodePath, join(directory, 'bin', 'node'));
  await chmod(join(directory, 'bin', 'node'), 0o755);
  await installKoffi(root, directory);
  await validateAddon(root);
  // Bundle the selected entrypoint, including an explicitly supplied override.
  await build({
    entryPoints: [supervisorEntry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['koffi', '@koromix/koffi-linux-x64'],
    outfile: join(directory, 'node_modules/@pxv/runtime/supervisor.js'),
  });
  await validateSupervisor(
    join(directory, 'node_modules/@pxv/runtime/supervisor.js'),
    join(directory, 'bin/node'),
    new CommandRunner(),
  );
  const nodeLicense = join(dirname(nodePath), '..', 'LICENSE');
  await destinationWrite(
    join(directory, 'NODE-LICENSE.txt'),
    (await readBounded(nodeLicense, 2 * 1024 * 1024)).toString('utf8'),
  );

  return metafiles;
}
async function candidateToolchain(
  root: string,
  directory: string,
  nodePath: string,
): Promise<{ toolchain: CandidateManifest['toolchain'] }> {
  const workspace = JSON.parse(
    (await readBounded(join(root, 'package.json'), 1024 * 1024)).toString('utf8'),
  ) as { packageManager: string; devDependencies: Record<string, string> };
  const toolchain: CandidateManifest['toolchain'] = {
    node: NODE_VERSION,
    nodeSha256: await hashFile(nodePath),
    supervisorSha256: await hashFile(join(directory, 'node_modules/@pxv/runtime/supervisor.js')),
    typescript:
      workspace.devDependencies['@typescript/native'] ?? workspace.devDependencies['typescript'] ?? 'unknown',
    pnpm: workspace.packageManager,
    addonVersion: '3.3.3',
    addonPlatform: 'linux_x64',
    addonNodeApi: 8,
    addonSha256: await hashFile(
      join(directory, 'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node'),
    ),
    loaderSha256: await hashFile(join(directory, 'node_modules/koffi/src/koffi/index.cjs')),
    dockerBase: DOCKER_BASE,
    buildkitImage: BUILDKIT_IMAGE,
    debianSnapshot: DEBIAN_SNAPSHOT,
    androidArchives: ANDROID_ARCHIVES.map(({ filename, sha256 }) => ({ filename, sha256 })),
  };
  return { toolchain };
}
async function sourceRevision(
  root: string,
  runner: Runtime,
): Promise<Pick<CandidateManifest['source'], 'revision' | 'dirty'>> {
  const revision = await runner.run(['git', '-C', root, 'rev-parse', 'HEAD'], { check: false });
  const dirty = await runner.run(['git', '-C', root, 'status', '--porcelain', '--untracked-files=normal'], {
    check: false,
  });
  return {
    revision: revision.code === 0 ? revision.stdout.trim() : null,
    dirty: dirty.code !== 0 || dirty.stdout.length > 0,
  };
}
function spdxPackage(name: string, id: string, version: string, license: string, location = 'NOASSERTION') {
  return {
    name,
    SPDXID: `SPDXRef-${id}`,
    versionInfo: version,
    downloadLocation: location,
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
  };
}
function dependencyPackage(dependency: ThirdParty, index: number) {
  const location = 'NOASSERTION';
  return {
    ...spdxPackage(dependency.name, `dependency-${index}`, dependency.version, dependency.license, location),
    ...(dependency.checksum
      ? { checksums: [{ algorithm: 'SHA256', checksumValue: dependency.checksum }] }
      : {}),
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:${dependency.ecosystem}/${dependency.name}@${dependency.version}`,
      },
    ],
  };
}
async function writeSbom(
  context: BuildContext,
  manifest: CandidateManifest,
  dependencies: ThirdParty[],
): Promise<void> {
  const { directory, product, id, now } = context;
  const packages = [
    spdxPackage(product.name, 'pxv', '0.1.0', 'MIT'),
    {
      ...spdxPackage(
        'Node.js',
        'Node',
        NODE_VERSION,
        'MIT',
        `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
      ),
      checksums: [{ algorithm: 'SHA256', checksumValue: manifest.toolchain.nodeSha256 }],
      attributionTexts: ['See NODE-LICENSE.txt for Node.js and bundled third-party notices.'],
    },
    {
      ...spdxPackage('pxv-supervisor', 'supervisor', '0.1.0', 'MIT'),
      checksums: [{ algorithm: 'SHA256', checksumValue: manifest.toolchain.supervisorSha256 }],
    },
    ...dependencies.map(dependencyPackage),
  ];
  await destinationWrite(
    join(directory, 'sbom.spdx.json'),
    JSON.stringify(
      {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: id,
        documentNamespace: `https://pxv.invalid/spdx/${randomUUID()}`,
        creationInfo: { created: now.toISOString(), creators: ['Tool: pxv-release-0.1.0'] },
        packages,
      },
      null,
      2,
    ),
  );
}

export async function createCandidate(options: CandidateOptions = {}): Promise<Candidate> {
  const context = await prepareCandidate(options);
  const { root, directory, product, source, digest, now, nonce, preview, version, id } = context;
  const { nodePath, supervisorEntry } = await releaseBinaries(options);
  await copyPublicResources(context);
  const metafiles = await installRuntimes(root, directory, nodePath, supervisorEntry);
  const command = preview ? `${product.command}-preview-${nonce}` : product.command;
  const debName = preview ? `${product.debName}-preview-${nonce}` : product.debName;
  await destinationWrite(join(directory, 'bin', command), shellLauncher(preview ? id : undefined), true);
  const dependencies = await notices(root, directory, metafiles);
  await destinationWrite(
    join(directory, 'package.json'),
    JSON.stringify({ name: product.packageName, version, type: 'module', private: true }, null, 2),
  );
  const { toolchain } = await candidateToolchain(root, directory, nodePath);
  const manifest: CandidateManifest = {
    schemaVersion: 2,
    id,
    version,
    preview,
    product,
    command,
    debName,
    sourceDigest: digest,
    source: { ...(await sourceRevision(root, options.runtime ?? new CommandRunner())), files: source },
    toolchain,
    createdAt: now.toISOString(),
    files: [],
  };
  await writeSbom(context, manifest, dependencies);
  const finalSource = await evidence(root, await sourceFiles(root));
  if (canonicalJson(finalSource) !== canonicalJson(source))
    throw new Error('Source inputs changed during build; retry with a stable working tree');
  manifest.files = await evidence(directory, await walkCandidate(directory));
  await destinationWrite(join(directory, 'candidate.json'), JSON.stringify(manifest, null, 2));
  await freeze(directory);
  return { root, directory, manifest };
}

export async function verifyCandidate(directory: string): Promise<CandidateManifest> {
  const manifest = JSON.parse(
    (await readBounded(join(directory, 'candidate.json'), 16 * 1024 * 1024)).toString('utf8'),
  ) as CandidateManifest;
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(manifest.files) ||
    typeof manifest.sourceDigest !== 'string'
  )
    throw new Error('Candidate schema 2 required; regenerate this candidate with pnpm build:preview');
  const actual = await evidence(
    directory,
    (await walkCandidate(directory)).filter((path) => path !== 'candidate.json'),
  );
  if (canonicalJson(actual) !== canonicalJson(manifest.files))
    throw new Error('Frozen candidate contents changed');
  return manifest;
}

export async function copyCandidate(source: string, destination: string, omitNode = false): Promise<void> {
  await verifyCandidate(source);
  for (const path of await walkCandidate(source)) {
    if (omitNode && path === 'bin/node') continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(join(source, path), target);
    const stat = await lstat(join(source, path));
    await chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}
