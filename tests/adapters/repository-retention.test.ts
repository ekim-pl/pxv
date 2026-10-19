import { afterEach, beforeEach, describe, expect, it, vi } from '../test-api.js';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, now, repository, repositoryDocuments, repositoryFixture } from './repository-fixture.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-repository-retention-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function retained(format: 'v1' | 'v2') {
  const fixture = repositoryFixture(root);
  const documents = repositoryDocuments(format);
  vi.stubGlobal('fetch', documents.fetch);
  const index = await fixture.repo.index(repository, { readOnly: true });
  expect(fixture.advance).not.toHaveBeenCalled();
  fixture.verify.mockClear();
  const offline = vi.fn(() => {
    throw new Error('Network disabled during evidence validation');
  });
  vi.stubGlobal('fetch', offline);
  return {
    ...fixture,
    ...documents,
    index,
    offline,
    directory: join(root, 'repository-signatures', documents.materialId),
    jarName: format === 'v1' ? 'index-v1.jar' : 'entry.jar',
  };
}

for (const format of ['v1', 'v2'] as const)
  describe(`retained ${format} repository evidence`, () => {
    it('retains content-derived identity and authenticates exact local files offline without advancing by default', async () => {
      const fixture = await retained(format);
      const { repo, index, directory, jarName, advance, verify } = fixture;
      expect(index.evidence.signatureMaterialId).toBe(fixture.materialId);
      expect(index.evidence.entrySha256).toBe(digest(fixture.jar));
      expect(index.evidence.indexSha256).toBe(digest(fixture.indexBytes));
      expect(await readFile(join(directory, jarName), 'utf8')).toBe(fixture.jar);
      expect((await lstat(join(directory, jarName))).mode & 0o777).toBe(0o400);
      expect((await readdir(directory)).sort()).toEqual(
        format === 'v1' ? [jarName] : ['entry.jar', 'index.json'],
      );
      if (format === 'v2') {
        expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(fixture.indexBytes);
        expect((await lstat(join(directory, 'index.json'))).mode & 0o777).toBe(0o400);
      }
      await repo.validateEvidence(repository, index.evidence);
      expect(advance).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledOnce();
      expect(verify.mock.calls[0]?.[0]).toEqual([
        'java',
        '-Xmx256m',
        '/retained-verifier.java',
        join(directory, jarName),
        repository.signerSha256,
        format === 'v1' ? 'index-v1.json' : 'entry.json',
      ]);
      await repo.validateEvidence(repository, index.evidence, true);
      expect(advance).toHaveBeenCalledExactlyOnceWith(repo.key(repository), undefined, {
        signerSha256: repository.signerSha256,
        timestamp: now,
      });
      expect(fixture.offline).not.toHaveBeenCalled();
    });
  });

for (const format of ['v1', 'v2'] as const)
  describe(`retained ${format} repository evidence rejection`, () => {
    it('rejects missing or wrong material identity and changed reviewed repository identity before authentication', async () => {
      const { repo, index, advance, verify, offline } = await retained(format);
      for (const signatureMaterialId of [undefined, '0'.repeat(64)]) {
        const evidence = { ...index.evidence };
        delete evidence.signatureMaterialId;
        if (signatureMaterialId) evidence.signatureMaterialId = signatureMaterialId;
        await expect(repo.validateEvidence(repository, evidence, true)).rejects.toThrow(/not retained/);
      }
      for (const change of [
        { url: 'https://other.example/repo' },
        { maxAgeDays: 31 },
        { signerSha256: 'f'.repeat(64) },
      ])
        await expect(
          repo.validateEvidence(repository, { ...index.evidence, ...change }, true),
        ).rejects.toThrow(/identity changed/);
      expect(verify).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
      expect(offline).not.toHaveBeenCalled();
    });
    it('rejects absent retained files and symlinked material directories without reacquisition or floor advancement', async () => {
      const { repo, index, directory, jarName, advance, offline } = await retained(format);
      const outside = join(root, 'outside');
      await rename(directory, outside);
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await symlink(outside, directory);
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(
        /directory is invalid/,
      );
      await rm(directory);
      await rename(outside, directory);
      await rm(join(directory, jarName));
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(advance).not.toHaveBeenCalled();
      expect(offline).not.toHaveBeenCalled();
    });
    it('rejects modified JAR bytes and symlinked JAR files before invoking the verifier', async () => {
      const { repo, index, directory, jarName, advance, verify } = await retained(format);
      const jar = join(directory, jarName);
      await chmod(jar, 0o600);
      await writeFile(jar, 'modified JAR');
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(/changed/);
      await rm(jar);
      const outside = join(root, 'outside.jar');
      await writeFile(outside, 'untrusted');
      await symlink(outside, jar);
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(/regular file/);
      expect(verify).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
    });
    it('requires successful authentication and matching reviewed timestamps before explicit advancement', async () => {
      const { repo, index, advance, verify } = await retained(format);
      await expect(
        repo.validateEvidence(repository, { ...index.evidence, timestamp: now - 1 }, true),
      ).rejects.toThrow(/timestamp/);
      verify.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'signature refused' });
      await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(/authentication/);
      expect(advance).not.toHaveBeenCalled();
    });
  });

