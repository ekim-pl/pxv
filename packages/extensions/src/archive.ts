import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import { safeRelativePath } from './metadata.js';

export interface ArchiveEntry {
  path: string;
  size: number;
  sha256: string;
}
interface ArchiveState {
  entries: ArchiveEntry[];
  names: Set<string>;
  total: number;
  maximum: number;
}
function entryPath(entry: ReadEntry, state: ArchiveState): string {
  const path = entry.path.replace(/\/$/u, '');
  const relative = validatedPath(entry, path);
  if (state.names.has(path)) throw new Error('Duplicate extension archive path');
  state.names.add(path);
  if (state.names.size > 10_000) throw new Error('Extension archive has too many entries');
  if (relative.split('/').some((part) => ['.npmrc', '.env', 'node_modules'].includes(part)))
    throw new Error('Extension archives cannot contain credentials or runtime dependencies');
  if (relative.startsWith('.pxv-')) throw new Error('Reserved extension archive path');
  state.total += entry.size;
  if (!Number.isSafeInteger(state.total) || state.total > state.maximum)
    throw new Error('Expanded extension archive exceeds size limit');
  return relative;
}
function hashEntry(entry: ReadEntry, path: string, state: ArchiveState, abort: (error: Error) => void): void {
  const digest = createHash('sha256');
  let size = 0;
  entry.on('data', (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > entry.size) {
      abort(new Error('Extension archive entry exceeds declared size'));
      return;
    }
    digest.update(chunk);
  });
  entry.on('end', () => {
    if (size !== entry.size) {
      abort(new Error('Truncated extension archive entry'));
      return;
    }
    state.entries.push({ path, size, sha256: digest.digest('hex') });
  });
  entry.on('error', (error: unknown) =>
    abort(error instanceof Error ? error : new Error('Invalid extension archive entry')),
  );
}
/** @internal Stream injection verifies early abort without reading the rest of a rejected archive. */
export function inspectArchive(source: Readable, maximum: number): Promise<ArchiveEntry[]> {
  const state: ArchiveState = { entries: [], names: new Set(), total: 0, maximum };
  return new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 });
    let stopped = false;
    const fail = (error: Error): void => {
      if (stopped) return;
      stopped = true;
      source.unpipe(parser);
      source.destroy();
      parser.abort(error);
      reject(error);
    };
    parser.on('error', (error: Error) => {
      if (stopped) return;
      stopped = true;
      source.destroy();
      reject(error);
    });
    parser.on('entry', (entry: ReadEntry) => {
      try {
        const path = entryPath(entry, state);
        if (entry.type === 'File') hashEntry(entry, path, state, fail);
        entry.resume();
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid extension archive'));
      }
    });
    source.on('error', fail);
    parser.on('end', () => {
      if (!stopped) {
        stopped = true;
        resolve(state.entries.sort((a, b) => a.path.localeCompare(b.path)));
      }
    });
    source.pipe(parser);
  });
}
export function archiveEntries(file: string, maximum: number): Promise<ArchiveEntry[]> {
  const source: ReadStream = createReadStream(file, { highWaterMark: 64 * 1024 });
  return inspectArchive(source, maximum);
}

function validatedPath(entry: ReadEntry, path: string): string {
  if (!path.startsWith('package/') && path !== 'package')
    throw new Error('Extension tarball must have a package/ root');
  const relative = path.slice('package/'.length);
  if (path !== 'package' && !safeRelativePath(relative)) throw new Error('Unsafe extension archive path');
  if (entry.type !== 'File' && entry.type !== 'Directory')
    throw new Error('Extension archives cannot contain links or special files');

  return relative;
}
