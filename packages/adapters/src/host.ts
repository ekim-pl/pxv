import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { AdapterError, sha256Pin, type CommandRunner, type CommandResult } from './command.js';
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
      return inspectedStatus(tool, path, result);
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
    validateArchive(archive, options.acceptedLicense);
    await requireNewDestination(destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(dirname(destination), '.pxv-tool-bootstrap-'));
    try {
      const extracted = await extractApprovedTool(archive, directory, options.signal);
      await markExecutables(extracted, archive.executables);
      await writeToolProvenance(extracted, archive);
      return await installDistribution(extracted, destination);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

const VERSION_PATTERNS: Record<Exclude<HostTool, 'ssh-keygen'>, { pattern: RegExp; minimum?: number[] }> = {
  adb: { pattern: /(?:^|\n)Version (\d+\.\d+\.\d+)/, minimum: [35, 0, 2] },
  fastboot: { pattern: /(?:fastboot version|Version) (\d+\.\d+\.\d+)/, minimum: [35, 0, 2] },
  java: { pattern: /(?:openjdk|java) version "(\d+(?:\.\d+)*)/, minimum: [17] },
  aapt: { pattern: /Android Asset Packaging Tool, (v[^\s]+|[^\s]+)/ },
  apksigner: { pattern: /^\s*(\d+(?:\.\d+)+)/ },
};
function toolVersion(tool: HostTool, result: CommandResult): { version?: string; compatible: boolean } {
  const output = result.stdout + '\n' + result.stderr;
  if (tool === 'ssh-keygen')
    return {
      version: 'OpenSSH signature tool',
      compatible: output.includes('ssh-keygen') && output.includes('-Y') && output.includes('verify'),
    };
  const spec = VERSION_PATTERNS[tool];
  const version = spec.pattern.exec(output)?.[1];
  const compatible =
    result.code === 0 && !!version && (!spec.minimum || versionAtLeast(version, spec.minimum));
  return { ...(version ? { version } : {}), compatible };
}
function inspectedStatus(tool: HostTool, path: string, result: CommandResult): HostToolStatus {
  const version = toolVersion(tool, result);
  return {
    tool,
    path,
    available: true,
    ...version,
    ...(!version.compatible
      ? { reason: 'The installed executable did not report a supported version or required capability' }
      : {}),
  };
}
function validateArchive(archive: HostToolArchive, acceptedLicense: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(archive.id) || archive.licenseId !== acceptedLicense || !archive.licenseId)
    throw new AdapterError('Tool bootstrap requires the exact reviewed license acceptance');
  sha256Pin(archive.sha256);
  validateGoogleArchiveUrl(archive.url);
  if (!archive.executables.length)
    throw new AdapterError('Approved host archive must identify its executables');
  archive.executables.forEach(validateExecutablePath);
}
function validateExecutablePath(entry: string): void {
  if (
    isAbsolute(entry) ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(entry) ||
    entry.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AdapterError('Unsafe host tool executable path');
}
async function requireNewDestination(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new AdapterError('Managed tool destination already exists; preserve it for explicit replacement');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
async function extractApprovedTool(
  archive: HostToolArchive,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = join(directory, 'tool.zip');
  await download(path, archive.url, {
    limit: 512 * 1024 * 1024,
    timeoutMs: 600_000,
    ...(signal ? { signal } : {}),
  });
  if ((await fileDigest(path, 512 * 1024 * 1024, signal)) !== archive.sha256.toLowerCase())
    throw new AdapterError('Host archive checksum does not match the approved distribution');
  const extracted = join(directory, 'extracted');
  await extractZip(path, extracted, { maxTotalBytes: 2 * 1024 ** 3, ...(signal ? { signal } : {}) });
  return extracted;
}
async function markExecutables(directory: string, paths: string[]): Promise<void> {
  for (const entry of paths) {
    const executable = join(directory, entry);
    if (!(await lstat(executable)).isFile())
      throw new AdapterError('Approved host archive lacks an expected regular executable');
    await chmod(executable, 0o500);
  }
}
async function writeToolProvenance(directory: string, archive: HostToolArchive): Promise<void> {
  await writeFile(
    join(directory, 'pxv-tool-provenance.json'),
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
}
async function installDistribution(extracted: string, destination: string): Promise<string> {
  await mkdir(destination, { mode: 0o700 });
  try {
    await rename(extracted, join(destination, 'distribution'));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return join(destination, 'distribution');
}

function validateGoogleArchiveUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'dl.google.com' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    throw new AdapterError('Android host archives require the official Google HTTPS distribution host');
}
