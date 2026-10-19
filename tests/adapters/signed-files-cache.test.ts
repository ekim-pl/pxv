import { afterEach, beforeEach, describe, expect, it } from '../test-api.js';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheSignedFiles, type SignedCacheFile } from '../../packages/adapters/src/artifact-cache.js';
import { digest } from './repository-fixture.js';

let root: string;
const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
const key = digest('signed repository identity');
const name = 'entry.jar';
let file: SignedCacheFile;
const base = () => join(root, 'cache', 'repository-signatures');
const destination = () => join(base(), key);
const retain = (files = [file], identity = key) => cacheSignedFiles(join(root, 'cache'), identity, files);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-signed-cache-'));
  const source = join(root, 'source.jar');
  await writeFile(source, bytes);
  file = { name, source, sha256: digest(bytes), limit: 1024 };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function noPublication(): Promise<void> {
  expect(await readdir(base())).toEqual([]);
}

describe('signed repository file retention', () => {
  it('seals exact independent bytes and reuses them without accessing an absent source', async () => {
    await retain();
    const path = join(destination(), name);
    const retained = await lstat(path);
    expect(await readFile(path)).toEqual(bytes);
    expect(retained.mode & 0o777).toBe(0o400);
    expect(retained.ino).not.toBe((await lstat(file.source)).ino);
    await writeFile(file.source, 'changed source');
    await rm(file.source);
    await retain();
    expect((await lstat(path)).ino).toBe(retained.ino);
    expect(await readdir(base())).toEqual([key]);
  });
  it('publishes concurrent equal inputs as one complete directory without staging residue', async () => {
    const second = { ...file, name: 'index.json' };
    await Promise.all(Array.from({ length: 8 }, () => retain([file, second])));
    expect((await readdir(destination())).sort()).toEqual(['entry.jar', 'index.json']);
    for (const entry of [file, second]) {
      expect(await readFile(join(destination(), entry.name))).toEqual(bytes);
      expect((await lstat(join(destination(), entry.name))).mode & 0o777).toBe(0o400);
    }
    expect(await readdir(base())).toEqual([key]);
  });
  it('rejects a conflicting concurrent publisher while retaining one complete winner', async () => {
    const alternateBytes = Buffer.from('different signed input');
    const alternate = { ...file, source: join(root, 'other.jar'), sha256: digest(alternateBytes) };
    await writeFile(alternate.source, alternateBytes);
    const results = await Promise.allSettled([retain(), retain([alternate])]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { message: 'Cached signed repository metadata has changed' } });
    const winner = results[0]?.status === 'fulfilled' ? bytes : alternateBytes;
    expect(await readFile(join(destination(), name))).toEqual(winner);
    expect(await readdir(base())).toEqual([key]);
  });
});

describe('signed repository file rejection', () => {
  it('rejects changed retained bytes without replacing them from an authentic source', async () => {
    await retain();
    const path = join(destination(), name);
    await chmod(path, 0o600);
    await writeFile(path, 'changed retained bytes');
    await expect(retain()).rejects.toThrow(/changed/);
    expect(await readFile(path, 'utf8')).toBe('changed retained bytes');
    expect(await readdir(base())).toEqual([key]);
  });
  it('rejects symlinked directories, symlinked files and nonregular retained entries', async () => {
    await mkdir(base(), { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, name), bytes);
    await symlink(outside, destination());
    await expect(retain()).rejects.toThrow(/symlinks/);
    await rm(destination());
    await mkdir(destination());
    const path = join(destination(), name);
    await symlink(file.source, path);
    await expect(retain()).rejects.toThrow(/changed/);
    await rm(path);
    await mkdir(path);
    await expect(retain()).rejects.toThrow(/changed/);
    expect(await readFile(join(outside, name))).toEqual(bytes);
    expect(await readdir(base())).toEqual([key]);
  });
  it('rejects a file in place of the publication directory and a symlinked cache root', async () => {
    await mkdir(base(), { recursive: true });
    await writeFile(destination(), bytes);
    await expect(retain()).rejects.toThrow(/symlinks/);
    await rm(join(root, 'cache'), { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'cache'));
    await expect(retain()).rejects.toThrow(/symlinks/);
    expect(await readdir(outside)).toEqual([]);
  });
  it('rejects unsafe keys, empty material sets, filenames and digests before publication', async () => {
    for (const identity of ['../escape', 'A'.repeat(64), 'a'.repeat(63)])
      await expect(retain([file], identity)).rejects.toThrow(/identity/);
    await expect(retain([])).rejects.toThrow(/identity/);
    for (const filename of ['../entry.jar', '/entry.jar', 'a/b.jar', '', '.hidden', 'a'.repeat(129)])
      await expect(retain([{ ...file, name: filename }])).rejects.toThrow(/cache file/);
    for (const hash of ['', 'x'.repeat(64), '../escape'])
      await expect(retain([{ ...file, sha256: hash }])).rejects.toThrow(/cache file/);
    await expect(lstat(join(root, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cleans staged files on source hash mismatch and never publishes unverified missing inputs', async () => {
    await expect(retain([{ ...file, sha256: '0'.repeat(64) }])).rejects.toThrow(/changed while caching/);
    await noPublication();
    const absent = { ...file, name: 'index.json', source: join(root, 'absent') };
    await expect(retain([file, absent])).rejects.toMatchObject({ code: 'ENOENT' });
    await noPublication();
    await symlink(file.source, absent.source);
    await expect(retain([file, absent])).rejects.toThrow(/regular file/);
    await noPublication();
    await expect(retain([{ ...file, limit: bytes.length - 1 }])).rejects.toThrow(/size limit/);
    await noPublication();
  });
  it('refuses incomplete retained publication and removes the competing staging directory', async () => {
    await mkdir(destination(), { recursive: true });
    await writeFile(join(destination(), name), bytes);
    await expect(retain([file, { ...file, name: 'index.json' }])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(base())).toEqual([key]);
    expect(await readdir(destination())).toEqual([name]);
  });
});
