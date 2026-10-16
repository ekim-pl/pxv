import { configuredAdbServer, HostTools, probeAdbServer, type HostToolArchive } from '@pxv/adapters';
import { parseDocument } from '@pxv/contracts';
import { CommandRunner, readBounded, supervisorPath } from '@pxv/runtime';

export interface ToolStatus {
  tool: string;
  available: boolean;
  compatible: boolean;
  version?: string;
}
export async function inspectHost(runner = new CommandRunner()): Promise<{
  platform: string;
  architecture: string;
  node: string;
  supported: boolean;
  tools: ToolStatus[];
  adbServer: boolean;
  supervisor: boolean;
}> {
  const tools = await new HostTools({ runner }).doctor();
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    supported: process.platform === 'linux' && process.arch === 'x64' && process.versions.node === '24.22.0',
    tools,
    adbServer: await probeAdbServer(configuredAdbServer()).then(
      () => true,
      () => false,
    ),
    supervisor: await supervisorPath()
      .then(async (path) => {
        const result = await runner.run([path, '--version'], { timeoutMs: 5000, check: false });
        return result.code === 0 && result.stdout.trim() === 'pxv-supervisor 0.1.0';
      })
      .catch(() => false),
  };
}

/** Explicit checksum-pinned bootstrap; never called by package installation or doctor. */
export async function bootstrapTool(
  file: string,
  acceptedLicense: string,
  destination: string,
  runner = new CommandRunner(),
): Promise<string> {
  const value = parseDocument((await readBounded(file, 64 * 1024)).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an approved tool archive descriptor');
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some((key) => !['id', 'url', 'sha256', 'executables', 'licenseId'].includes(key)) ||
    !['id', 'url', 'sha256', 'licenseId'].every((key) => typeof fields[key] === 'string') ||
    !Array.isArray(fields['executables']) ||
    !fields['executables'].every((item) => typeof item === 'string')
  )
    throw new Error('Invalid approved tool archive descriptor');
  return new HostTools({ runner }).bootstrap(fields as unknown as HostToolArchive, destination, {
    acceptedLicense,
  });
}
