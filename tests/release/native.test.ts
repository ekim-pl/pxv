import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { assertStaticLinuxX64Elf } from '../../packages/release/src/native.js';
import { supervisorPath } from '../../packages/runtime/src/index.js';

function elf(): Buffer {
  const value = Buffer.alloc(256);
  value.write('7f454c46', 'hex');
  value[4] = 2;
  value[5] = 1;
  value[6] = 1;
  value.writeUInt16LE(3, 16);
  value.writeUInt16LE(62, 18);
  value.writeUInt32LE(1, 20);
  value.writeBigUInt64LE(64n, 32);
  value.writeUInt16LE(64, 52);
  value.writeUInt16LE(56, 54);
  value.writeUInt16LE(2, 56);
  value.writeUInt32LE(1, 64);
  value.writeUInt32LE(2, 120);
  value.writeBigUInt64LE(176n, 128);
  value.writeBigUInt64LE(16n, 152);
  return value;
}
describe('portable native baseline', () => {
  test('accepts the actual static supervisor and valid static PIE', async () => {
    assertStaticLinuxX64Elf(await readFile(await supervisorPath()));
    assertStaticLinuxX64Elf(elf());
  });
  test('rejects the host dynamic Node binary rather than relying on host execution', async () => {
    const bytes = await readFile(process.execPath);
    expect(() => assertStaticLinuxX64Elf(bytes)).toThrow('static');
  });
  test.each([
    (b: Buffer) => b.fill(0, 0, 4),
    (b: Buffer) => {
      b[4] = 1;
    },
    (b: Buffer) => {
      b[5] = 2;
    },
    (b: Buffer) => {
      b[6] = 0;
    },
    (b: Buffer) => {
      b[7] = 255;
    },
    (b: Buffer) => b.writeUInt16LE(1, 16),
    (b: Buffer) => b.writeUInt16LE(183, 18),
    (b: Buffer) => b.writeUInt32LE(0, 20),
    (b: Buffer) => b.writeUInt16LE(0, 52),
    (b: Buffer) => b.writeBigUInt64LE(999n, 32),
    (b: Buffer) => b.writeBigUInt64LE(0n, 32),
    (b: Buffer) => b.writeUInt16LE(0, 56),
    (b: Buffer) => b.writeUInt16LE(513, 56),
    (b: Buffer) => b.writeUInt16LE(1, 54),
    (b: Buffer) => b.writeUInt16LE(4, 56),
    (b: Buffer) => b.writeUInt32LE(3, 120),
    (b: Buffer) => b.writeBigUInt64LE(999n, 128),
    (b: Buffer) => b.writeBigUInt64LE(999n, 152),
    (b: Buffer) => b.writeBigUInt64LE(100n, 152),
    (b: Buffer) => b.writeBigUInt64LE(0n, 152),
    (b: Buffer) => b.writeBigUInt64LE(15n, 152),
    (b: Buffer) => b.writeBigInt64LE(1n, 176),
    (b: Buffer) => b.writeBigInt64LE(15n, 176),
    (b: Buffer) => b.writeBigInt64LE(29n, 176),
    (b: Buffer) => b.writeBigInt64LE(20n, 176),
    (b: Buffer) => b.writeUInt32LE(0, 64),
  ])('fails closed on malformed or dynamic ELF %#', (mutate) => {
    const bytes = elf();
    mutate(bytes);
    expect(() => assertStaticLinuxX64Elf(bytes)).toThrow('static');
  });
  test('rejects truncated headers', () =>
    expect(() => assertStaticLinuxX64Elf(Buffer.alloc(4))).toThrow('static'));
  test('accepts a terminated non-loader dynamic table in static PIE', () => {
    const bytes = elf();
    bytes.writeBigUInt64LE(32n, 152);
    bytes.writeBigInt64LE(30n, 176);
    assertStaticLinuxX64Elf(bytes);
  });
});
