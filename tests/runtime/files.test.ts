import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from './../test-api.js';
import { atomicWritePrivate, hashFile, readBounded } from '../../packages/runtime/src/index.js';

describe('private durable files', () => {
  test('atomically replaces private files and hashes exact contents', async () => {
    const directory = await mkdtemp('/tmp/pxv-files-');
    const path = join(directory, 'nested', 'record');
    await atomicWritePrivate(path, 'first');
    await atomicWritePrivate(path, Buffer.from('hello'));
    expect(await readFile(path, 'utf8')).toBe('hello');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await hashFile(path)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect((await readBounded(path, 5)).toString()).toBe('hello');
    await expect(readBounded(path, 4)).rejects.toThrow('bounded read');
    await expect(readBounded(path, -1)).rejects.toThrow('Invalid read limit');
  });
  test('rejects symlink destinations, inputs and non-files without overwriting', async () => {
    const directory = await mkdtemp('/tmp/pxv-files-');
    const original = join(directory, 'original');
    const link = join(directory, 'link');
    await writeFile(original, 'retain');
    await symlink(original, link);
    await expect(atomicWritePrivate(link, 'bad')).rejects.toThrow('regular file');
    await expect(readBounded(link, 100)).rejects.toThrow();
    await expect(hashFile(link)).rejects.toThrow();
    await expect(readBounded(directory, 10000)).rejects.toThrow('bounded read');
    await expect(hashFile(directory)).rejects.toThrow('regular file');
    expect(await readFile(original, 'utf8')).toBe('retain');
  });
  test('reads empty files with an empty bound', async () => {
    const directory = await mkdtemp('/tmp/pxv-files-');
    const path = join(directory, 'empty');
    await writeFile(path, '');
    expect(await readBounded(path, 0)).toHaveLength(0);
  });
  test('rejects a symbolic private parent directory', async () => {
    const directory = await mkdtemp('/tmp/pxv-files-');
    const target = join(directory, 'target');
    await mkdir(target);
    await symlink(target, join(directory, 'parent'));
    await expect(atomicWritePrivate(join(directory, 'parent', 'record'), 'private')).rejects.toThrow(
      'symlink',
    );
  });
});
