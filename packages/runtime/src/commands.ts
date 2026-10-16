import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readBounded } from './files.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string | Uint8Array;
  inputFile?: string;
  env?: Record<string, string>;
  cwd?: string;
  mutation?: boolean;
  lease?: object;
  check?: boolean;
  /** Declared normal process exit codes. Signals and interrupted cleanup never qualify. */
  expectedExitCodes?: readonly number[];
}
export interface Runtime {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}
export class CommandError extends Error {
  readonly result: CommandResult;
  constructor(result: CommandResult) {
    super(`Command failed with exit code ${result.code}`);
    this.name = 'CommandError';
    this.result = result;
  }
}
export class RecoveryRequiredError extends Error {
  constructor(message = 'Device has unresolved recovery obligations') {
    super(message);
    this.name = 'RecoveryRequiredError';
  }
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;

function validate(args: string[], options: CommandOptions): void {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !args[0]
  )
    throw new Error('Command requires a nonempty argument vector');
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 86_400_000)
  )
    throw new Error('Invalid command timeout');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Command aborted');
  if (options.expectedExitCodes !== undefined && !validExpectedExitCodes(options.expectedExitCodes))
    throw new Error('Invalid expected exit codes');
  if (options.input !== undefined && options.inputFile !== undefined)
    throw new Error('input and inputFile are mutually exclusive');
  if (options.input !== undefined && Buffer.byteLength(options.input) > OUTPUT_LIMIT)
    throw new Error('Command input exceeds IPC limit; use inputFile');
}

function validExpectedExitCodes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)
  );
}

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

function environment(explicit?: Record<string, string>): Record<string, string> {
  if (explicit) return { ...explicit };
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function runInspection(args: string[], options: CommandOptions): Promise<CommandResult> {
  const source = options.inputFile
    ? await open(options.inputFile, constants.O_RDONLY | constants.O_NOFOLLOW)
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
      let total = 0;
      let interrupted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
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
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin?.end(options.input);
      const timer = setTimeout(kill, options.timeoutMs ?? 120_000);
      options.signal?.addEventListener('abort', kill, { once: true });
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
        resolveResult({ code: interrupted ? 124 : (code ?? 128), stdout, stderr });
      });
    });
  } finally {
    await source?.close();
  }
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
    this.#failure = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
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
  readonly deviceKey: string;
  readonly transportKey: string;
  readonly operationId: string;
  readonly #session: NativeSession;
  #active = true;
  #running = false;
  constructor(session: NativeSession, deviceKey: string, transportKey: string, operationId: string) {
    this.#session = session;
    this.deviceKey = deviceKey;
    this.transportKey = transportKey;
    this.operationId = operationId;
  }
  async run(args: string[], options: CommandOptions): Promise<CommandResult> {
    if (!this.#active || this.#running)
      throw new Error('Device lease is closed or already executing a command');
    validate(args, options);
    this.#running = true;
    const id = randomUUID();
    const cancel = (): void => {
      this.#session.send({ type: 'cancel', id });
    };
    try {
      this.#session.send({
        type: 'run',
        id,
        args,
        env: environment(options.env),
        cwd: options.cwd ?? null,
        input: options.input === undefined ? null : Buffer.from(options.input).toString('base64'),
        input_file: options.inputFile ?? null,
        timeout_ms: options.timeoutMs ?? 120_000,
        ...(options.expectedExitCodes !== undefined
          ? { expected_exit_codes: options.expectedExitCodes }
          : {}),
      });
      await this.#session.wait('gated', id);
      if (options.signal?.aborted) {
        this.#session.disconnect();
        throw options.signal.reason ?? new Error('Command aborted before authorization');
      }
      this.#session.send({ type: 'authorize', id });
      options.signal?.addEventListener('abort', cancel, { once: true });
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
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../native/supervisor/target/x86_64-unknown-linux-musl/release/pxv-supervisor',
        ),
        resolve(dirname(process.execPath), 'pxv-supervisor'),
        resolve(dirname(fileURLToPath(import.meta.url)), '../native/pxv-supervisor'),
      ];
  for (const path of candidates) {
    if (!path) continue;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'EACCES'
      )
        throw error;
    }
  }
  throw new Error('Linux native supervisor is required for mutations; build native/supervisor first');
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
  const child = spawn(await supervisorPath(), ['--control-root', resolve(controlRoot)], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    detached: true,
    env: { PATH: '/usr/bin:/bin' },
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
    throw error;
  });
  const lease = new DeviceLease(session, deviceKey, transportKey, operationId);
  try {
    const value = await fn(lease);
    await lease.finish(true);
    return value;
  } catch (error) {
    await lease.finish(false).catch(() => undefined);
    throw error;
  }
}

export interface RecoveryReservation {
  schema: number;
  operation_id: string;
  previous_operation_id?: string | null;
  device_key: string;
  transport_key: string;
  supervisor: { pid: number; start_ticks: string; boot_id: string; uid: number };
  status: string;
  cleanup_proven?: boolean;
  mutation_started?: boolean;
}

export interface ProcessIdentity {
  pid: number;
  start_ticks: string;
  boot_id: string;
  uid: number;
}
export interface NativeReceipt {
  id: string;
  operationId: string;
  commandId: string;
  status: 'gated' | 'authorized' | 'running' | 'completed';
  supervisor: ProcessIdentity;
  child?: ProcessIdentity;
  code?: number;
  cleanupProven?: boolean;
  interrupted?: boolean;
  expectedExitCodes?: number[];
}

