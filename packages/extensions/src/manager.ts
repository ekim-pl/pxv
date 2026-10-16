import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { extract, list } from 'tar';
import {
  canonicalJson,
  parseDocument,
  validateAction,
  validateExtension,
  validatePolicy,
} from '@pxv/contracts';
import type { Action, ExtensionLock, PolicyPack } from '@pxv/contracts';
import { readBounded } from '@pxv/runtime';
import { safeRelativePath, validateMetadata } from './metadata.js';
import type { ExtensionMetadata } from './metadata.js';

export type ExtensionSource = { tarball: string; integrity?: string } | { package: string; version: string };
export interface ExtensionManagerOptions {
  installRoot: string;
  registry?: string;
  token?: string;
  fetch?: typeof fetch;
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
}
interface ArchiveEntry {
  path: string;
  size: number;
  sha256: string;
}

const hash = (value: Uint8Array): string => createHash('sha512').update(value).digest('base64');
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function archiveEntries(file: string, maxExpandedBytes: number): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const completions: Promise<void>[] = [];
  let total = 0;
  let invalid: string | undefined;
  const names = new Set<string>();
  await list({
    file,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/\/$/u, '');
      if (!path.startsWith('package/') && path !== 'package')
        invalid = 'Extension tarball must have a package/ root';
      const relative = path.slice('package/'.length);
      if (path !== 'package' && !safeRelativePath(relative)) invalid = 'Unsafe extension archive path';
      if (entry.type !== 'File' && entry.type !== 'Directory')
        invalid = 'Extension archives cannot contain links or special files';
      if (names.has(path)) invalid = 'Duplicate extension archive path';
      names.add(path);
      if (relative.split('/').some((part) => ['.npmrc', '.env', 'node_modules'].includes(part)))
        invalid = 'Extension archives cannot contain credentials or runtime dependencies';
      total += entry.size;
      if (total > maxExpandedBytes) invalid = 'Expanded extension archive exceeds size limit';
      if (entry.type === 'File') {
        const digest = createHash('sha256');
        completions.push(
          new Promise<void>((resolveEntry, reject) => {
            entry.on('data', (chunk: Buffer) => digest.update(chunk));
            entry.on('end', () => {
              entries.push({ path: relative, size: entry.size, sha256: digest.digest('hex') });
              resolveEntry();
            });
            entry.on('error', reject);
          }),
        );
      }
    },
  });
  await Promise.all(completions);
  if (invalid) throw new Error(invalid);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function validateTree(directory: string, entries: ArchiveEntry[]): Promise<void> {
  const expected = new Set(entries.map((entry) => entry.path));
  const scan = async (at: string, prefix = ''): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error('Installed extension contains a symlink');
      if (item.isDirectory()) await scan(join(at, item.name), path);
      else if (
        !item.isFile() ||
        (!expected.has(path) && !['.pxv-archive.tgz', '.pxv-lock.json'].includes(path))
      )
        throw new Error('Installed extension has unexpected files');
    }
  };
  await scan(directory);
  for (const entry of entries) {
    const content = await readBounded(join(directory, entry.path), entry.size);
    if (
      content.byteLength !== entry.size ||
      createHash('sha256').update(content).digest('hex') !== entry.sha256
    )
      throw new Error('Installed extension content does not match its pinned archive');
  }
}

async function metadataAt(directory: string): Promise<ExtensionMetadata> {
  const metadata = validateMetadata(
    parseDocument((await readBounded(join(directory, 'pxv-extension.json'), 1024 * 1024)).toString('utf8')),
  );
  const parsed = parseDocument(
    (await readBounded(join(directory, 'package.json'), 1024 * 1024)).toString('utf8'),
  );
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid extension package manifest');
  const manifest = parsed as Record<string, unknown>;
  if (
    manifest['name'] !== metadata.id ||
    manifest['version'] !== metadata.version ||
    manifest['main'] !== metadata.entry ||
    manifest['type'] !== 'module'
  )
    throw new Error('Extension package identity or entry does not match metadata');
  for (const key of [
    'scripts',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
  ]) {
    const value = manifest[key];
    if (value !== undefined && (value === null || typeof value !== 'object' || Object.keys(value).length > 0))
      throw new Error('Extension bundles must not contain lifecycle scripts or dependencies');
  }
  for (const path of [
    metadata.entry,
    ...metadata.contributions.policyPacks,
    ...metadata.contributions.guides,
    ...metadata.contributions.adapters,
  ]) {
    if (!(await lstat(join(directory, path))).isFile())
      throw new Error('Extension contribution must be a regular file');
  }
  return metadata;
}

export class ExtensionManager {
  readonly installRoot: string;
  readonly #registry: URL | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #maxArchiveBytes: number;
  readonly #maxExpandedBytes: number;

