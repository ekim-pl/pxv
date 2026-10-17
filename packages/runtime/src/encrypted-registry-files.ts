import { constants, type BigIntStats } from 'node:fs';
import { link, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from 'node:path';

const PRIVATE_FILE_ERROR = 'Private registry file is unavailable or unsafe';
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const privateRegistryFailure = (): Error => new Error(PRIVATE_FILE_ERROR);

export interface RegistryDirectory {
  handle: FileHandle;
  name: string;
  handles: FileHandle[];
}

function validDirectory(stat: BigIntStats, immediate: boolean): boolean {
  if (!stat.isDirectory()) return false;
  const uid = BigInt(process.geteuid?.() ?? -1);
  if (immediate) return stat.uid === uid && (stat.mode & 0o7777n) === 0o700n;
  if (stat.uid !== uid && stat.uid !== 0n) return false;
  return (stat.mode & 0o022n) === 0n || (stat.uid === 0n && (stat.mode & 0o1000n) !== 0n);
}

export function registryChild(directory: RegistryDirectory, name = directory.name): string {
  return join('/proc/self/fd', String(directory.handle.fd), name);
}

async function childDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
  const path = join('/proc/self/fd', String(parent.fd), name);
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!create || !missing(error)) throw error;
    await mkdir(path, { mode: 0o700 }).catch((failure: unknown) => {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    });
    await parent.sync();
    return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
}

/** Directory descriptors bind every component; a replaced pathname cannot redirect file access. */
export async function openRegistryDirectory(path: string, create = false): Promise<RegistryDirectory> {
  if (!path || path.length > 4096 || path.includes('\0') || path.split('/').includes('..'))
    throw privateRegistryFailure();
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const names = dirname(absolute).slice(root.length).split('/').filter(Boolean);
  const handles: FileHandle[] = [];
  try {
    let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(handle);
    if (!validDirectory(await handle.stat({ bigint: true }), names.length === 0))
      throw privateRegistryFailure();
    for (const [index, name] of names.entries()) {
      handle = await childDirectory(handle, name, create);
      handles.push(handle);
      if (!validDirectory(await handle.stat({ bigint: true }), index === names.length - 1))
        throw privateRegistryFailure();
    }
    return { handle, name: basename(absolute), handles };
  } catch {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    throw privateRegistryFailure();
  }
}

export async function closeRegistryDirectory(directory: RegistryDirectory): Promise<void> {
  await Promise.allSettled(directory.handles.map((handle) => handle.close()));
}

function validFile(stat: BigIntStats, maxBytes: number): boolean {
  return (
    stat.isFile() &&
    stat.uid === BigInt(process.geteuid?.() ?? -1) &&
    (stat.mode & 0o7777n) === 0o600n &&
    stat.size > 0n &&
    stat.size <= BigInt(maxBytes)
  );
}
function unchangedFile(before: BigIntStats, after: BigIntStats, bytes: number): boolean {
  return (
    BigInt(bytes) === before.size &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  );
}

export async function readRegistryBytes(directory: RegistryDirectory, maxBytes: number): Promise<Buffer> {
  const file = await open(
    registryChild(directory),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer | undefined;
  try {
    const before = await file.stat({ bigint: true });
    if (!validFile(before, maxBytes)) throw privateRegistryFailure();
    bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await file.read(bytes, total, bytes.length - total, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (!validFile(after, maxBytes) || !unchangedFile(before, after, total)) throw privateRegistryFailure();
    return bytes.subarray(0, total);
  } catch {
    bytes?.fill(0);
    throw privateRegistryFailure();
  } finally {
    await file.close();
  }
}

/** Write only the caller's supplied bytes; registry storage passes ciphertext here. */
export async function commitRegistryBytes(
  directory: RegistryDirectory,
  bytes: Buffer,
  replace: boolean,
): Promise<void> {
  const temporary = registryChild(directory, `.pxv-registry-${randomUUID()}.tmp`);
  const destination = registryChild(directory);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    if (replace) await rename(temporary, destination);
    else {
      await link(temporary, destination);
      await unlink(temporary);
    }
    await directory.handle.sync();
  } finally {
    try {
      await file.close();
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
}

/** Explicit private import, with no pathname or file contents included in errors. */
export async function readRegistryPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  let directory: RegistryDirectory | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024)
      throw privateRegistryFailure();
    directory = await openRegistryDirectory(path);
    return await readRegistryBytes(directory, maxBytes);
  } catch {
    throw privateRegistryFailure();
  } finally {
    if (directory) await closeRegistryDirectory(directory);
  }
}

/** Explicit plaintext export only: exclusive destination creation, never an unlocked cache. */
export async function writeRegistryPrivateFile(path: string, bytes: Buffer): Promise<void> {
  let directory: RegistryDirectory | undefined;
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32 * 1024 * 1024)
      throw privateRegistryFailure();
    directory = await openRegistryDirectory(path, true);
    await commitRegistryBytes(directory, bytes, false);
  } catch {
    throw privateRegistryFailure();
  } finally {
    if (directory) await closeRegistryDirectory(directory);
  }
}
