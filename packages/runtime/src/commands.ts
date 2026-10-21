import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  CommandError,
  RecoveryRequiredError,
  validateCommand as validate,
  commandEnvironment as environment,
  nativeCommand,
  type CommandResult,
  type CommandOptions,
  type Runtime,
} from './command-contracts.js';
export type { CommandResult, CommandOptions, Runtime } from './command-contracts.js';
const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Mutations can only cross the native gated gateway with a live device lease. */
export class CommandRunner implements Runtime {
  async run(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    validate(args, options);
    let result: CommandResult;
    if (options.mutation) {
      if (!(options.lease instanceof DeviceLease))
        throw new Error('Device mutation requires a native DeviceLease');
      result = await options.lease.run(args, options);
    } else {
      result = await runInspection(args, options);
    }
    if (!(options.expectedExitCodes ?? [0]).includes(result.code) && options.check !== false)
      throw new CommandError(result);
    return result;
  }
}

async function runInspection(args: string[], options: CommandOptions): Promise<CommandResult> {
  const source = options.inputFile
    ? await open(options.inputFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    : undefined;
  if (source && !(await source.stat()).isFile()) {
    await source.close();
    throw new Error('Command input must be a regular file');
  }
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn(args[0]!, args.slice(1), {
        cwd: options.cwd,
        env: environment(options.env),
        detached: process.platform === 'linux',
        stdio: [source?.fd ?? 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8'),
        stderrDecoder = new StringDecoder('utf8');
      let total = 0;
      let interrupted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
        if (interrupted) return;
        interrupted = true;
        const terminate = (signal: NodeJS.Signals): void => {
          try {
            if (child.pid && process.platform === 'linux') process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        terminate('SIGTERM');
        killTimer = setTimeout(() => terminate('SIGKILL'), 100);
        killTimer.unref();
      };
      const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        total += chunk.length;
        if (total > OUTPUT_LIMIT) {
          kill();
          return;
        }
        if (target === 'stdout') stdout += stdoutDecoder.write(chunk);
        else stderr += stderrDecoder.write(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin?.end(options.input);
      const timer = setTimeout(kill, options.timeoutMs ?? 120_000);
      observeAbort(options.signal, kill);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', kill);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        cleanup();
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolveResult({ code: interrupted ? 124 : (code ?? 128), stdout, stderr });
      });
    });
  } finally {
    await source?.close();
  }
}

/** Opening input files yields; cancellation may precede listener registration. */
function observeAbort(signal: AbortSignal | undefined, cancel: () => void): void {
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
}

interface NativeReply {
  type: string;
  id?: string;
  message?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  cleanup_proven?: boolean;
  interrupted?: boolean;
  success?: boolean;
}
interface Waiter {
  matches(reply: NativeReply): boolean;
  resolve(reply: NativeReply): void;
  reject(error: Error): void;
}

class NativeSession {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly #ipc: Duplex;
  readonly #waiters = new Set<Waiter>();
  #failure: Error | undefined;
  #buffered: NativeReply[] = [];
  constructor(child: ChildProcess, ipc: Duplex) {
    this.child = child;
    this.closed = new Promise((resolveClosed) => {
      child.once('close', () => resolveClosed());
    });
    this.#ipc = ipc;
    const lines = createInterface({ input: ipc, crlfDelay: Infinity });
    lines.on('error', (error) => this.#fail(error));
    lines.on('line', (line) => {
      try {
        if (line.length > 32 * 1024 * 1024) throw new Error('Supervisor response exceeded limit');
        const reply = JSON.parse(line) as NativeReply;
        if (!['ready', 'gated', 'result', 'finished', 'recovered', 'error'].includes(reply.type))
          throw new Error('Invalid supervisor response type');
        if (reply.type === 'error') {
          this.#fail(new RecoveryRequiredError(reply.message ?? 'Native ownership failed'));
          return;
        }
        const pending = [...this.#waiters].find((item) => item.matches(reply));
        if (pending) {
          this.#waiters.delete(pending);
          pending.resolve(reply);
        } else {
          if (this.#buffered.length >= 4) throw new Error('Unexpected supervisor response backlog');
          this.#buffered.push(reply);
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error('Invalid supervisor response'));
      }
    });
    ipc.on('error', (error) => this.#fail(error));
    child.on('error', (error) => this.#fail(error));
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 4096) diagnostics += chunk.toString('utf8');
    });
    child.on('close', (code) =>
      this.#fail(
        new RecoveryRequiredError(
          `Native supervisor exited (${code ?? 'signal'})${diagnostics ? `: ${diagnostics.trim()}` : ''}`,
        ),
      ),
    );
  }
  #fail(error: Error): void {
    if (
      this.#failure &&
      !['ECONNRESET', 'EPIPE'].includes((this.#failure as NodeJS.ErrnoException).code ?? '')
    )
      return;
    this.#failure = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
  get failure(): Error | undefined {
    return this.#failure;
  }
  send(message: Record<string, unknown>): void {
    if (this.#failure) throw this.#failure;
    this.#ipc.write(`${JSON.stringify(message)}\n`);
  }
  wait(type: string, id?: string): Promise<NativeReply> {
    const matches = (reply: NativeReply): boolean =>
      reply.type === type && (id === undefined || reply.id === id);
    const index = this.#buffered.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.#buffered.splice(index, 1)[0]!);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolveReply, reject) =>
      this.#waiters.add({ matches, resolve: resolveReply, reject }),
    );
  }
  disconnect(): void {
    this.#ipc.end();
  }
}

/** A live native capability. A plain object cannot authorize a mutation. */
export class DeviceLease {
  readonly operationId: string;
  readonly #session: NativeSession;
  #active = true;
  #running = false;
  constructor(session: NativeSession, operationId: string) {
    this.#session = session;
    this.operationId = operationId;
  }
  async run(args: string[], options: CommandOptions): Promise<CommandResult> {
    if (!this.#active || this.#running)
      throw new Error('Device lease is closed or already executing a command');
    validate(args, options);
    this.#running = true;
    const id = randomUUID();
    const cancel = (): void => {
      if (!this.#session.failure) this.#session.send({ type: 'cancel', id });
    };
    try {
      this.#session.send(nativeCommand(id, args, options));
      await this.authorize(id, options);
      observeAbort(options.signal, cancel);
      const reply = await this.#session.wait('result', id);
      if (!reply.cleanup_proven)
        throw new RecoveryRequiredError('Native command cleanup could not be proven');
      if (
        typeof reply.code !== 'number' ||
        typeof reply.stdout !== 'string' ||
        typeof reply.stderr !== 'string'
      )
        throw new Error('Invalid native completion receipt');
      return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr };
    } finally {
      this.#running = false;
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  private async authorize(id: string, options: CommandOptions): Promise<void> {
    await this.#session.wait('gated', id);
    if (options.signal?.aborted) {
      this.#session.disconnect();
      options.signal.throwIfAborted();
    }
    this.#session.send({ type: 'authorize', id });
  }
  async finish(success: boolean): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    try {
      this.#session.send({ type: 'finish', success });
      const reply = await this.#session.wait('finished');
      if (success && (!reply.success || !reply.cleanup_proven))
        throw new RecoveryRequiredError('Operation did not complete safely; device remains fenced');
    } finally {
      this.#session.disconnect();
      await this.#session.closed;
    }
  }
}

export function hostControlRoot(): string {
  return (
    process.env['PXV_CONTROL_ROOT'] ??
    join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'pxv-host-control')
  );
}

export function deviceLeaseKeys(
  deviceKey: string,
  transportKey: string,
): { device: string; transport: string } {
  if (!deviceKey || !transportKey) throw new Error('Canonical device and transport identities are required');
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
  return {
    device: hash(`pxv-device-v1\0${deviceKey}`),
    transport: hash(`pxv-transport-v1\0${transportKey}`),
  };
}

export async function supervisorPath(): Promise<string> {
  const candidates = process.env['PXV_SUPERVISOR']
    ? [process.env['PXV_SUPERVISOR']]
    : [
        resolve(dirname(fileURLToPath(import.meta.url)), 'supervisor.js'),
        resolve(dirname(fileURLToPath(import.meta.url)), '../dist/supervisor.js'),
      ];
  for (const path of candidates) {
    if (!path) continue;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await access(path, constants.R_OK);
      return path;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'EACCES'
      )
        throw error;
    }
  }
  throw new Error('Linux native supervisor is required for mutations; run pnpm build first');
}

export async function withDeviceLease<T>(
  controlRoot: string,
  deviceKey: string,
  transportKey: string,
  operationId: string,
  fn: (lease: DeviceLease) => Promise<T>,
): Promise<T> {
  return acquireLease(controlRoot, deviceKey, transportKey, operationId, fn);
}

/** Continue explicit, typed recovery while the old reservation remains fenced.
 * A failed recovery retains that fence even when no new command was started. */
export async function withRecoveryLease<T>(
  controlRoot: string,
  deviceKey: string,
  transportKey: string,
  previousOperationId: string,
  fn: (lease: DeviceLease) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(previousOperationId))
    throw new Error('Invalid previous operation identity');
  return acquireLease(
    controlRoot,
    deviceKey,
    transportKey,
    `recovery-${randomUUID()}`,
    fn,
    previousOperationId,
  );
}

async function acquireLease<T>(
  controlRoot: string,
  deviceKey: string,
  transportKey: string,
  operationId: string,
  fn: (lease: DeviceLease) => Promise<T>,
  previousOperationId?: string,
): Promise<T> {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Device mutation requires Linux x86_64 native ownership');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(operationId)) throw new Error('Invalid operation identity');
  const keys = deviceLeaseKeys(deviceKey, transportKey);
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [await supervisorPath(), '--control-root', resolve(controlRoot)], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      PATH: '/usr/bin:/bin',
      ...(process.env['NODE_V8_COVERAGE'] ? { NODE_V8_COVERAGE: process.env['NODE_V8_COVERAGE'] } : {}),
    },
  });
  const ipc = child.stdio[3] as Duplex | null;
  if (!ipc) {
    child.kill();
    throw new Error('Private native IPC unavailable');
  }
  const session = new NativeSession(child, ipc);
  session.send({
    type: previousOperationId ? 'acquire_recovery' : 'acquire',
    device_key: keys.device,
    transport_key: keys.transport,
    operation_id: operationId,
    ...(previousOperationId ? { previous_operation_id: previousOperationId } : {}),
  });
  await session.wait('ready').catch(async (error: unknown) => {
    session.disconnect();
    await session.closed;
    throw session.failure ?? error;
  });
  const lease = new DeviceLease(session, operationId);
  try {
    const value = await fn(lease);
    await lease.finish(true);
    return value;
  } catch (error) {
    await lease.finish(false).catch(() => undefined);
    throw error;
  }
}

export { nativeReceipts, recoveryReservations } from './native-evidence.js';