  constructor(options: ExtensionManagerOptions) {
    this.installRoot = resolve(options.installRoot);
    this.#registry = options.registry
      ? new URL(options.registry.endsWith('/') ? options.registry : `${options.registry}/`)
      : undefined;
    if (
      this.#registry &&
      (this.#registry.protocol !== 'https:' ||
        this.#registry.username ||
        this.#registry.password ||
        this.#registry.search ||
        this.#registry.hash)
    )
      throw new Error('Private registry must use HTTPS without embedded credentials');
    if (options.token?.includes('\n') || options.token?.includes('\r'))
      throw new Error('Invalid registry token');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#maxArchiveBytes = options.maxArchiveBytes ?? 25 * 1024 * 1024;
    this.#maxExpandedBytes = options.maxExpandedBytes ?? 100 * 1024 * 1024;
    if (
      ![this.#maxArchiveBytes, this.#maxExpandedBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error('Invalid extension size limit');
  }

  async #download(initial: URL, maxBytes: number): Promise<Buffer> {
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Unsafe extension download URL');
      const headers: Record<string, string> = {};
      if (this.#token && url.origin === this.#registry?.origin)
        headers['authorization'] = `Bearer ${this.#token}`;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error('Extension registry request failed');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Extension registry redirect has no location');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Extension registry returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Extension registry returned an empty response');
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error('Extension download exceeds size limit');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    }
    throw new Error('Too many extension registry redirects');
  }

  async #source(
    source: ExtensionSource,
  ): Promise<{ content: Buffer; integrity: string; expected?: { id: string; version: string } }> {
    if ('tarball' in source) {
      const content = await readBounded(source.tarball, this.#maxArchiveBytes);
      const integrity = `sha512-${hash(content)}`;
      if (source.integrity && source.integrity !== integrity) throw new Error('Extension integrity mismatch');
      return { content, integrity };
    }
    if (!this.#registry) throw new Error('No private extension registry configured');
    validateExtension({
      id: source.package,
      version: source.version,
      integrity: `sha512-${'A'.repeat(86)}==`,
      apiVersion: 1,
      entry: 'index.js',
      installPath: 'validation-only',
    });
    const body = await this.#download(
      new URL(`${encodeURIComponent(source.package)}/${encodeURIComponent(source.version)}`, this.#registry),
      1024 * 1024,
    );
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid registry metadata');
    const manifest = parsed as Record<string, unknown>;
    const dist = manifest['dist'] as Record<string, unknown> | undefined;
    if (
      manifest['name'] !== source.package ||
      manifest['version'] !== source.version ||
      !dist ||
      typeof dist['tarball'] !== 'string' ||
      typeof dist['integrity'] !== 'string'
    )
      throw new Error('Registry metadata does not match the requested exact version');
    validateExtension({
      id: source.package,
      version: source.version,
      integrity: dist['integrity'],
      apiVersion: 1,
      entry: 'index.js',
      installPath: 'validation-only',
    });
    const content = await this.#download(new URL(dist['tarball']), this.#maxArchiveBytes);
    const integrity = `sha512-${hash(content)}`;
    if (integrity !== dist['integrity']) throw new Error('Extension integrity mismatch');
    return { content, integrity, expected: { id: source.package, version: source.version } };
  }

  async install(source: ExtensionSource): Promise<ExtensionLock> {
    return this.#install(source);
  }

  async #install(source: ExtensionSource, expectedId?: string): Promise<ExtensionLock> {
    const { content, integrity, expected } = await this.#source(source);
    await mkdir(this.installRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.installRoot)).isSymbolicLink())
      throw new Error('Extension installation root cannot be a symlink');
    const stage = join(this.installRoot, `.stage-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    const archive = join(stage, '.pxv-archive.tgz');
    try {
      await writeFile(archive, content, { flag: 'wx', mode: 0o600 });
      const entries = await archiveEntries(archive, this.#maxExpandedBytes);
      if (entries.some((entry) => entry.path.startsWith('.pxv-')))
        throw new Error('Reserved extension archive path');
      await extract({
        file: archive,
        cwd: stage,
        strip: 1,
        strict: true,
        noChmod: true,
        preservePaths: false,
      });
      const metadata = await metadataAt(stage);
      if (expectedId && metadata.id !== expectedId)
        throw new Error('An extension update must preserve package identity');
      if (expected && (metadata.id !== expected.id || metadata.version !== expected.version))
        throw new Error('Downloaded extension identity does not match requested version');
      const installPath = createHash('sha256')
        .update(`${metadata.id}@${metadata.version}:${integrity}`)
        .digest('hex');
      const lock = validateExtension({
        id: metadata.id,
        version: metadata.version,
        integrity,
        apiVersion: 1,
        entry: metadata.entry,
        installPath,
      });
      await writeFile(join(stage, '.pxv-lock.json'), canonicalJson(lock), { flag: 'wx', mode: 0o600 });
      await validateTree(stage, entries);
      const destination = join(this.installRoot, installPath);
      if (
        await lstat(destination)
          .then(() => true)
          .catch((error: unknown) => {
            if (isMissing(error)) return false;
            throw error;
          })
      ) {
        await this.inspect(lock);
        return lock;
      }
      for (const entry of entries) await chmod(join(stage, entry.path), 0o400);
      await rename(stage, destination);
      return lock;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async inspect(input: ExtensionLock): Promise<ExtensionMetadata> {
    const lock = validateExtension(input);
    const directory = join(this.installRoot, lock.installPath);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Installed extension cannot be a symlink');
    const archive = join(directory, '.pxv-archive.tgz');
    if (`sha512-${hash(await readBounded(archive, this.#maxArchiveBytes))}` !== lock.integrity)
      throw new Error('Installed extension archive integrity mismatch');
    await validateTree(directory, await archiveEntries(archive, this.#maxExpandedBytes));
    const metadata = await metadataAt(directory);
    if (metadata.id !== lock.id || metadata.version !== lock.version || metadata.entry !== lock.entry)
      throw new Error('Installed extension does not match project lock');
    return metadata;
  }

  async list(): Promise<ExtensionLock[]> {
    const directories = await readdir(this.installRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const locks: ExtensionLock[] = [];
    for (const directory of directories) {
      if (directory.name.startsWith('.stage-')) continue;
      if (!directory.isDirectory()) throw new Error('Unexpected extension installation entry');
      const lock = validateExtension(
        parseDocument(
          (await readBounded(join(this.installRoot, directory.name, '.pxv-lock.json'), 1024 * 1024)).toString(
            'utf8',
          ),
        ),
      );
      if (lock.installPath !== directory.name)
        throw new Error('Installed extension directory does not match lock');
      await this.inspect(lock);
      locks.push(lock);
    }
    return locks.sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
  }

  async update(lock: ExtensionLock, source: ExtensionSource): Promise<ExtensionLock> {
    const pinned = validateExtension(lock);
    const next = await this.#install(source, pinned.id);
    return next;
  }

  async remove(lock: ExtensionLock, options: { inUse?: ExtensionLock[] } = {}): Promise<void> {
    if (
      options.inUse?.some(
        (used) => used.id === lock.id && used.version === lock.version && used.integrity === lock.integrity,
      )
    )
      throw new Error('Extension is still referenced by a project lock');
    await this.inspect(lock);
    await rm(join(this.installRoot, lock.installPath), { recursive: true });
  }

  async invoke(lock: ExtensionLock, command: string, input: unknown, timeoutMs = 30_000): Promise<Action[]> {
    const metadata = await this.inspect(lock);
    if (!metadata.contributions.commands.includes(command))
      throw new Error('Extension did not declare this command');
    return this.invokeEntry(lock, lock.entry, 'command', command, input, timeoutMs);
  }

  async readContribution(lock: ExtensionLock, kind: 'policyPacks', contribution: string): Promise<PolicyPack>;
  async readContribution(lock: ExtensionLock, kind: 'guides', contribution: string): Promise<string>;
  async readContribution(
    lock: ExtensionLock,
    kind: 'policyPacks' | 'guides',
    contribution: string,
  ): Promise<PolicyPack | string> {
    const metadata = await this.inspect(lock);
    if (!['policyPacks', 'guides'].includes(kind) || !metadata.contributions[kind].includes(contribution))
      throw new Error('Extension did not declare this contribution');
    const content = (
      await readBounded(join(this.installRoot, lock.installPath, contribution), 2 * 1024 * 1024)
    ).toString('utf8');
    return kind === 'policyPacks' ? validatePolicy(parseDocument(content)) : content;
  }

  async invokeAdapter(
    lock: ExtensionLock,
    contribution: string,
    input: unknown,
    timeoutMs = 30_000,
  ): Promise<Action[]> {
    const metadata = await this.inspect(lock);
    if (!metadata.contributions.adapters.includes(contribution))
      throw new Error('Extension did not declare this integration adapter');
    return this.invokeEntry(lock, contribution, 'adapter', '', input, timeoutMs);
  }

  private async invokeEntry(
    lock: ExtensionLock,
    entryPath: string,
    mode: 'command' | 'adapter',
    command: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<Action[]> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      throw new Error('Invalid extension worker timeout');
    if (canonicalJson(input).length > 1024 * 1024) throw new Error('Extension input exceeds size limit');
    let workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (
      await lstat(workerPath)
        .then(() => false)
        .catch((error: unknown) => {
          if (isMissing(error)) return true;
          throw error;
        })
    )
      workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
    const entry = pathToFileURL(join(this.installRoot, lock.installPath, entryPath)).href;
    return await new Promise<Action[]>((resolveActions, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { entry, mode, command, input },
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Extension worker timed out'));
      }, timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        void worker.terminate();
      };
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.once('message', (message: unknown) => {
        finish();
        try {
          if (!Array.isArray(message)) throw new Error('Extension command must return planned core actions');
          if (message.length > 10_000 || canonicalJson(message).length > 1024 * 1024)
            throw new Error('Extension result exceeds size limit');
          resolveActions(message.map(validateAction));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Invalid extension result'));
        }
      });
      worker.once('error', () => {
        finish();
        reject(new Error('Extension worker failed'));
      });
      worker.once('exit', () => {
        finish();
        reject(new Error('Extension worker exited without planned actions'));
      });
    });
  }
}
