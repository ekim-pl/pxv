import { RepositoryService, type CommandResult } from '@pxv/adapters';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from '../test-api.js';
import { now, repository, row } from './repository-fixture.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-v1-update-index-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const data = {
    repo: { address: repository.url, timestamp: now },
    apps: [{ packageName: 'org.example.app', suggestedVersionCode: '7' as unknown }],
    packages: { 'org.example.app': [row] },
  };
  const run = vi.fn(async (args: string[]): Promise<CommandResult> => {
    expect(args[4]).toBe(repository.signerSha256);
    expect(args[5]).toBe('index-v1.json');
    await writeFile(args[6]!, JSON.stringify(data));
    return { code: 0, stdout: '', stderr: '' };
  });
  const advance = vi.fn(async () => {});
  const service = new RepositoryService({
    runner: { run },
    verifierPath: '/verify.java',
    now: () => now,
    freshness: { read: () => Promise.resolve(undefined), advance },
  });
  const path = join(root, 'index-v1.jar');
  return {
    data,
    run,
    service,
    advance,
    path,
    async load(this: void) {
      await writeFile(path, 'synthetic signed JAR');
      return service.indexFromJar(repository, path);
    },
  };
}

it('authenticates downloaded jars and exposes signed stable metadata without advancing freshness', async () => {
  const { load, advance, run } = fixture();
  const index = await load();
  expect(index.suggestedVersionCodes).toEqual({ 'org.example.app': 7 });
  expect(index.packages['org.example.app']![0]).toMatchObject({ versionCode: 7, sha256: row.hash });
  expect(index.evidence.format).toBe('v1');
  expect(advance).not.toHaveBeenCalled();
  await expect(readFile(run.mock.calls[0]![0][6]!)).rejects.toThrow();
});

it('normalizes requested packages while retaining strict validation of their metadata', async () => {
  const f = fixture();
  const invalid = { ...row, nativecode: ['amd64-Linux-gpp/jni'] };
  Object.assign(f.data.packages, { 'org.example.unrelated': [invalid] });
  await writeFile(f.path, 'synthetic signed JAR');
  const options = { packageIds: ['org.example.app'] };
  const index = await f.service.indexFromJar(repository, f.path, options);
  expect(Object.keys(index.packages)).toEqual(['org.example.app']);
  f.data.packages['org.example.app'] = [invalid];
  await expect(f.service.indexFromJar(repository, f.path, options)).rejects.toThrow('ABIs');
});

for (const failure of [
  'address',
  'stale',
  'malformed-version',
  'duplicate-app',
  'signature',
  'jar-changed',
  'duplicate-json',
]) {
  it(`rejects ${failure} before trusting a downloaded index`, async () => {
    const f = fixture();
    if (failure === 'address') f.data.repo.address = 'https://other.example/repo';
    if (failure === 'stale') f.data.repo.timestamp = now - 31 * 86_400_000;
    if (failure === 'malformed-version') f.data.apps[0]!.suggestedVersionCode = '-7';
    if (failure === 'duplicate-app') f.data.apps.push(f.data.apps[0]!);
    if (failure === 'signature') f.run.mockResolvedValue({ code: 2, stdout: '', stderr: 'bad signature' });
    if (failure === 'jar-changed') {
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementation(async (args) => {
        const result = await original(args);
        await writeFile(f.path, 'changed JAR');
        return result;
      });
    }
    if (failure === 'duplicate-json')
      f.run.mockImplementation(async (args) => {
        await writeFile(args[6]!, '{"repo":{},"repo":{}}');
        return { code: 0, stdout: '', stderr: '' };
      });
    await expect(f.load()).rejects.toThrow();
    expect(f.advance).not.toHaveBeenCalled();
  });
}
