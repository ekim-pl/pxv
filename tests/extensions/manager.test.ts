import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@pxv/contracts';
import { ExtensionManager, safeRelativePath, validateMetadata } from '@pxv/extensions';
import type { ExtensionMetadata } from '@pxv/extensions';
import { policyDocument } from '../contracts/fixtures.js';

interface TarFile {
  name: string;
  content: string;
  type?: string;
  link?: string;
}
function tarball(files: TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const content = Buffer.from(file.content);
    header.write(file.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(file.type ?? '0', 156, 1, 'ascii');
    if (file.link) header.write(file.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const metadata: ExtensionMetadata = {
  schemaVersion: 1,
  id: '@private/fleet',
  version: '0.1.0',
  apiVersion: 1,
  entry: 'index.js',
  contributions: { commands: ['review'], policyPacks: [], guides: ['guide.md'], adapters: [] },
};
const goodCode = `export default {apiVersion:1,commands:{review:input=>[{kind:'manual',capability:'operator_signoff',instructions:'Review '+input}]}};`;
const bundle = (
  options: { metadata?: unknown; manifest?: Record<string, unknown>; code?: string; extra?: TarFile[] } = {},
): Buffer =>
  tarball([
    {
      name: 'package/package.json',
      content: JSON.stringify({
        name: metadata.id,
        version: metadata.version,
        type: 'module',
        main: 'index.js',
        ...options.manifest,
      }),
    },
    { name: 'package/pxv-extension.json', content: JSON.stringify(options.metadata ?? metadata) },
    { name: 'package/index.js', content: options.code ?? goodCode },
    { name: 'package/guide.md', content: '# Private extension guide' },
    ...(options.extra ?? []),
  ]);
const integrity = (content: Buffer): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

describe('extension distribution and isolation', () => {
  let root = '';
  let manager: ExtensionManager;
  let sequence = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-extension-'));
    manager = new ExtensionManager({ installRoot: join(root, 'installed') });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const pathFor = async (rootPath: string, content: Buffer): Promise<string> => {
    const path = join(rootPath, `extension-${sequence++}.tgz`);
    await writeFile(path, content);
    return path;
  };

  it('installs a pinned local bundle, inspects offline and produces only core actions in a worker', async () => {
    const content = bundle();
    const lock = await manager.install({
      tarball: await pathFor(root, content),
      integrity: integrity(content),
    });
    expect(lock).toMatchObject({
      id: metadata.id,
      version: '0.1.0',
      apiVersion: 1,
      integrity: integrity(content),
    });
    expect(await manager.inspect(lock)).toEqual(metadata);
    expect(await manager.list()).toEqual([lock]);
    expect((await lstat(join(manager.installRoot, lock.installPath, 'index.js'))).mode & 0o777).toBe(0o400);
    expect(await manager.invoke(lock, 'review', 'phone-001')).toEqual([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review phone-001' },
    ]);
    expect(await manager.install({ tarball: await pathFor(root, content) })).toEqual(lock);
    expect(await manager.list()).toEqual([lock]);
  });

  it('rejects symlink installation roots, symlink installed trees and unexpected shared entries', async () => {
    const path = await pathFor(root, bundle());
    const actual = join(root, 'actual');
    await mkdir(actual);
    const alias = join(root, 'alias');
    await symlink(actual, alias);
    await expect(new ExtensionManager({ installRoot: alias }).install({ tarball: path })).rejects.toThrow(
      'root cannot be a symlink',
    );
    const lock = await manager.install({ tarball: path });
    const installed = join(manager.installRoot, lock.installPath);
    const retained = join(root, 'retained');
    await rename(installed, retained);
    await symlink(retained, installed);
    await expect(manager.inspect(lock)).rejects.toThrow('Installed extension cannot be a symlink');
    await rm(installed);
    await rename(retained, installed);
    await writeFile(join(manager.installRoot, 'unexpected'), 'unowned');
    await expect(manager.list()).rejects.toThrow('Unexpected extension installation entry');
  });

  it('explicitly updates to another exact immutable version while retaining old locks', async () => {
    const first = await manager.install({ tarball: await pathFor(root, bundle()) });
    const nextBundle = bundle({
      metadata: { ...metadata, version: '0.2.0' },
      manifest: { version: '0.2.0' },
    });
    const next = await manager.update(first, { tarball: await pathFor(root, nextBundle) });
    expect(next.version).toBe('0.2.0');
    expect(next.installPath).not.toBe(first.installPath);
    expect(await manager.inspect(first)).toEqual(metadata);
    expect(await manager.list()).toHaveLength(2);
    const different = bundle({ metadata: { ...metadata, id: 'different' }, manifest: { name: 'different' } });
    await expect(manager.update(first, { tarball: await pathFor(root, different) })).rejects.toThrow(
      'preserve package identity',
    );
  });

  it('repairs a missing pinned installation through an explicit exact-version update', async () => {
    const first = await manager.install({ tarball: await pathFor(root, bundle()) });
    await rm(join(manager.installRoot, first.installPath), { recursive: true, force: true });
    await expect(manager.inspect(first)).rejects.toThrow();
    const next = await manager.update(first, {
      tarball: await pathFor(
        root,
        bundle({ metadata: { ...metadata, version: '0.2.0' }, manifest: { version: '0.2.0' } }),
      ),
    });
    expect(next.version).toBe('0.2.0');
    expect(await manager.inspect(next)).toMatchObject({ id: first.id, version: '0.2.0' });
  });

  it('authenticates only the configured private registry and strips credentials on redirected hosts', async () => {
    const content = bundle();
    const calls: { url: string; authorization: string | null }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.includes('%40private%2Ffleet/0.1.0'))
        return new Response(
          JSON.stringify({
            name: metadata.id,
            version: metadata.version,
            dist: { tarball: 'https://registry.example.org/archive.tgz', integrity: integrity(content) },
          }),
        );
      if (url === 'https://registry.example.org/archive.tgz')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.org/archive.tgz' },
        });
      return new Response(new Uint8Array(content));
    };
    const online = new ExtensionManager({
      installRoot: manager.installRoot,
      registry: 'https://registry.example.org',
      token: 'registry-secret-sentinel',
      fetch: fetcher,
    });
    const lock = await online.install({ package: metadata.id, version: metadata.version });
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer registry-secret-sentinel',
      'Bearer registry-secret-sentinel',
      null,
    ]);
    const receipts = await readFile(join(manager.installRoot, lock.installPath, '.pxv-lock.json'), 'utf8');
    expect(receipts).not.toContain('registry-secret-sentinel');
    expect(canonicalJson(await manager.list())).not.toContain('registry-secret-sentinel');
    expect(await manager.inspect(lock)).toEqual(metadata);
  });

  it('rejects duplicate registry metadata keys before downloading a bundle', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"name":"@private/fleet","name":"@private/fleet"}'));
    const online = new ExtensionManager({
      installRoot: manager.installRoot,
      registry: 'https://registry.example.org',
      fetch: transport,
    });
    await expect(online.install({ package: metadata.id, version: metadata.version })).rejects.toThrow(
      /duplicate|unique/iu,
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not resolve ranges or contact a registry implicitly', async () => {
    expect(await manager.list()).toEqual([]);
    await expect(manager.install({ package: metadata.id, version: metadata.version })).rejects.toThrow(
      'No private',
    );
    const fetcher = vi.fn<typeof fetch>();
    const online = new ExtensionManager({
      installRoot: manager.installRoot,
      registry: 'https://registry.example.org',
      fetch: fetcher,
    });
    await expect(online.install({ package: metadata.id, version: '^0.1.0' })).rejects.toThrow(
      'exact semantic',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () => new ExtensionManager({ installRoot: root, registry: 'http://registry.example.org' }),
    ).toThrow('HTTPS');
    expect(() => new ExtensionManager({ installRoot: root, token: 'bad\ntoken' })).toThrow('token');
    expect(() => new ExtensionManager({ installRoot: root, maxArchiveBytes: 0 })).toThrow('size limit');
  });

  it('rejects missing/corrupt packages, source integrity mismatches and archive size violations', async () => {
    await expect(manager.install({ tarball: join(root, 'missing.tgz') })).rejects.toThrow();
    const path = await pathFor(root, bundle());
    await expect(manager.install({ tarball: path, integrity: 'sha512-wrong' })).rejects.toThrow(
      'integrity mismatch',
    );
    const small = new ExtensionManager({ installRoot: manager.installRoot, maxArchiveBytes: 8 });
    await expect(small.install({ tarball: path })).rejects.toThrow('bounded read');
    const expanded = new ExtensionManager({ installRoot: manager.installRoot, maxExpandedBytes: 16 });
    await expect(expanded.install({ tarball: path })).rejects.toThrow('Expanded');
    await expect(
      manager.install({ tarball: await pathFor(root, Buffer.from('not a tar archive')) }),
    ).rejects.toThrow();
  });

  it.each([
    { name: '../escape', content: 'escape' },
    { name: 'package/../escape', content: 'escape' },
    { name: '/outside', content: 'escape' },
    { name: 'package/link', content: '', type: '2', link: '/etc/passwd' },
    { name: 'package/.npmrc', content: '//registry.example.org/:_authToken=sentinel' },
    { name: 'package/node_modules/dependency.js', content: 'export{}' },
    { name: 'package/.env', content: 'TOKEN=sentinel' },
    { name: 'package/index.js', content: 'duplicate' },
    { name: 'package/.pxv-lock.json', content: '{}' },
  ])('rejects unsafe archives before extracting $name', async (extra) => {
    await expect(
      manager.install({ tarball: await pathFor(root, bundle({ extra: [extra] })) }),
    ).rejects.toThrow();
    expect(await manager.list()).toEqual([]);
  });

  it.each([
    { scripts: { postinstall: 'bad' } },
    { dependencies: { dep: '1.0.0' } },
    { optionalDependencies: { dep: '1.0.0' } },
    { peerDependencies: { dep: '1.0.0' } },
    { devDependencies: { dep: '1.0.0' } },
    { bundledDependencies: ['dep'] },
    { name: 'mismatched' },
    { main: 'missing.js' },
    { type: 'commonjs' },
  ])('requires self-contained compiled ESM bundles: %s', async (manifest) => {
    await expect(manager.install({ tarball: await pathFor(root, bundle({ manifest })) })).rejects.toThrow();
  });

  it('detects tampered archive, entry, extra files, symlinks and changed project lock identity', async () => {
    const lock = await manager.install({ tarball: await pathFor(root, bundle()) });
    const directory = join(manager.installRoot, lock.installPath);
    const entry = join(directory, 'index.js');
    await chmod(entry, 0o600);
    await writeFile(entry, 'modified');
    await expect(manager.inspect(lock)).rejects.toThrow('content does not match');
    await writeFile(entry, goodCode);
    await writeFile(join(directory, 'unexpected.txt'), 'unexpected');
    await expect(manager.inspect(lock)).rejects.toThrow('unexpected files');
    await rm(join(directory, 'unexpected.txt'));
    await rm(entry);
    await symlink('/etc/passwd', entry);
    await expect(manager.inspect(lock)).rejects.toThrow('symlink');
    await rm(entry);
    await writeFile(entry, goodCode);
    await expect(manager.inspect({ ...lock, id: 'different' })).rejects.toThrow(
      'does not match project lock',
    );
    await writeFile(join(directory, '.pxv-archive.tgz'), 'corrupt');
    await expect(manager.inspect(lock)).rejects.toThrow('archive integrity');
  });

  it('validates API compatibility before importing extension code', async () => {
    const marker = join(root, 'executed');
    const malicious = bundle({
      metadata: { ...metadata, apiVersion: 2 },
      code: `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export default{};`,
    });
    await expect(manager.install({ tarball: await pathFor(root, malicious) })).rejects.toThrow(
      'Incompatible',
    );
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates extension crashes, invalid action returns, exits and timeouts', async () => {
    const install = async (code: string): Promise<Awaited<ReturnType<ExtensionManager['install']>>> =>
      manager.install({ tarball: await pathFor(root, bundle({ code })) });
    const crashing = await install(`throw new Error('private failure sentinel');`);
    await expect(manager.invoke(crashing, 'review', null)).rejects.toThrow('worker failed');
    const invalid = await install(`export default{apiVersion:1,commands:{review:()=>({verified:true})}}`);
    await expect(manager.invoke(invalid, 'review', null)).rejects.toThrow('planned core actions');
    const unsafe = await install(
      `export default{apiVersion:1,commands:{review:()=>[{kind:'shell',command:'wipe'}]}}`,
    );
    await expect(manager.invoke(unsafe, 'review', null)).rejects.toThrow();
    const exited = await install(`process.exit(0);`);
    await expect(manager.invoke(exited, 'review', null)).rejects.toThrow('without planned actions');
    const forever = await install(`export default{apiVersion:1,commands:{review:()=>new Promise(()=>{})}}`);
    await expect(manager.invoke(forever, 'review', null, 30)).rejects.toThrow(/timed out|exited/u);
    await expect(manager.invoke(unsafe, 'unknown', null)).rejects.toThrow('did not declare');
    await expect(manager.invoke(unsafe, 'review', null, 0)).rejects.toThrow('timeout');
  });

  it('revalidates worker IPC and redacts asynchronous worker crashes', async () => {
    const forged = await manager.install({
      tarball: await pathFor(
        root,
        bundle({
          code: `import {parentPort} from 'node:worker_threads';parentPort.postMessage({ok:true,actions:[{kind:'shell',command:'wipe'}]});export default{apiVersion:1,commands:{review:()=>new Promise(()=>{})}};`,
        }),
      ),
    });
    await expect(manager.invoke(forged, 'review', null)).rejects.toThrow();
    const masked = await manager.install({
      tarball: await pathFor(root, bundle({ code: `throw new Error('Extension result private sentinel');` })),
    });
    await expect(manager.invoke(masked, 'review', null)).rejects.toThrow(/^Extension worker failed$/u);
    const crashed = await manager.install({
      tarball: await pathFor(
        root,
        bundle({
          code: `process.nextTick(()=>{throw new Error('private async failure sentinel')});export default{apiVersion:1,commands:{review:()=>new Promise(()=>{})}};`,
        }),
      ),
    });
    await expect(manager.invoke(crashed, 'review', null)).rejects.toThrow(/^Extension worker failed$/u);
  });

  it('does not pass inherited host environment to extension workers', async () => {
    process.env['PXV_EXTENSION_PRIVATE_SENTINEL'] = 'do-not-inherit';
    try {
      const content = bundle({
        code: `export default{apiVersion:1,commands:{review:()=>[{kind:'manual',capability:'review',instructions:String(process.env.PXV_EXTENSION_PRIVATE_SENTINEL)}]}}`,
      });
      const lock = await manager.install({ tarball: await pathFor(root, content) });
      expect(await manager.invoke(lock, 'review', null)).toMatchObject([{ instructions: 'undefined' }]);
    } finally {
      delete process.env['PXV_EXTENSION_PRIVATE_SENTINEL'];
    }
  });

  it('consumes declared policy packs, guides and isolated integration adapter plans offline', async () => {
    const contributed = {
      ...metadata,
      contributions: { ...metadata.contributions, policyPacks: ['policy.json'], adapters: ['adapter.mjs'] },
    };
    const content = bundle({
      metadata: contributed,
      extra: [
        { name: 'package/policy.json', content: JSON.stringify(policyDocument) },
        {
          name: 'package/adapter.mjs',
          content: `export default {apiVersion:1,plan:input=>[{kind:'manual',capability:'operator_signoff',instructions:'Adapter '+input}]};`,
        },
      ],
    });
    const lock = await manager.install({ tarball: await pathFor(root, content) });
    expect(await manager.readContribution(lock, 'policyPacks', 'policy.json')).toEqual(policyDocument);
    expect(await manager.readContribution(lock, 'guides', 'guide.md')).toBe('# Private extension guide');
    expect(await manager.invokeAdapter(lock, 'adapter.mjs', 'review')).toEqual([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Adapter review' },
    ]);
    await expect(manager.readContribution(lock, 'policyPacks', '../private.json')).rejects.toThrow(
      'did not declare',
    );
    await expect(manager.invokeAdapter(lock, 'missing.mjs', {})).rejects.toThrow('did not declare');
    expect(() =>
      validateMetadata({
        ...contributed,
        contributions: { ...contributed.contributions, adapters: ['source.ts'] },
      }),
    ).toThrow('Invalid');
    const malformed = bundle({
      metadata: { ...metadata, contributions: { ...metadata.contributions, policyPacks: ['policy.json'] } },
      extra: [{ name: 'package/policy.json', content: '{"credentials":"must-not-enter-policy"}' }],
    });
    const invalid = await manager.install({ tarball: await pathFor(root, malformed) });
    await expect(manager.readContribution(invalid, 'policyPacks', 'policy.json')).rejects.toThrow();
    const legacy = bundle({
      metadata: contributed,
      extra: [
        { name: 'package/policy.json', content: JSON.stringify({ ...policyDocument, schemaVersion: 1 }) },
        { name: 'package/adapter.mjs', content: 'export default {apiVersion:1,plan:()=>[]};' },
      ],
    });
    const legacyLock = await manager.install({ tarball: await pathFor(root, legacy) });
    await expect(manager.readContribution(legacyLock, 'policyPacks', 'policy.json')).rejects.toThrow(
      'Unsupported policy schema version',
    );
  });
});

describe('extension metadata SDK', () => {
  it('exports definitions without changing commands and validates metadata', () => {
    expect(validateMetadata(metadata)).toEqual(metadata);
    expect(safeRelativePath('guides/en.md')).toBe(true);
    for (const path of ['../escape', '/absolute', 'C:/windows', 'a\\b', './entry', 'a//b', 'a\0b'])
      expect(safeRelativePath(path)).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { ...metadata, extra: true },
    { ...metadata, schemaVersion: 2 },
    { ...metadata, contributions: { ...metadata.contributions, commands: ['duplicate', 'duplicate'] } },
    { ...metadata, contributions: { ...metadata.contributions, guides: ['../escape'] } },
    { ...metadata, contributions: { ...metadata.contributions, commands: ['Bad Name'] } },
    { ...metadata, contributions: { ...metadata.contributions, commands: [1] } },
  ])('rejects invalid metadata %s', (value) => {
    expect(() => validateMetadata(value)).toThrow();
  });
});
