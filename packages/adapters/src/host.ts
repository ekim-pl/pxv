import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { AdapterError, sha256Pin, type CommandRunner } from './command.js';
import { download, fileDigest } from './files.js';
import { extractZip } from './zip.js';

export type HostTool = 'adb' | 'fastboot' | 'aapt' | 'apksigner' | 'java' | 'ssh-keygen';
export interface HostToolStatus {
  tool: HostTool;
  path?: string;
  available: boolean;
  compatible: boolean;
  version?: string;
  reason?: string;
}
export interface HostToolsOptions {
  runner: CommandRunner;
  env?: NodeJS.ProcessEnv;
}
export interface HostToolArchive {
  id: string;
  url: string;
  sha256: string;
  executables: string[];
  licenseId: string;
}
export interface BootstrapOptions {
  acceptedLicense: string;
  signal?: AbortSignal;
}
const DEFINITIONS: Record<HostTool, string[]> = {
  adb: ['version'],
  fastboot: ['--version'],
  aapt: ['version'],
  apksigner: ['version'],
  java: ['-version'],
  'ssh-keygen': ['-?'],
};
function versionAtLeast(version: string, minimum: number[]): boolean {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((parts[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}
/** Discovery is read-only; it never downloads tools or starts an ADB server. */
export class HostTools {
  readonly runner: CommandRunner;
  readonly env: NodeJS.ProcessEnv;
  constructor(options: HostToolsOptions) {
    this.runner = options.runner;
    this.env = options.env ?? process.env;
  }
  async discover(tool: HostTool): Promise<string | undefined> {
    const override = this.env[`PXV_TOOL_${tool.replace('-', '_').toUpperCase()}`];
    const sdk = this.env['ANDROID_HOME'] ?? this.env['ANDROID_SDK_ROOT'] ?? join(homedir(), 'Android', 'Sdk');
    const managed = this.env['PXV_TOOLS_DIR'];
    const directories = [
      ...(managed ? [join(managed, 'platform-tools'), join(managed, 'build-tools', '35.0.0')] : []),
      join(sdk, 'platform-tools'),
      this.env['PXV_BUILD_TOOLS'] ?? join(sdk, 'build-tools', '35.0.0'),
      ...(this.env['PATH'] ?? '/usr/bin:/bin').split(delimiter).filter(Boolean),
    ];
    const candidates = override ? [override] : directories.map((directory) => join(directory, tool));
    for (const candidate of candidates) {
      try {
        const path = await realpath(candidate);
        if (!(await lstat(path)).isFile()) continue;
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try the next explicit host path. */
      }
    }
    return undefined;
  }
  async inspect(tool: HostTool): Promise<HostToolStatus> {
    const path = await this.discover(tool);
    if (!path)
      return {
        tool,
        available: false,
        compatible: false,
        reason: 'Executable was not found in the configured SDK, managed tools or PATH',
      };
    try {
      const result = await this.runner.run([path, ...DEFINITIONS[tool]], { timeoutMs: 5000, check: false });
      const output = `${result.stdout}\n${result.stderr}`;
      let version: string | undefined;
      let compatible = false;
      switch (tool) {
        case 'adb':
          version = /(?:^|\n)Version (\d+\.\d+\.\d+)/.exec(output)?.[1];
          compatible = result.code === 0 && !!version && versionAtLeast(version, [35, 0, 2]);
          break;
        case 'fastboot':
          version = /(?:fastboot version|Version) (\d+\.\d+\.\d+)/.exec(output)?.[1];
          compatible = result.code === 0 && !!version && versionAtLeast(version, [35, 0, 2]);
          break;
        case 'java':
          version = /(?:openjdk|java) version "(\d+(?:\.\d+)*)/.exec(output)?.[1];
          compatible = result.code === 0 && !!version && versionAtLeast(version, [17]);
          break;
        case 'aapt':
          version = /Android Asset Packaging Tool, (v[^\s]+|[^\s]+)/.exec(output)?.[1];
          compatible = result.code === 0 && !!version;
          break;
        case 'apksigner':
          version = /^\s*(\d+(?:\.\d+)+)/.exec(output)?.[1];
          compatible = result.code === 0 && !!version;
          break;
        case 'ssh-keygen':
          version = 'OpenSSH signature tool';
          compatible = output.includes('ssh-keygen') && output.includes('-Y') && output.includes('verify');
          break;
      }
      return {
        tool,
        path,
        available: true,
        compatible,
        ...(version ? { version } : {}),
        ...(!compatible
          ? { reason: 'The installed executable did not report a supported version or required capability' }
          : {}),
      };
    } catch {
      return { tool, path, available: false, compatible: false, reason: 'Executable inspection failed' };
    }
  }
  async doctor(): Promise<HostToolStatus[]> {
    return Promise.all((Object.keys(DEFINITIONS) as HostTool[]).map((tool) => this.inspect(tool)));
  }
  async require(tool: HostTool): Promise<string> {
    const status = await this.inspect(tool);
    if (!status.compatible || !status.path)
      throw new AdapterError(
        `${tool} is unavailable or incompatible: ${status.reason ?? 'Inspect host diagnostics'}`,
      );
    return status.path;
  }
  /** Explicit bootstrap only. Exact license acceptance is supplied by the operator-facing command. */
  async bootstrap(archive: HostToolArchive, destination: string, options: BootstrapOptions): Promise<string> {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(archive.id) ||
      archive.licenseId !== options.acceptedLicense ||
      !archive.licenseId
    )
      throw new AdapterError('Tool bootstrap requires the exact reviewed license acceptance');
    sha256Pin(archive.sha256);
    const url = new URL(archive.url);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'dl.google.com' ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      throw new AdapterError('Android host archives require the official Google HTTPS distribution host');
    for (const entry of archive.executables)
      if (
        isAbsolute(entry) ||
        !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(entry) ||
        entry.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new AdapterError('Unsafe host tool executable path');
    if (!archive.executables.length)
      throw new AdapterError('Approved host archive must identify its executables');
    try {
      await lstat(destination);
      throw new AdapterError('Managed tool destination already exists; preserve it for explicit replacement');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(dirname(destination), '.pxv-tool-bootstrap-'));
    try {
      const path = join(directory, 'tool.zip');
      await download(path, archive.url, {
        limit: 512 * 1024 * 1024,
        timeoutMs: 600_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if ((await fileDigest(path, 512 * 1024 * 1024, options.signal)) !== archive.sha256.toLowerCase())
        throw new AdapterError('Host archive checksum does not match the approved distribution');
      const extracted = join(directory, 'extracted');
      await extractZip(path, extracted, {
        maxTotalBytes: 2 * 1024 ** 3,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for (const entry of archive.executables) {
        const executable = join(extracted, entry);
        if (!(await lstat(executable)).isFile())
          throw new AdapterError('Approved host archive lacks an expected regular executable');
        await chmod(executable, 0o500);
      }
      await writeFile(
        join(extracted, 'pxv-tool-provenance.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            id: archive.id,
            url: archive.url,
            sha256: archive.sha256.toLowerCase(),
            licenseId: archive.licenseId,
            acceptedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { flag: 'wx', mode: 0o400 },
      );
      // The destination must be new; a concurrent installation is never replaced.
      await mkdir(destination, { mode: 0o700 });
      try {
        await rename(extracted, join(destination, 'distribution'));
      } catch (error) {
        await rm(destination, { recursive: true, force: true });
        throw error;
      }
      return join(destination, 'distribution');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
