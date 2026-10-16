import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip, zipEntries } from '../../packages/adapters/src/index.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-zip-security-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
interface Entry {
  name: string;
  bytes?: string;
  mode?: number;
  method?: number;
  flags?: number;
  size?: number;
  crc?: number;
  localName?: string;
}
function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
/** Small hand-built stored ZIP fixtures make malicious metadata explicit and deterministic. */
function archive(entries: Entry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.bytes ?? '');
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.size ?? data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.size ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040700 : 0o100600)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, localName, data);
    centralParts.push(central, name);
    offset += local.length + localName.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
async function file(name: string, data: Buffer): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, data);
  return path;
}
describe('archive extraction threat cases', () => {
  it('extracts nested files, directories and empty files inside a new root', async () => {
    const path = await file(
      'safe.zip',
      archive([{ name: 'nested/' }, { name: 'nested/file.txt', bytes: 'verified bytes' }, { name: 'empty' }]),
    );
    const target = join(directory, 'output');
    const entries = await extractZip(path, target);
    expect(entries).toHaveLength(3);
    expect(await readFile(join(target, 'nested/file.txt'), 'utf8')).toBe('verified bytes');
    expect(await readFile(join(target, 'empty'))).toHaveLength(0);
  });
  it('rejects traversal, absolute, Windows, duplicate and conflicting paths before extraction', async () => {
    const cases: Entry[][] = [
      [{ name: '../escape', bytes: 'x' }],
      [{ name: '/absolute', bytes: 'x' }],
      [{ name: 'C:\\escape', bytes: 'x' }],
      [
        { name: 'x', bytes: 'one' },
        { name: 'x', bytes: 'two' },
      ],
      [
        { name: 'parent', bytes: 'file' },
        { name: 'parent/child', bytes: 'x' },
      ],
      [
        { name: 'parent/child', bytes: 'x' },
        { name: 'parent', bytes: 'file' },
      ],
      [{ name: 'x/./y', bytes: 'x' }],
    ];
    for (const [index, entries] of cases.entries())
      await expect(
        extractZip(await file(`path-${index}.zip`, archive(entries)), join(directory, `out-${index}`)),
      ).rejects.toThrow(/unsafe|traversal|duplicate|conflict/i);
  });
  it('rejects links, devices, encryption, unknown compression and mismatched local filenames', async () => {
    const cases: Entry[] = [
      { name: 'link', bytes: '/tmp', mode: 0o120777 },
      { name: 'device', mode: 0o020600 },
      { name: 'encrypted', bytes: 'x', flags: 1 },
      { name: 'unsupported', bytes: 'x', method: 99 },
      { name: 'expected', localName: 'different', bytes: 'x' },
    ];
    for (const [index, entry] of cases.entries())
      await expect(zipEntries(await file(`metadata-${index}.zip`, archive([entry])))).rejects.toThrow(
        /prohibited|Unsupported|differs/,
      );
  });
  it('detects CRC corruption and declared-size bombs and removes incomplete outputs', async () => {
    const badCrc = await file('crc.zip', archive([{ name: 'file', bytes: 'corrupt', crc: 1 }]));
    const target = join(directory, 'bad-crc');
    await expect(extractZip(badCrc, target)).rejects.toThrow(/CRC/);
    await expect(readFile(join(target, 'file'))).rejects.toThrow();
    const bomb = await file('bomb.zip', archive([{ name: 'file', bytes: 'overflow', size: 1 }]));
    await expect(extractZip(bomb, join(directory, 'bomb-out'))).rejects.toThrow(/declared size/);
  });
  it('rejects truncated, multidisk and ZIP64 inputs and enforces entry limits', async () => {
    await expect(zipEntries(await file('empty', Buffer.from('not a zip')))).rejects.toThrow(/Invalid ZIP/);
    const valid = archive([{ name: 'file', bytes: 'x' }]);
    await expect(zipEntries(await file('truncated', valid.subarray(0, valid.length - 4)))).rejects.toThrow(
      /end directory/,
    );
    const multidisk = Buffer.from(valid);
    multidisk.writeUInt16LE(1, multidisk.length - 18);
    await expect(zipEntries(await file('multidisk', multidisk))).rejects.toThrow(/Multidisk/);
    const zip64 = Buffer.from(valid);
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    await expect(zipEntries(await file('zip64', zip64))).rejects.toThrow(/ZIP64/);
    await expect(
      zipEntries(await file('entries.zip', archive([{ name: 'one' }, { name: 'two' }])), { maxEntries: 1 }),
    ).rejects.toThrow(/limits/);
  });
});
