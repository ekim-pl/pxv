import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HostTools, type CommandRunner, type HostToolArchive } from '../../packages/adapters/src/index.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-host-test-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const outputs: Record<string, string> = {
  adb: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-123\n',
  fastboot: 'fastboot version 37.0.1-123\n',
  java: 'openjdk version "17.0.20"\n',
  aapt: 'Android Asset Packaging Tool, v0.2-123\n',
  apksigner: '0.9\n',
  'ssh-keygen': 'usage: ssh-keygen [-Y verify]\n',
};
const runner: CommandRunner = {
  run: (args) =>
    Promise.resolve({
      code: basename(args[0] ?? '') === 'ssh-keygen' ? 1 : 0,
      stdout: outputs[basename(args[0] ?? '')] ?? '',
      stderr: '',
    }),
};
async function executable(path: string) {
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
}
describe('read-only host discovery and explicit verified bootstrap', () => {
  it('discovers Android tools in the selected SDK and enforces supported Java/platform versions', async () => {
    const sdk = join(directory, 'sdk');
    const platform = join(sdk, 'platform-tools');
    const build = join(sdk, 'build-tools', '35.0.0');
    const bin = join(directory, 'bin');
    await mkdir(platform, { recursive: true });
    await mkdir(build, { recursive: true });
    await mkdir(bin);
    for (const name of ['adb', 'fastboot']) await executable(join(platform, name));
    for (const name of ['aapt', 'apksigner']) await executable(join(build, name));
    for (const name of ['java', 'ssh-keygen']) await executable(join(bin, name));
    const host = new HostTools({ runner, env: { ANDROID_HOME: sdk, PATH: bin } });
    const statuses = await host.doctor();
    expect(statuses.every((status) => status.optional || status.compatible)).toBe(true);
    expect(statuses.find((status) => status.tool === 'fdroidcl')).toMatchObject({
      optional: true,
      available: false,
      compatible: false,
    });
    await expect(host.require('fdroidcl')).rejects.toThrow();
    expect(await host.require('aapt')).toBe(join(build, 'aapt'));
    const obsolete = new HostTools({
      runner: { run: () => Promise.resolve({ code: 0, stdout: 'fastboot version 34.0.0', stderr: '' }) },
      env: { ANDROID_HOME: sdk, PATH: '' },
    });
    expect((await obsolete.inspect('fastboot')).compatible).toBe(false);
    await expect(obsolete.require('fastboot')).rejects.toThrow(/incompatible/);
  });
  it('selects canonical homes verbatim, falls back from empty homes and rejects invalid selected Java', async () => {
    const canonical = join(directory, 'canonical home');
    const native = join(directory, 'native home');
    for (const home of [canonical, native]) {
      await mkdir(join(home, 'bin'), { recursive: true });
      await mkdir(join(home, 'platform-tools'));
      await executable(join(home, 'bin', 'java'));
      await executable(join(home, 'platform-tools', 'adb'));
    }
    const env = {
      PXV_ANDROID_HOME: canonical,
      ANDROID_HOME: native,
      PXV_JAVA_HOME: canonical,
      JAVA_HOME: native,
      PATH: join(native, 'bin'),
    };
    const host = new HostTools({ runner, env });
    expect(await host.discover('adb')).toBe(join(canonical, 'platform-tools', 'adb'));
    expect(await host.discover('java')).toBe(join(canonical, 'bin', 'java'));
    env.PXV_ANDROID_HOME = '';
    env.PXV_JAVA_HOME = '';
    expect(await host.discover('adb')).toBe(join(native, 'platform-tools', 'adb'));
    expect(await host.discover('java')).toBe(join(native, 'bin', 'java'));
    expect(
      await new HostTools({
        runner,
        env: { PXV_JAVA_HOME: '', JAVA_HOME: '', PATH: join(native, 'bin') },
      }).discover('java'),
    ).toBe(join(native, 'bin', 'java'));
    const fallback = join(directory, 'Android', 'Sdk', 'platform-tools');
    await mkdir(fallback, { recursive: true });
    await executable(join(fallback, 'adb'));
    vi.stubEnv('HOME', directory);
    expect(await new HostTools({ runner, env: { ANDROID_SDK_ROOT: native, PATH: '' } }).discover('adb')).toBe(
      join(fallback, 'adb'),
    );
    env.PXV_JAVA_HOME = join(directory, 'missing');
    expect(await host.discover('java')).toBeUndefined();
    expect(
      await new HostTools({ runner, env: { ...env, PXV_TOOL_JAVA: join(native, 'bin', 'java') } }).discover(
        'java',
      ),
    ).toBe(join(native, 'bin', 'java'));
    expect(
      await new HostTools({ runner, env: { ...env, PXV_TOOL_JAVA: '' } }).discover('java'),
    ).toBeUndefined();
    expect(
      await new HostTools({ runner, env: { ANDROID_SDK_ROOT: native, PATH: '' } }).discover('adb'),
    ).not.toBe(join(native, 'platform-tools', 'adb'));
  });
  it('requires a working fdroidcl when explicitly selected', async () => {
    const path = join(directory, 'fdroidcl');
    await executable(path);
    const host = new HostTools({
      runner: { run: () => Promise.resolve({ code: 0, stdout: 'fdroidcl 0.7.0', stderr: '' }) },
      env: { PXV_TOOL_FDROIDCL: path },
    });
    expect(await host.inspect('fdroidcl')).toMatchObject({ optional: true, compatible: true });
    expect(await host.require('fdroidcl')).toBe(path);
    const broken = new HostTools({
      runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'failed' }) },
      env: { PXV_TOOL_FDROIDCL: path },
    });
    await expect(broken.require('fdroidcl')).rejects.toThrow('incompatible');
  });

  it('treats explicit overrides as authoritative and never fetches during doctor', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const host = new HostTools({
      runner,
      env: { ANDROID_HOME: directory, PATH: '', PXV_TOOL_ADB: join(directory, 'missing') },
    });
    expect((await host.inspect('adb')).available).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const path = join(directory, 'custom-adb');
    await executable(path);
    const broken = new HostTools({
      runner: { run: () => Promise.reject(new Error('broken tool')) },
      env: { PXV_TOOL_ADB: path },
    });
    expect((await broken.inspect('adb')).available).toBe(false);
  });
  it('requires exact license acceptance, authenticates archive bytes and extracts into a new managed root', async () => {
    const input = join(directory, 'input');
    await mkdir(input);
    await executable(join(input, 'adb'));
    const zip = join(directory, 'tools.zip');
    await promisify(execFile)('zip', ['-q', '-j', zip, join(input, 'adb')]);
    const bytes = await readFile(zip);
    const archive: HostToolArchive = {
      id: 'platform-tools',
      url: 'https://dl.google.com/android/repository/platform-tools.zip',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      executables: ['adb'],
      licenseId: 'android-sdk-license',
    };
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal('fetch', fetcher);
    const host = new HostTools({ runner });
    await expect(
      host.bootstrap(archive, join(directory, 'declined'), { acceptedLicense: 'other-license' }),
    ).rejects.toThrow(/license acceptance/);
    expect(fetcher).not.toHaveBeenCalled();
    const installed = await host.bootstrap(archive, join(directory, 'managed'), {
      acceptedLicense: archive.licenseId,
    });
    expect(await readFile(join(installed, 'adb'), 'utf8')).toContain('exit 0');
    expect(
      JSON.parse(await readFile(join(installed, 'pxv-tool-provenance.json'), 'utf8')) as unknown,
    ).toMatchObject({ sha256: archive.sha256, licenseId: archive.licenseId });
    await expect(
      host.bootstrap(archive, join(directory, 'managed'), { acceptedLicense: archive.licenseId }),
    ).rejects.toThrow(/already exists/);
    await expect(
      host.bootstrap({ ...archive, sha256: '0'.repeat(64) }, join(directory, 'bad-hash'), {
        acceptedLicense: archive.licenseId,
      }),
    ).rejects.toThrow(/checksum/);
    await expect(
      host.bootstrap({ ...archive, url: 'https://evil.example/tools.zip' }, join(directory, 'bad-host'), {
        acceptedLicense: archive.licenseId,
      }),
    ).rejects.toThrow(/official Google/);
    await expect(
      host.bootstrap({ ...archive, executables: ['../adb'] }, join(directory, 'bad-path'), {
        acceptedLicense: archive.licenseId,
      }),
    ).rejects.toThrow(/Unsafe/);
  });
});
