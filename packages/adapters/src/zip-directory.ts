import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { AdapterError, cancelled } from './command.js';
export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  offset: number;
  crc: number;
  method: number;
  flags: number;
  directory: boolean;
  executable: boolean;
}
export interface ZipLimits {
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}
interface Directory {
  data: Buffer;
  count: number;
  offset: number;
}
interface CentralEntry extends ZipEntry {
  localOffset: number;
  rawName: Buffer;
  next: number;
}
export function zipPath(name: string): string {
  if (name.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/.test(name))
    throw new AdapterError('ZIP contains an unsafe path');
  const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new AdapterError('ZIP contains path traversal');
  return normalized;
}
function endDirectory(tail: Buffer): number {
  for (let at = tail.length - 22; at >= 0; at--)
    if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length)
      return at;
  throw new AdapterError('ZIP end directory is missing');
}
function directoryMetadata(tail: Buffer, at: number): { count: number; size: number; offset: number } {
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  const diskEntries = tail.readUInt16LE(at + 8);
  const count = tail.readUInt16LE(at + 10);
  const size = tail.readUInt32LE(at + 12);
  const offset = tail.readUInt32LE(at + 16);
  if (
    disk ||
    directoryDisk ||
    diskEntries !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff
  )
    throw new AdapterError('Multidisk and ZIP64 archives are unsupported');
  return { count, size, offset };
}
async function readDirectory(file: FileHandle, limits: ZipLimits): Promise<Directory> {
  const info = await file.stat();
  if (!info.isFile() || info.size < 22) throw new AdapterError('Invalid ZIP file');
  const tail = Buffer.alloc(Math.min(info.size, 65_557));
  await file.read(tail, 0, tail.length, info.size - tail.length);
  const eocd = endDirectory(tail);
  const { count, size, offset } = directoryMetadata(tail, eocd);
  if (
    count < 1 ||
    count > (limits.maxEntries ?? 10_000) ||
    size > 8 * 1024 * 1024 ||
    offset + size !== info.size - tail.length + eocd
  )
    throw new AdapterError('ZIP directory exceeds limits or is inconsistent');
  const data = Buffer.alloc(size);
  await file.read(data, 0, size, offset);
  return { data, count, offset };
}
function centralEntry(data: Buffer, at: number): CentralEntry {
  if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50)
    throw new AdapterError('Malformed ZIP central directory');
  const flags = data.readUInt16LE(at + 8);
  const method = data.readUInt16LE(at + 10);
  const crc = data.readUInt32LE(at + 16);
  const compressedSize = data.readUInt32LE(at + 20);
  const size = data.readUInt32LE(at + 24);
  const nameLength = data.readUInt16LE(at + 28);
  const next = at + 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  const entryDisk = data.readUInt16LE(at + 34);
  const mode = data.readUInt32LE(at + 38) >>> 16;
  const localOffset = data.readUInt32LE(at + 42);
  if (
    next > data.length ||
    entryDisk ||
    flags & ~0x080e ||
    flags & 1 ||
    ![0, 8].includes(method) ||
    [compressedSize, size, localOffset].includes(0xffffffff)
  )
    throw new AdapterError('Unsupported ZIP encryption, compression or entry metadata');
  const rawName = data.subarray(at + 46, at + 46 + nameLength);
  const name = rawName.toString('utf8');
  const directory = name.endsWith('/');
  validateEntryType(mode, directory);
  return {
    name,
    size,
    compressedSize,
    offset: 0,
    crc,
    method,
    flags,
    directory,
    executable: (mode & 0o111) !== 0,
    localOffset,
    rawName,
    next,
  };
}
function registerPath(entry: ZipEntry, names: Map<string, boolean>): void {
  const normalized = zipPath(entry.name);
  if (names.has(normalized)) throw new AdapterError('ZIP contains duplicate paths');
  for (const [existing, directory] of names)
    if (
      (!directory && normalized.startsWith(existing + '/')) ||
      (!entry.directory && existing.startsWith(normalized + '/'))
    )
      throw new AdapterError('ZIP paths conflict');
  names.set(normalized, entry.directory);
}
function validateSize(entry: ZipEntry, total: number, limits: ZipLimits): void {
  if (
    entry.size > (limits.maxFileBytes ?? 6 * 1024 ** 3) ||
    total > (limits.maxTotalBytes ?? 12 * 1024 ** 3) ||
    (entry.directory && (entry.size !== 0 || entry.compressedSize !== 0))
  )
    throw new AdapterError('ZIP extraction exceeds approved limits');
}
async function localDataOffset(
  file: FileHandle,
  entry: CentralEntry,
  directoryOffset: number,
): Promise<number> {
  const local = Buffer.alloc(30);
  await file.read(local, 0, 30, entry.localOffset);
  if (
    local.readUInt32LE(0) !== 0x04034b50 ||
    local.readUInt16LE(6) !== entry.flags ||
    local.readUInt16LE(8) !== entry.method ||
    local.readUInt16LE(26) !== entry.rawName.length
  )
    throw new AdapterError('ZIP local header differs from its directory');
  const name = Buffer.alloc(entry.rawName.length);
  await file.read(name, 0, name.length, entry.localOffset + 30);
  if (!name.equals(entry.rawName)) throw new AdapterError('ZIP local filename differs from its directory');
  const offset = entry.localOffset + 30 + name.length + local.readUInt16LE(28);
  if (offset > directoryOffset || offset + entry.compressedSize > directoryOffset)
    throw new AdapterError('ZIP file overlaps its directory');
  return offset;
}
function validateDataRange(entry: ZipEntry, previous: ZipEntry[]): void {
  if (
    previous.some(
      (prior) =>
        Math.max(entry.offset, prior.offset) <
        Math.min(entry.offset + entry.compressedSize, prior.offset + prior.compressedSize),
    )
  )
    throw new AdapterError('ZIP data ranges overlap');
}
/** Validates every central/local entry before writing any extracted file. ZIP64 fails closed. */
export async function zipEntries(path: string, limits: ZipLimits = {}): Promise<ZipEntry[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const directory = await readDirectory(file, limits);
    const entries: ZipEntry[] = [];
    const names = new Map<string, boolean>();
    let at = 0;
    let total = 0;
    for (let item = 0; item < directory.count; item++) {
      cancelled(limits.signal);
      const central = centralEntry(directory.data, at);
      registerPath(central, names);
      total += central.size;
      validateSize(central, total, limits);
      const { localOffset: _local, rawName: _name, next, ...entry } = central;
      void _local;
      void _name;
      entry.offset = await localDataOffset(file, central, directory.offset);
      validateDataRange(entry, entries);
      entries.push(entry);
      at = next;
    }
    if (at !== directory.data.length) throw new AdapterError('ZIP directory contains unparsed data');
    return entries;
  } finally {
    await file.close();
  }
}
function validateEntryType(mode: number, directory: boolean): void {
  const type = mode & 0xf000;
  if (type !== 0 && type !== (directory ? 0x4000 : 0x8000))
    throw new AdapterError('ZIP links and special files are prohibited');
}
