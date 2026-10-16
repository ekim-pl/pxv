import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { inspectArchive } from '../../packages/extensions/src/archive.js';
function header(path: string, size: number, type = '0'): Buffer {
  const value = Buffer.alloc(512);
  value.write(path, 0, 100);
  value.write('0000644\0', 100, 8);
  value.write('0000000\0', 108, 8);
  value.write('0000000\0', 116, 8);
  value.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  value.write('00000000000\0', 136, 12);
  value.fill(32, 148, 156);
  value.write(type, 156, 1);
  value.write('ustar\0', 257, 6);
  value.write('00', 263, 2);
  const sum = value.reduce((a, b) => a + b, 0);
  value.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return value;
}
describe('bounded extension archive stream', () => {
  it('stops input at the rejected expanded-size header instead of draining its body', async () => {
    let chunks = 0;
    const source = Readable.from(
      (function* () {
        chunks++;
        yield header('package/oversized.bin', 100 * 1024 * 1024);
        for (let i = 0; i < 1600; i++) {
          chunks++;
          yield Buffer.alloc(64 * 1024);
        }
      })(),
    );
    await expect(inspectArchive(source, 1024)).rejects.toThrow(
      'Expanded extension archive exceeds size limit',
    );
    expect(source.destroyed).toBe(true);
    expect(chunks).toBeLessThan(4);
  });
  it('stops input on a forbidden path even when a large body follows', async () => {
    let chunks = 0;
    const source = Readable.from(
      (function* () {
        chunks++;
        yield header('package/.env', 64 * 1024 * 1024);
        for (let i = 0; i < 1024; i++) {
          chunks++;
          yield Buffer.alloc(64 * 1024);
        }
      })(),
    );
    await expect(inspectArchive(source, 128 * 1024 * 1024)).rejects.toThrow('credentials');
    expect(chunks).toBeLessThan(4);
  });
  it('accepts a package directory and bounds entry-count attacks with zero-length files', async () => {
    expect(
      await inspectArchive(
        Readable.from([header('package', 0, '5'), header('package/empty', 0), Buffer.alloc(1024)]),
        1024,
      ),
    ).toEqual([
      { path: 'empty', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    ]);
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 10_001; i++) yield header(`package/file-${i}`, 0);
        yield Buffer.alloc(1024);
      })(),
    );
    await expect(inspectArchive(source, 1024)).rejects.toThrow('too many entries');
  });
  it('rejects a source read failure and destroys input', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('archive disk failure'));
      },
    });
    await expect(inspectArchive(source, 1024)).rejects.toThrow('archive disk failure');
    expect(source.destroyed).toBe(true);
  });
});
