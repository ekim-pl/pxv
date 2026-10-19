import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AdapterError, cancelled } from './command.js';
import { copySnapshot, fileDigest, seal } from './files.js';

interface CacheReference {
  schemaVersion: 1;
  content: string;
}
interface CacheAcquisition<T> {
  root: string;
  key: string;
  build(directory: string): Promise<T>;
  verify(directory: string): Promise<T>;
  contentId(value: T): string;
  relocate(value: T, directory: string): T;
}
type AcquisitionContexts = Map<AbortSignal | undefined, Promise<unknown>>;
const acquisitions = new Map<string, AcquisitionContexts>();
const contentPattern = /^[a-f0-9]{64}(?:-[a-f0-9]{64})?$/;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = (error: unknown): boolean =>
  ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Coalesce only within one cancellation context; revalidate actual signed bytes on reuse. */
export async function cachedArtifact<T>(options: CacheAcquisition<T>, signal?: AbortSignal): Promise<T> {
  cancelled(signal);
  const identity = `${resolve(options.root)}:${options.key}`;
  const contexts = acquisitions.get(identity) ?? new Map<AbortSignal | undefined, Promise<unknown>>();
  acquisitions.set(identity, contexts);
  let pending = contexts.get(signal) as Promise<T> | undefined;
  if (!pending) {
    pending = acquire(options);
    contexts.set(signal, pending);
  }
  try {
    const value = await pending;
    cancelled(signal);
    return value;
  } finally {
    if (contexts.get(signal) === pending) contexts.delete(signal);
    if (contexts.size === 0 && acquisitions.get(identity) === contexts) acquisitions.delete(identity);
  }
}

export function cacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function cachePlanReference(path: string, value: object): Promise<void> {
  await privateDirectory(dirname(path));
  await writeFile(path, JSON.stringify({ schemaVersion: 1, ...value }) + '\n', { flag: 'wx', mode: 0o400 });
}

/** A plan keeps its own reference paths and provenance without storing another copy. */
export async function linkCachedArtifact(source: string, destination: string): Promise<void> {
  await privateDirectory(dirname(destination));
  await link(source, destination);
}

export async function cachePlanDirectory(path: string): Promise<void> {
  await privateDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 });
}

export interface SignedCacheFile {
  name: string;
  source: string;
  sha256: string;
  limit: number;
}

/** Retain signed repository inputs under an immutable content-derived directory. */
export async function cacheSignedFiles(root: string, key: string, files: SignedCacheFile[]): Promise<void> {
  validateSignedFiles(key, files);
  const base = join(root, 'repository-signatures');
  await privateDirectory(base);
  const destination = join(base, key);
  const verify = async (): Promise<void> => {
    if ((await realpath(destination)) !== resolve(destination) || !(await lstat(destination)).isDirectory())
      throw new AdapterError('Signed metadata cache must not traverse symlinks');
    for (const file of files) {
      const path = join(destination, file.name);
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (await fileDigest(path, file.limit)) !== file.sha256
      )
        throw new AdapterError('Cached signed repository metadata has changed');
    }
  };
  try {
    await verify();
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const staging = await mkdtemp(join(base, '.signature-'));
  try {
    for (const file of files) {
      const path = join(staging, file.name);
      await copySnapshot(file.source, path, file.limit);
      if ((await fileDigest(path, file.limit)) !== file.sha256)
        throw new AdapterError('Signed repository metadata changed while caching');
      await seal(path);
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!exists(error)) throw error;
      await verify();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function validateSignedFiles(key: string, files: SignedCacheFile[]): void {
  if (!/^[a-f0-9]{64}$/.test(key) || !files.length)
    throw new AdapterError('Invalid signed metadata cache identity');
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name) || !contentPattern.test(file.sha256))
      throw new AdapterError('Invalid signed metadata cache file');
  }
}

async function privateDirectory(path: string): Promise<void> {
  let at = resolve(path);
  while (true) {
    const entry = await lstat(at).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new AdapterError('Artifact cache directories must not traverse symlinks');
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await realpath(path)) !== resolve(path) || !(await lstat(path)).isDirectory())
    throw new AdapterError('Artifact cache directories must not traverse symlinks');
}

async function reference(path: string): Promise<CacheReference | undefined> {
  let data: Buffer;
  try {
    data = await referenceBytes(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(data.toString('utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'content,schemaVersion'
  )
    throw new AdapterError('Artifact cache reference is malformed');
  const entry = value as CacheReference;
  if (entry.schemaVersion !== 1 || typeof entry.content !== 'string' || !contentPattern.test(entry.content))
    throw new AdapterError('Artifact cache content identity is malformed');
  return entry;
}

async function referenceBytes(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 1024)
      throw new AdapterError('Artifact cache reference is invalid');
    const bytes = Buffer.alloc(1025);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 1024) throw new AdapterError('Artifact cache reference exceeds its limit');
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
}

async function verifyEntry<T>(options: CacheAcquisition<T>, content: string): Promise<T> {
  const path = join(options.root, 'content', content);
  if ((await realpath(path)) !== resolve(path) || !(await lstat(path)).isDirectory())
    throw new AdapterError('Artifact cache content must not traverse symlinks');
  const value = await options.verify(path);
  if (options.contentId(value) !== content)
    throw new AdapterError('Artifact cache bytes do not match their content address');
  return value;
}

async function publishReference(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await cachePlanReference(temporary, { content });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!exists(error)) throw error;
      if ((await reference(path))?.content !== content)
        throw new AdapterError('Concurrent artifact acquisition returned different authenticated bytes');
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquire<T>(options: CacheAcquisition<T>): Promise<T> {
  const refs = join(options.root, 'refs');
  await privateDirectory(refs);
  await privateDirectory(join(options.root, 'content'));
  const index = join(refs, `${options.key}.json`);
  const retained = await reference(index);
  if (retained) return verifyEntry(options, retained.content);
  const staging = await mkdtemp(join(options.root, '.acquire-'));
  try {
    const input = join(staging, 'content');
    const built = await options.build(input);
    const content = options.contentId(built);
    if (!contentPattern.test(content)) throw new AdapterError('Invalid acquired artifact content address');
    const destination = join(options.root, 'content', content);
    let result: T;
    try {
      await rename(input, destination);
      result = options.relocate(built, destination);
    } catch (error) {
      if (!exists(error)) throw error;
      result = await verifyEntry(options, content);
    }
    await publishReference(index, content);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
