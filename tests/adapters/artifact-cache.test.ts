import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactPolicy } from '@pxv/contracts';
import { ArtifactService, type CommandRunner } from '../../packages/adapters/src/index.js';
import { cachedArtifact } from '../../packages/adapters/src/artifact-cache.js';

const bytes = 'signed APK cache fixture';
const sha256 = createHash('sha256').update(bytes).digest('hex');
const policy: ArtifactPolicy = {
  packageId: 'org.example.app',
  versionCode: 1,
  signerSha256: 'b'.repeat(64),
  sha256,
  url: 'https://example.com/app.apk',
};
const runner: CommandRunner = {
  run: (args) =>
    Promise.resolve({
      code: 0,
      stdout: args.includes('badging')
        ? "package: name='org.example.app' versionCode='1'"
        : `Signer #1 certificate SHA-256 digest: ${'b'.repeat(64)}\n`,
      stderr: '',
    }),
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-artifact-cache-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
function service(directory = root): ArtifactService {
  return new ArtifactService({ runner, cacheRoot: join(directory, 'cache') });
}
function downloads(value = bytes) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(value)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function plan(name: string): string {
  return join(root, 'plans', name, 'app.apk');
}
function controlledDownloads() {
  const pending: { signal: AbortSignal; finish(): void }[] = [];
  const fetch = vi.fn().mockImplementation((_url: URL, options: RequestInit) => {
    const signal = options.signal;
    if (!signal) throw new Error('Missing acquisition signal');
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error('Acquisition cancelled'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      pending.push({
        signal,
        finish() {
          signal.removeEventListener('abort', aborted);
          resolve(new Response(bytes));
        },
      });
      if (signal.aborted) aborted();
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, pending };
}
async function promptly(result: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation waited for another acquisition')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('artifact acquisition cancellation contexts', () => {
  it('keeps another context alive when the first owner cancels its download', async () => {
    const { fetch, pending } = controlledDownloads();
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = service().snapshot(policy, plan('first'), first.signal);
    const secondResult = service().snapshot(policy, plan('second'), second.signal);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const rejected = expect(firstResult).rejects.toThrow('First acquisition cancelled');
      first.abort(new Error('First acquisition cancelled'));
      await promptly(rejected);
      const remaining = pending.filter((request) => !request.signal.aborted);
      expect(remaining).toHaveLength(1);
      remaining[0]?.finish();
      expect((await secondResult).sha256).toBe(sha256);
      expect(await readFile(plan('second'), 'utf8')).toBe(bytes);
      await expect(stat(plan('first'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      pending.forEach((request) => request.finish());
      await Promise.allSettled([firstResult, secondResult]);
    }
  });
  it('cancels a later caller promptly while the first context is still waiting', async () => {
    const { fetch, pending } = controlledDownloads();
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = service().snapshot(policy, plan('first'), first.signal);
    const secondResult = service().snapshot(policy, plan('second'), second.signal);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const rejected = expect(secondResult).rejects.toThrow('Second acquisition cancelled');
      second.abort(new Error('Second acquisition cancelled'));
      await promptly(rejected);
      expect(first.signal.aborted).toBe(false);
      await expect(stat(plan('first'))).rejects.toMatchObject({ code: 'ENOENT' });
      const remaining = pending.filter((request) => !request.signal.aborted);
      expect(remaining).toHaveLength(1);
      remaining[0]?.finish();
      expect((await firstResult).sha256).toBe(sha256);
    } finally {
      pending.forEach((request) => request.finish());
      await Promise.allSettled([firstResult, secondResult]);
    }
  });
  it('coalesces callers that intentionally share the same cancellation signal', async () => {
    const { fetch, pending } = controlledDownloads();
    const shared = new AbortController();
    const first = service().snapshot(policy, plan('first'), shared.signal);
    const second = service().snapshot(policy, plan('second'), shared.signal);
    const outcomes = Promise.allSettled([first, second]);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      shared.abort(new Error('Shared acquisition cancelled'));
      const result = await outcomes;
      expect(result.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
      expect(pending).toHaveLength(1);
    } finally {
      pending.forEach((request) => request.finish());
      await outcomes;
    }
  });
});

describe('verified project-local artifact cache', () => {
  it('coalesces acquisition and gives each plan immutable references to one verified blob', async () => {
    const fetch = downloads();
    const [first, second] = await Promise.all([
      service().snapshot(policy, plan('one')),
      service().snapshot(policy, plan('two')),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const third = await service().snapshot(policy, plan('three'));
    expect(fetch).toHaveBeenCalledOnce();
    expect([first.path, second.path, third.path]).toEqual([plan('one'), plan('two'), plan('three')]);
    const files = await Promise.all([first.path, second.path, third.path].map((path) => stat(path)));
    expect(new Set(files.map((file) => file.ino)).size).toBe(1);
    expect(files.every((file) => (file.mode & 0o777) === 0o400)).toBe(true);
    expect(await readdir(join(root, 'cache/apk/content'))).toEqual([sha256]);
    expect(JSON.parse(await readFile(`${first.path}.ref.json`, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      sha256,
      path: join(root, 'cache/apk/content', sha256, 'artifact.apk'),
    });
    expect((await readdir(join(root, 'cache/apk'))).some((name) => name.startsWith('.acquire-'))).toBe(false);
  });

  it('stages independent bytes and refuses changed shared content without redownloading or repair', async () => {
    const fetch = downloads();
    const first = await service().snapshot(policy, plan('one'));
    let stagedPath = '';
    await service().withStaged(first, async (staged) => {
      stagedPath = staged.path;
      expect((await stat(staged.path)).ino).not.toBe((await stat(first.path)).ino);
      expect(await readFile(staged.path, 'utf8')).toBe(bytes);
    });
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(first.path, 0o600);
    await writeFile(first.path, 'tampered shared APK');
    const installed = vi.fn();
    await expect(service().withStaged(first, installed)).rejects.toThrow(/SHA-256/);
    expect(installed).not.toHaveBeenCalled();
    await expect(service().snapshot(policy, plan('two'))).rejects.toThrow(/SHA-256/);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(stat(plan('two'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(first.path, 'utf8')).toBe('tampered shared APK');
  });

  it('checks every coalesced request identity and revalidates signers on retained content', async () => {
    downloads();
    const attempts = await Promise.allSettled([
      service().snapshot(policy, plan('one')),
      service().snapshot({ ...policy, versionCode: 2 }, plan('wrong')),
    ]);
    expect(attempts[0]?.status).toBe('fulfilled');
    expect(attempts[1]).toMatchObject({ status: 'rejected' });
    expect((attempts[1] as { reason: Error }).reason.message).toMatch(/identity/);
    const wrongSigner = new ArtifactService({
      cacheRoot: join(root, 'cache'),
      runner: {
        run: (args) =>
          args.includes('badging')
            ? runner.run(args)
            : Promise.resolve({
                code: 0,
                stdout: `Signer #1 certificate SHA-256 digest: ${'c'.repeat(64)}\n`,
                stderr: '',
              }),
      },
    });
    await expect(wrongSigner.snapshot(policy, plan('bad-signer'))).rejects.toThrow(/signer/);
  });

  it('removes failed acquisitions, supports retry, and never overwrites a retained plan path', async () => {
    const fetch = downloads('wrong bytes');
    await expect(service().snapshot(policy, plan('bad'))).rejects.toThrow(/SHA-256/);
    expect(await readdir(join(root, 'cache/apk/content'))).toEqual([]);
    expect(await readdir(join(root, 'cache/apk/refs'))).toEqual([]);
    fetch.mockImplementation(() => Promise.resolve(new Response(bytes)));
    await service().snapshot(policy, plan('retained'));
    await expect(service().snapshot(policy, plan('retained'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(plan('retained'), 'utf8')).toBe(bytes);
    const controller = new AbortController();
    controller.abort(new Error('Cancelled acquisition'));
    await expect(service().snapshot(policy, plan('cancelled'), controller.signal)).rejects.toThrow(
      /Cancelled/,
    );
    await expect(stat(plan('cancelled'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe cache and plan directories before writing outside the project tree', async () => {
    downloads();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'cache'));
    await expect(service().snapshot(policy, plan('unsafe'))).rejects.toThrow(/symlinks/);
    expect(await readdir(outside)).toEqual([]);
    await rm(join(root, 'cache'));
    const retained = await service().snapshot(policy, plan('safe'));
    await symlink(outside, join(root, 'plans', 'unsafe'));
    await expect(service().snapshot(policy, plan('unsafe'))).rejects.toThrow(/symlinks/);
    expect(await readdir(outside)).toEqual([]);
    const retainedReference = JSON.parse(await readFile(`${retained.path}.ref.json`, 'utf8')) as {
      path: string;
    };
    const content = dirname(retainedReference.path);
    await rm(content, { recursive: true });
    await symlink(outside, content);
    await expect(service().snapshot(policy, plan('linked-content'))).rejects.toThrow(/symlinks/);
  });

  it('refuses corrupt references, missing blobs and malicious reference paths without reacquisition', async () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      { schemaVersion: 2, content: sha256 },
      { schemaVersion: 1, content: '../escape' },
      { schemaVersion: 1, content: sha256, extra: true },
    ];
    const fetch = downloads();
    for (const [index, value] of malformed.entries()) {
      const at = join(root, `invalid-${index}`);
      await service(at).snapshot(policy, plan(`initial-${index}`));
      const ref = join(at, 'cache/apk/refs', `${sha256}.json`);
      await chmod(ref, 0o600);
      await writeFile(ref, JSON.stringify(value));
      await expect(service(at).snapshot(policy, plan(`rejected-${index}`))).rejects.toThrow(
        /reference|content/,
      );
    }
    const first = await service().snapshot(policy, plan('missing'));
    const reference = join(root, 'cache/apk/refs', `${sha256}.json`);
    await chmod(reference, 0o600);
    await writeFile(reference, 'x'.repeat(1025));
    await expect(service().snapshot(policy, plan('oversized'))).rejects.toThrow(/reference is invalid/);
    await writeFile(reference, JSON.stringify({ schemaVersion: 1, content: sha256 }));
    await rm(join(root, 'cache/apk/content', sha256), { recursive: true });
    await expect(service().snapshot(policy, plan('missing-again'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(first.path, 'utf8')).toBe(bytes);
    expect(fetch).toHaveBeenCalledTimes(malformed.length + 1);
  });
});

describe('cache content address and interrupted publication checks', () => {
  function fixture() {
    const digest = (value: { bytes: string }) => createHash('sha256').update(value.bytes).digest('hex');
    return {
      root: join(root, 'cache'),
      key: 'publication',
      build: async (directory: string) => {
        await mkdir(directory);
        await writeFile(join(directory, 'bytes'), bytes);
        return { bytes };
      },
      verify: async (directory: string) => ({ bytes: await readFile(join(directory, 'bytes'), 'utf8') }),
      contentId: digest,
      relocate: (value: { bytes: string }) => value,
    };
  }
  it('verifies and reuses an already published blob when its request index was interrupted', async () => {
    const options = fixture();
    const content = join(options.root, 'content', sha256);
    await mkdir(content, { recursive: true });
    await writeFile(join(content, 'bytes'), bytes);
    const inode = (await stat(join(content, 'bytes'))).ino;
    expect(await cachedArtifact(options)).toEqual({ bytes });
    expect((await stat(join(content, 'bytes'))).ino).toBe(inode);
    expect(await readdir(join(options.root, 'refs'))).toEqual(['publication.json']);
  });
  it('rejects changed content addresses even when bytes are otherwise accepted by the verifier', async () => {
    const options = fixture();
    await cachedArtifact(options);
    await writeFile(join(options.root, 'content', sha256, 'bytes'), 'different authentic bytes');
    await expect(cachedArtifact(options)).rejects.toThrow(/content address/);
  });
  it('rejects invalid builder content IDs and absent publication sources without retaining a request', async () => {
    const options = fixture();
    await expect(cachedArtifact({ ...options, contentId: () => '../escape' })).rejects.toThrow(
      /content address/,
    );
    await expect(
      cachedArtifact({ ...options, build: () => Promise.resolve({ bytes }) }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(options.root, 'refs'))).toEqual([]);
    expect(await readdir(join(options.root, 'content'))).toEqual([]);
  });
  it('does not replace an index concurrently published for different authenticated bytes', async () => {
    const options = fixture();
    const competing = { schemaVersion: 1, content: 'c'.repeat(64) };
    const build = options.build;
    options.build = async (directory) => {
      const value = await build(directory);
      await writeFile(join(options.root, 'refs/publication.json'), JSON.stringify(competing));
      return value;
    };
    await expect(cachedArtifact(options)).rejects.toThrow(/different authenticated bytes/);
    expect(JSON.parse(await readFile(join(options.root, 'refs/publication.json'), 'utf8'))).toEqual(
      competing,
    );
  });
});

async function subprocess(script: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
const cacheModule = pathToFileURL(resolve('packages/adapters/dist/artifact-cache.js')).href;
const publicationScript = `
import {cachedArtifact} from ${JSON.stringify(cacheModule)};
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const [root,name,bytes] = process.argv.slice(1);
const hash = value => createHash('sha256').update(value).digest('hex');
const verify = async directory => ({bytes:await readFile(join(directory,'bytes'),'utf8')});
try {
  const result=await cachedArtifact({root:join(root,'cache'),key:'shared-request',
    build:async directory=>{
      await mkdir(directory);
      await writeFile(join(directory,'bytes'),bytes);
      await writeFile(join(root,name+'.ready'),'ready');
      const deadline=Date.now()+5000;
      while((await readdir(root)).filter(p=>p.endsWith('.ready')).length<2){
        if(Date.now()>deadline)throw Error('Publication barrier timed out');
        await new Promise(done=>setTimeout(done,10));
      }
      return {bytes};
    },verify,contentId:value=>hash(value.bytes),relocate:value=>value});
  process.stdout.write(JSON.stringify(result));
}catch(error){process.stderr.write(error.message);process.exitCode=1;}
`;

describe('atomic artifact publication across processes', () => {
  it('deduplicates equal authenticated bytes and safely resolves simultaneous publication', async () => {
    const result = await Promise.all([
      subprocess(publicationScript, [root, 'one', 'same bytes']),
      subprocess(publicationScript, [root, 'two', 'same bytes']),
    ]);
    expect(
      result.every((value) => value.code === 0),
      JSON.stringify(result),
    ).toBe(true);
    expect(await readdir(join(root, 'cache/content'))).toHaveLength(1);
    expect(await readdir(join(root, 'cache/refs'))).toEqual(['shared-request.json']);
  });
  it('refuses conflicting authenticated results while retaining a complete immutable winner', async () => {
    const results = await Promise.all([
      subprocess(publicationScript, [root, 'one', 'first signed release']),
      subprocess(publicationScript, [root, 'two', 'different signed release']),
    ]);
    expect(results.map((value) => value.code).sort(), JSON.stringify(results)).toEqual([0, 1]);
    expect(results.find((value) => value.code === 1)?.stderr).toMatch(/different authenticated bytes/);
    const value = await cachedArtifact({
      root: join(root, 'cache'),
      key: 'shared-request',
      build: () => {
        throw new Error('Must not reacquire retained content');
      },
      verify: async (directory) => ({ bytes: await readFile(join(directory, 'bytes'), 'utf8') }),
      contentId: (entry: { bytes: string }) => createHash('sha256').update(entry.bytes).digest('hex'),
      relocate: (entry) => entry,
    });
    expect(['first signed release', 'different signed release']).toContain(value.bytes);
  });
});
