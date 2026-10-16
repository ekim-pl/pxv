import { zipEntries, zipPath, type ZipEntry, type ZipLimits } from './zip-directory.js';
import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { AdapterError, cancelled } from './command.js';

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

async function extractFile(
  archive: string,
  output: string,
  entry: ZipEntry,
  signal?: AbortSignal,
): Promise<void> {
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
    const options = signal ? { signal } : {};
    if (entry.method === 8) await pipeline(source, createInflateRaw(), check, target, options);
    else await pipeline(source, check, target, options);
  }
  if (bytes !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc)
    throw new AdapterError('ZIP entry size or CRC does not match');
  await chmod(output, entry.executable ? 0o500 : 0o400);
}
export async function extractZip(
  archive: string,
  destination: string,
  limits: ZipLimits = {},
): Promise<ZipEntry[]> {
  const entries = await zipEntries(archive, limits);
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const entry of entries) {
      cancelled(limits.signal);
      const output = join(destination, zipPath(entry.name));
      if (entry.directory) await mkdir(output, { recursive: true, mode: 0o700 });
      else await extractFile(archive, output, entry, limits.signal);
    }
    return entries;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
