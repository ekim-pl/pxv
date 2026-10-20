import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRegistryPrivatePair } from '@pxv/runtime';
import { afterEach, expect, it } from '../test-api.js';

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'pxv-pair-test-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
it('publishes both private files exclusively and leaves no staging files', async () => {
  const directory = await root();
  const first = { path: join(directory, 'first'), bytes: Buffer.from('FIRST') };
  const second = { path: join(directory, 'second'), bytes: Buffer.from('SECOND') };
  await writeRegistryPrivatePair(first, second);
  expect(await readFile(first.path)).toEqual(first.bytes);
  expect(await readFile(second.path)).toEqual(second.bytes);
  expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(['first', 'second']);
  await expect(writeRegistryPrivatePair(first, second)).rejects.toThrow('could not be published');
  expect(await readFile(first.path)).toEqual(first.bytes);
});
for (const collision of ['file', 'symlink']) {
  it(`rolls back only its own new first file when the second destination is an existing ${collision}`, async () => {
    const directory = await root(),
      target = join(directory, 'retained');
    await writeFile(target, 'RETAINED', { mode: 0o600 });
    const first = { path: join(directory, 'first'), bytes: Buffer.from('FIRST') };
    const second = { path: join(directory, 'second'), bytes: Buffer.from('SECOND') };
    if (collision === 'symlink') await symlink(target, second.path);
    else await writeFile(second.path, 'ORIGINAL', { mode: 0o600 });
    await expect(writeRegistryPrivatePair(first, second)).rejects.toThrow('could not be published');
    await expect(stat(first.path)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('RETAINED');
    expect(await readFile(second.path, 'utf8')).toBe(collision === 'file' ? 'ORIGINAL' : 'RETAINED');
    expect(await readdir(directory)).toEqual(['retained', 'second']);
  });
}
it('rejects unsafe parents, shared names, different directories and invalid bytes', async () => {
  const directory = await root();
  const first = { path: join(directory, 'first'), bytes: Buffer.from('FIRST') };
  const second = { path: join(directory, 'second'), bytes: Buffer.from('SECOND') };
  await expect(writeRegistryPrivatePair(first, first)).rejects.toThrow('distinct');
  await expect(
    writeRegistryPrivatePair(first, { ...second, path: join(directory, 'other', 'second') }),
  ).rejects.toThrow('same directory');
  await expect(writeRegistryPrivatePair(first, { ...second, bytes: Buffer.alloc(0) })).rejects.toThrow(
    'Invalid',
  );
  await chmod(directory, 0o755);
  await expect(writeRegistryPrivatePair(first, second)).rejects.toThrow('unsafe');
  await chmod(directory, 0o700);
  const alias = join(await root(), 'alias');
  await symlink(directory, alias);
  await expect(
    writeRegistryPrivatePair(
      { ...first, path: join(alias, 'first') },
      { ...second, path: join(alias, 'second') },
    ),
  ).rejects.toThrow('unsafe');
  expect(await readdir(directory)).toEqual([]);
});
