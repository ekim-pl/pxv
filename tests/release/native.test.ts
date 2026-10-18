import { readFile } from 'node:fs/promises';
import { describe, expect, test } from './../test-api.js';
import { assertLinuxX64Addon } from '../../packages/release/src/native.js';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/runtime/package.json', import.meta.url));

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
  test('accepts the selected Linux x64 addon and a valid shared ELF', async () => {
    assertLinuxX64Addon(
      await readFile(
        require.resolve('@koromix/koffi-linux-x64').replace(/index.js$/u, 'linux_x64/koffi.node'),
      ),
    );
    assertLinuxX64Addon(elf());
  });
  test('rejects the host dynamic Node binary rather than relying on host execution', async () => {
    const bytes = await readFile(process.execPath);
    expect(() => assertLinuxX64Addon(bytes)).toThrow('addon');
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
    (b: Buffer) => b.writeBigInt64LE(29n, 176),
    (b: Buffer) => b.writeBigInt64LE(15n, 176),
    (b: Buffer) => b.writeBigInt64LE(29n, 176),
    (b: Buffer) => b.writeBigInt64LE(20n, 176),
    (b: Buffer) => b.writeUInt32LE(0, 64),
  ])('fails closed on malformed or dynamic ELF %#', (mutate) => {
    const bytes = elf();
    mutate(bytes);
    expect(() => assertLinuxX64Addon(bytes)).toThrow('addon');
  });
  test('rejects truncated headers', () =>
    expect(() => assertLinuxX64Addon(Buffer.alloc(4))).toThrow('addon'));
  test('accepts a terminated dynamic table without a runtime search path', () => {
    const bytes = elf();
    bytes.writeBigUInt64LE(32n, 152);
    bytes.writeBigInt64LE(30n, 176);
    assertLinuxX64Addon(bytes);
  });
});
