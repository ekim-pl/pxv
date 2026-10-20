import { randomUUID } from 'node:crypto';
import { link, lstat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  closeRegistryDirectory,
  commitRegistryBytes,
  openRegistryDirectory,
  registryChild,
} from './encrypted-registry-files.js';

interface PrivateExport {
  path: string;
  bytes: Buffer;
}
interface StagedExport {
  temporary: string;
  output: string;
  published: boolean;
}

function validatePair(first: PrivateExport, second: PrivateExport): void {
  if (
    dirname(resolve(first.path)) !== dirname(resolve(second.path)) ||
    resolve(first.path) === resolve(second.path)
  )
    throw new Error('Private export pair requires distinct files in the same directory');
  for (const { bytes } of [first, second])
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32 * 1024 * 1024)
      throw new Error('Invalid private export bytes');
}

async function rollbackPair(staged: StagedExport[]): Promise<void> {
  for (const file of staged) {
    if (!file.published) continue;
    const original = await lstat(file.temporary);
    const current = await lstat(file.output).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (current?.ino === original.ino && current.dev === original.dev) await unlink(file.output);
  }
}

/** Stage both outputs first, publish exclusively, and roll back only links to our staged files. */
export async function writeRegistryPrivatePair(first: PrivateExport, second: PrivateExport): Promise<void> {
  validatePair(first, second);
  const directory = await openRegistryDirectory(first.path, true);
  const staged = [first, second].map((file) => ({
    ...file,
    temporary: registryChild(directory, `.pxv-export-${randomUUID()}`),
    output: registryChild(directory, basename(file.path)),
    published: false,
  }));
  try {
    for (const file of staged)
      await commitRegistryBytes({ ...directory, name: basename(file.temporary) }, file.bytes, false);
    for (const file of staged) {
      await link(file.temporary, file.output);
      file.published = true;
    }
    await directory.handle.sync();
  } catch {
    await rollbackPair(staged);
    throw new Error('Private export pair could not be published');
  } finally {
    try {
      await Promise.all(
        staged.map((file) =>
          unlink(file.temporary).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }),
        ),
      );
    } finally {
      await closeRegistryDirectory(directory);
    }
  }
}
