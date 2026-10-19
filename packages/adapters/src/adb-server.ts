import { createConnection } from 'node:net';
import { AdapterError, checked, type CommandRunner } from './command.js';

export interface AdbServerEndpoint {
  host: string;
  port: number;
  socketPath?: string;
}
export function configuredAdbServer(env: NodeJS.ProcessEnv = process.env): AdbServerEndpoint {
  const host = env['PXV_HOST_ADB_HOST'] ?? '127.0.0.1';
  const port = Number(env['PXV_HOST_ADB_PORT'] ?? '5037');
  const socket = env['PXV_ADB_SERVER_SOCKET'];
  return socket ? socketEndpoint(socket, host, port) : validateAdbServer({ host, port });
}
function socketEndpoint(socket: string, host: string, port: number): AdbServerEndpoint {
  if (socket.startsWith('localfilesystem:')) return { host, port, socketPath: socket.slice(16) };
  if (socket.startsWith('localabstract:')) return { host, port, socketPath: `\0${socket.slice(14)}` };
  if (socket.startsWith('tcp:')) {
    const address = socket.slice(4);
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(address);
    if (match) return validateAdbServer({ host: match[1] ?? match[2] ?? '', port: Number(match[3]) });
    if (/^\d+$/.test(address)) return validateAdbServer({ host, port: Number(address) });
    throw new AdapterError('Invalid configured ADB server socket');
  }
  throw new AdapterError('Unsupported configured ADB server socket');
}
export function validateAdbServer(endpoint: AdbServerEndpoint): AdbServerEndpoint {
  if (
    !endpoint.host ||
    /[\s\0]/.test(endpoint.host) ||
    !Number.isSafeInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535 ||
    endpoint.socketPath === ''
  )
    throw new AdapterError('Invalid configured ADB server endpoint');
  return endpoint;
}
/** Speak the ADB host protocol before clients; no guarded client may start a server. */
export async function probeAdbServer(endpoint: AdbServerEndpoint, signal?: AbortSignal): Promise<void> {
  validateAdbServer(endpoint);
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = endpoint.socketPath
      ? createConnection({ path: endpoint.socketPath })
      : createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const unavailable = (): AdapterError =>
      new AdapterError(
        'ADB server is unavailable; establish the configured server outside the device operation and inspect before retrying',
        'ADB_SERVER_UNAVAILABLE',
      );
    const abort = (): void => finish(new AdapterError('ADB server check was cancelled', 'CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(1000, () => finish(unavailable()));
    socket.once('error', () => finish(unavailable()));
    socket.once('end', () => {
      if (!settled) finish(unavailable());
    });
    socket.once('connect', () => socket.write('000chost:version'));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 32 || (buffer.length >= 4 && buffer.subarray(0, 4).toString() !== 'OKAY')) {
        finish(unavailable());
        return;
      }
      if (buffer.length >= 8) {
        const length = buffer.subarray(4, 8).toString();
        if (!/^[a-fA-F0-9]{4}$/.test(length) || Number.parseInt(length, 16) !== 4) {
          finish(unavailable());
          return;
        }
        if (buffer.length >= 12)
          finish(/^[a-fA-F0-9]{4}$/.test(buffer.subarray(8, 12).toString()) ? undefined : unavailable());
      }
    });
  });
}
export function adbClientEnvironment(endpoint: AdbServerEndpoint): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    ANDROID_ADB_SERVER_ADDRESS: endpoint.host,
    ANDROID_ADB_SERVER_PORT: String(endpoint.port),
    LC_ALL: 'C',
  };
  if (process.env['HOME']) env['HOME'] = process.env['HOME'];
  if (process.env['PXV_ADB_VENDOR_KEYS']) env['ADB_VENDOR_KEYS'] = process.env['PXV_ADB_VENDOR_KEYS'];
  if (endpoint.socketPath)
    env['ADB_SERVER_SOCKET'] = endpoint.socketPath.startsWith('\0')
      ? `localabstract:${endpoint.socketPath.slice(1)}`
      : `localfilesystem:${endpoint.socketPath}`;
  return env;
}
/** Explicit host preparation only. Call before acquiring any device lease. */
export async function startLocalAdbServer(
  runner: CommandRunner,
  adb: string,
  endpoint: AdbServerEndpoint,
): Promise<void> {
  validateAdbServer(endpoint);
  if (!['127.0.0.1', 'localhost', '::1'].includes(endpoint.host) || endpoint.socketPath)
    throw new AdapterError('Remote and Unix ADB servers must be started by their owner');
  const env = adbClientEnvironment(endpoint);
  delete env['ANDROID_ADB_SERVER_ADDRESS'];
  checked(
    await runner.run([adb, '-L', `tcp:${endpoint.port}`, 'start-server'], { env, timeoutMs: 30_000 }),
    'Explicit local ADB server startup',
  );
  await probeAdbServer(endpoint);
}