describe('retained v2 signed descriptor enforcement', () => {
  it('rejects changed index bytes and absent or nonregular index files', async () => {
    const { repo, index, directory, advance } = await retained('v2');
    const path = join(directory, 'index.json');
    await chmod(path, 0o600);
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('org.example.app', 'org.example.bad'));
    await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(
      /differs from its signed entry/,
    );
    await rm(path);
    await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await mkdir(path);
    await expect(repo.validateEvidence(repository, index.evidence, true)).rejects.toThrow(/regular file/);
    expect(advance).not.toHaveBeenCalled();
  });
  it('rejects signed size, descriptor hash and entry timestamp mismatches after authenticating the entry', async () => {
    const { entry } = repositoryDocuments('v2');
    const changes = [
      { ...entry, index: { ...entry.index, size: entry.index.size + 1 } },
      { ...entry, index: { ...entry.index, size: entry.index.size - 1 } },
      { ...entry, index: { ...entry.index, sha256: '0'.repeat(64) } },
      { ...entry, timestamp: now - 1 },
    ];
    for (const signed of changes) {
      const { repo, index, directory, advance, verify, offline } = await retained('v2');
      const jar = JSON.stringify(signed);
      await chmod(join(directory, 'entry.jar'), 0o600);
      await writeFile(join(directory, 'entry.jar'), jar);
      // Keep the content identity consistent so validation reaches the signed descriptor.
      const evidence = { ...index.evidence, entrySha256: digest(jar) };
      evidence.signatureMaterialId = digest(
        `entry.jar\0${evidence.entrySha256}\0index.json\0${evidence.indexSha256}`,
      );
      await rename(directory, join(root, 'repository-signatures', evidence.signatureMaterialId));
      await expect(repo.validateEvidence(repository, evidence, true)).rejects.toThrow(
        /signed entry|size limit|timestamps/,
      );
      expect(verify).toHaveBeenCalledOnce();
      expect(advance).not.toHaveBeenCalled();
      expect(offline).not.toHaveBeenCalled();
    }
  });
  it('rejects a reviewed index hash that differs from the authenticated descriptor', async () => {
    const { repo, index, directory, advance } = await retained('v2');
    const evidence = { ...index.evidence, indexSha256: '0'.repeat(64) };
    evidence.signatureMaterialId = digest(
      `entry.jar\0${evidence.entrySha256}\0index.json\0${evidence.indexSha256}`,
    );
    await rename(directory, join(root, 'repository-signatures', evidence.signatureMaterialId));
    await expect(repo.validateEvidence(repository, evidence, true)).rejects.toThrow(
      /differs from its signed entry/,
    );
    expect(advance).not.toHaveBeenCalled();
  });
});

describe('repository indexing cancellation', () => {
  it('does not fetch, retain or advance for an already cancelled acquisition', async () => {
    const { repo, advance, verify } = repositoryFixture(root);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort(new Error('Repository review cancelled'));
    await expect(repo.index(repository, { signal: controller.signal })).rejects.toThrow(/review cancelled/);
    expect(fetch).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it('propagates cancellation between authenticated v2 entry and index download without retaining partial evidence', async () => {
    const { repo, advance } = repositoryFixture(root);
    const documents = repositoryDocuments('v2');
    const controller = new AbortController();
    const run = vi.spyOn(repo.runner, 'run');
    const fetch = vi.fn((url: URL) => {
      if (url.pathname.endsWith('.json')) controller.abort(new Error('Index download cancelled'));
      return documents.fetch(url);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(repo.index(repository, { signal: controller.signal })).rejects.toThrow(
      /Index download cancelled/,
    );
    expect(run.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    const jar = run.mock.calls[0]?.[0].at(-3);
    expect(jar).toBeDefined();
    await expect(lstat(jar!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(advance).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