/** Bounded redacted native evidence. Only completed receipts are immutable and
 * should be passed to SqliteStore.ingestReceipt for idempotent reconciliation. */
export async function nativeReceipts(controlRoot: string, operationId: string): Promise<NativeReceipt[]> {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(operationId)) throw new Error('Invalid native operation identity');
  const directory = join(controlRoot, 'receipts');
  const files = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const output: NativeReceipt[] = [];
  const validIdentity = (value: unknown): value is ProcessIdentity => {
    if (!value || typeof value !== 'object') return false;
    const identity = value as ProcessIdentity;
    return (
      Number.isInteger(identity.pid) &&
      identity.pid > 0 &&
      Number.isInteger(identity.uid) &&
      identity.uid >= 0 &&
      typeof identity.start_ticks === 'string' &&
      /^[0-9]+$/u.test(identity.start_ticks) &&
      typeof identity.boot_id === 'string' &&
      identity.boot_id.length > 0
    );
  };
  for (const file of files.sort()) {
    if (!file.startsWith(`${operationId}-`) || !file.endsWith('.json')) continue;
    const commandId = file.slice(operationId.length + 1, -5);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(commandId)) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse((await readBounded(join(directory, file), 64 * 1024)).toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new RecoveryRequiredError(`Malformed native receipt retained: ${file}`);
    }
    const allowed = new Set([
      'schema',
      'operation_id',
      'command_id',
      'supervisor',
      'status',
      'child',
      'code',
      'cleanup_proven',
      'interrupted',
      'expected_exit_codes',
    ]);
    if (
      !value ||
      value['schema'] !== 1 ||
      value['operation_id'] !== operationId ||
      value['command_id'] !== commandId ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      !validIdentity(value['supervisor']) ||
      !['gated', 'authorized', 'running', 'completed'].includes(String(value['status'])) ||
      (value['child'] !== undefined && !validIdentity(value['child'])) ||
      (value['expected_exit_codes'] !== undefined && !validExpectedExitCodes(value['expected_exit_codes']))
    )
      throw new RecoveryRequiredError(`Malformed native receipt retained: ${file}`);
    if (
      value['status'] === 'completed' &&
      (!Number.isInteger(value['code']) ||
        typeof value['cleanup_proven'] !== 'boolean' ||
        typeof value['interrupted'] !== 'boolean')
    )
      throw new RecoveryRequiredError(`Malformed native completion retained: ${file}`);
    output.push({
      id: `${operationId}:${commandId}`,
      operationId,
      commandId,
      status: value['status'] as NativeReceipt['status'],
      supervisor: value['supervisor'],
      ...(value['child'] !== undefined ? { child: value['child'] } : {}),
      ...(value['code'] !== undefined ? { code: value['code'] as number } : {}),
      ...(value['cleanup_proven'] !== undefined ? { cleanupProven: value['cleanup_proven'] as boolean } : {}),
      ...(value['interrupted'] !== undefined ? { interrupted: value['interrupted'] as boolean } : {}),
      ...(value['expected_exit_codes'] !== undefined
        ? { expectedExitCodes: value['expected_exit_codes'] }
        : {}),
    });
  }
  return output;
}

/** Inspection never creates the shared control directory. Malformed evidence blocks. */
export async function recoveryReservations(controlRoot: string): Promise<RecoveryReservation[]> {
  const directory = join(controlRoot, 'reservations');
  const names = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const seen = new Set<string>();
  const records: RecoveryReservation[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    let record: RecoveryReservation;
    try {
      record = JSON.parse(
        (await readBounded(join(directory, name), 64 * 1024)).toString('utf8'),
      ) as RecoveryReservation;
    } catch {
      throw new RecoveryRequiredError(`Malformed recovery evidence retained: ${name}`);
    }
    if (
      record.schema !== 1 ||
      typeof record.operation_id !== 'string' ||
      typeof record.device_key !== 'string' ||
      typeof record.transport_key !== 'string' ||
      !record.supervisor ||
      typeof record.supervisor.boot_id !== 'string'
    )
      throw new RecoveryRequiredError(`Malformed recovery evidence retained: ${name}`);
    if (!seen.has(record.operation_id)) {
      seen.add(record.operation_id);
      records.push(record);
    }
  }
  return records;
}

/** Resolve only after verified process cleanup or a host reboot, plus an explicit
 * application-level acknowledgment that device recovery has been completed. */
export async function resolveRecoveryReservation(
  controlRoot: string,
  deviceKey: string,
  transportKey: string,
  operationId: string,
  options: { deviceRecoveryAcknowledged: true },
): Promise<void> {
  if (options.deviceRecoveryAcknowledged !== true)
    throw new RecoveryRequiredError('Explicit device recovery acknowledgment is required');
  const keys = deviceLeaseKeys(deviceKey, transportKey);
  const child = spawn(await supervisorPath(), ['--control-root', resolve(controlRoot)], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    detached: true,
    env: { PATH: '/usr/bin:/bin' },
  });
  const ipc = child.stdio[3] as Duplex | null;
  if (!ipc) {
    child.kill();
    throw new Error('Private native IPC unavailable');
  }
  const session = new NativeSession(child, ipc);
  try {
    session.send({
      type: 'recover',
      device_key: keys.device,
      transport_key: keys.transport,
      operation_id: operationId,
      device_recovery_acknowledged: true,
    });
    await session.wait('recovered');
  } finally {
    session.disconnect();
    await session.closed;
  }
}
