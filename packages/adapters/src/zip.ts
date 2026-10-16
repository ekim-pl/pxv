import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
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
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function updateCrc(previous: number, bytes: Buffer): number {
  let crc = previous;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return crc >>> 0;
}
function zipPath(name: string): string {
  if (name.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/.test(name))
    throw new AdapterError('ZIP contains an unsafe path');
  const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new AdapterError('ZIP contains path traversal');
  return normalized;
}
/** Validates every central/local entry before writing any extracted file. ZIP64 fails closed. */
export async function zipEntries(path: string, limits: ZipLimits = {}): Promise<ZipEntry[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 22) throw new AdapterError('Invalid ZIP file');
    const tail = Buffer.alloc(Math.min(info.size, 65_557));
    await file.read(tail, 0, tail.length, info.size - tail.length);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--)
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
        eocd = at;
        break;
      }
    if (eocd < 0) throw new AdapterError('ZIP end directory is missing');
    const disk = tail.readUInt16LE(eocd + 4);
    const directoryDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const count = tail.readUInt16LE(eocd + 10);
    const size = tail.readUInt32LE(eocd + 12);
    const offset = tail.readUInt32LE(eocd + 16);
    if (
      disk ||
      directoryDisk ||
      diskEntries !== count ||
      count === 0xffff ||
      size === 0xffffffff ||
      offset === 0xffffffff
    )
      throw new AdapterError('Multidisk and ZIP64 archives are unsupported');
    if (
      count < 1 ||
      count > (limits.maxEntries ?? 10_000) ||
      size > 8 * 1024 * 1024 ||
      offset + size !== info.size - tail.length + eocd
    )
      throw new AdapterError('ZIP directory exceeds limits or is inconsistent');
    const directory = Buffer.alloc(size);
    await file.read(directory, 0, size, offset);
    const entries: ZipEntry[] = [];
    const names = new Map<string, boolean>();
    let at = 0;
    let total = 0;
    for (let item = 0; item < count; item++) {
      cancelled(limits.signal);
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50)
        throw new AdapterError('Malformed ZIP central directory');
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const compressedSize = directory.readUInt32LE(at + 20);
      const uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const entryDisk = directory.readUInt16LE(at + 34);
      const mode = directory.readUInt32LE(at + 38) >>> 16;
      const localOffset = directory.readUInt32LE(at + 42);
      if (
        at + 46 + nameLength + extraLength + commentLength > directory.length ||
        entryDisk ||
        flags & ~0x080e ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        [compressedSize, uncompressed, localOffset].includes(0xffffffff)
      )
        throw new AdapterError('Unsupported ZIP encryption, compression or entry metadata');
      const rawName = directory.subarray(at + 46, at + 46 + nameLength);
      const name = rawName.toString('utf8');
      const normalized = zipPath(name);
      const isDirectory = name.endsWith('/');
      const type = mode & 0xf000;
      if (type !== 0 && type !== (isDirectory ? 0x4000 : 0x8000))
        throw new AdapterError('ZIP links and special files are prohibited');
      if (names.has(normalized)) throw new AdapterError('ZIP contains duplicate paths');
      for (const [existing, directoryFlag] of names)
        if (
          (!directoryFlag && normalized.startsWith(existing + '/')) ||
          (!isDirectory && existing.startsWith(normalized + '/'))
        )
          throw new AdapterError('ZIP paths conflict');
      names.set(normalized, isDirectory);
      total += uncompressed;
      if (
        uncompressed > (limits.maxFileBytes ?? 6 * 1024 ** 3) ||
        total > (limits.maxTotalBytes ?? 12 * 1024 ** 3) ||
        (isDirectory && (uncompressed !== 0 || compressedSize !== 0))
      )
        throw new AdapterError('ZIP extraction exceeds approved limits');
      const local = Buffer.alloc(30);
      await file.read(local, 0, 30, localOffset);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== flags ||
        local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameLength
      )
        throw new AdapterError('ZIP local header differs from its directory');
      const localName = Buffer.alloc(nameLength);
      await file.read(localName, 0, nameLength, localOffset + 30);
      if (!localName.equals(rawName)) throw new AdapterError('ZIP local filename differs from its directory');
      const dataOffset = localOffset + 30 + nameLength + local.readUInt16LE(28);
      if (dataOffset > offset || dataOffset + compressedSize > offset)
        throw new AdapterError('ZIP file overlaps its directory');
      if (
        entries.some(
          (entry) =>
            Math.max(dataOffset, entry.offset) <
            Math.min(dataOffset + compressedSize, entry.offset + entry.compressedSize),
        )
      )
        throw new AdapterError('ZIP data ranges overlap');
      entries.push({
        name,
        size: uncompressed,
        compressedSize,
        offset: dataOffset,
        crc,
        method,
        flags,
        directory: isDirectory,
        executable: (mode & 0o111) !== 0,
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== directory.length) throw new AdapterError('ZIP directory contains unparsed data');
    return entries;
  } finally {
    await file.close();
  }
}
export async function extractZip(
  archive: string,
  destination: string,
  limits: ZipLimits = {},
): Promise<ZipEntry[]> {
  const entries = await zipEntries(archive, limits);
  await mkdir(destination, { mode: 0o700 }); // Existing destinations are never modified.
  try {
    for (const entry of entries) {
      cancelled(limits.signal);
      const output = join(destination, zipPath(entry.name));
      if (entry.directory) {
        await mkdir(output, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      let bytes = 0;
      let crc = 0xffffffff;
      const check = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > entry.size) {
            callback(new AdapterError('ZIP expanded beyond its declared size'));
            return;
          }
          crc = updateCrc(crc, chunk);
          callback(null, chunk);
        },
      });
      if (entry.compressedSize === 0) {
        const empty = await open(output, 'wx', 0o600);
        await empty.close();
      } else {
        const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
        const source = input.createReadStream({
          autoClose: true,
          start: entry.offset,
          end: entry.offset + entry.compressedSize - 1,
        });
        const target = createWriteStream(output, { flags: 'wx', mode: 0o600 });
        const options = limits.signal ? { signal: limits.signal } : {};
        if (entry.method === 8) await pipeline(source, createInflateRaw(), check, target, options);
        else await pipeline(source, check, target, options);
      }
      if (bytes !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc)
        throw new AdapterError('ZIP entry size or CRC does not match');
      await chmod(output, entry.executable ? 0o500 : 0o400);
    }
    return entries;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
