import { performance } from 'node:perf_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import type { Kernel } from './supervisor-native.js';
import { children, identity, reapAdopted, terminateDescendants } from './supervisor-process.js';
import { type Channel, validExitCodes, type Message } from './supervisor-protocol.js';
import { durable, exists, type Lease, safeId } from './supervisor-storage.js';
interface Spec {
  id: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  input?: string;
  input_file?: string;
  timeout_ms: number;
  expected_exit_codes: number[];
}
function specOf(message: Message, lease: Lease): Spec {
  const s = { ...message, expected_exit_codes: message['expected_exit_codes'] ?? [0] } as unknown as Spec;
  validateArguments(s);
  if (!Number.isSafeInteger(s.timeout_ms) || s.timeout_ms <= 0 || s.timeout_ms > 86400000)
    throw new Error('Invalid native command timeout');
  if (!validExitCodes(s.expected_exit_codes)) throw new Error('Invalid expected exit codes');
  if (exists(lease.receiptPath(s.id))) throw new Error('Native command ID was already used; refusing replay');
  validateEnvironment(s.env);
  validateInput(s);
  return s;
}
function capture(stream: Readable): { output: () => string; overflow: () => boolean; closed: Promise<void> } {
  const chunks: Buffer[] = [];
  let size = 0,
    overflow = false;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    else overflow = true;
  });
  const closed = new Promise<void>((done) => {
    stream.on('end', done);
    stream.on('error', () => {
      overflow = true;
      done();
    });
  });
  return {
    output: () => (overflow ? '' : Buffer.concat(chunks).toString('utf8')),
    overflow: () => overflow,
    closed,
  };
}
function inputSource(spec: Spec, kernel: Kernel): number | undefined {
  if (spec.input_file == null) return undefined;
  const fd = openSync(spec.input_file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Command input must be a regular file');
    kernel.closeOnExec(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function launch(
  spec: Spec,
  fd: number | undefined,
  receipt: Record<string, unknown>,
  lease: Lease,
  direct: Set<number>,
): ChildProcess {
  const child = spawn(spec.args[0]!, spec.args.slice(1), {
    env: spec.env,
    ...(spec.cwd == null ? {} : { cwd: spec.cwd }),
    detached: true,
    stdio: [fd ?? 'pipe', 'pipe', 'pipe'],
  });
  // Capture synchronously before libuv can reap a fast direct child.
  if (child.pid === undefined) {
    child.on('error', () => undefined);
    throw new Error('Command could not be spawned');
  }
  direct.add(child.pid);
  child.on('error', () => undefined);
  receipt['child'] = identity(child.pid);
  receipt['status'] = 'running';
  durable(lease.receiptPath(spec.id), receipt);
  return child;
}
async function wait(child: ChildProcess, spec: Spec, channel: Channel, kernel: Kernel, direct: Set<number>) {
  let exited = false,
    exit: number | null = null,
    interrupted = false,
    ownerLost = false,
    clean = true;
  child.once('exit', (code) => {
    exited = true;
    exit = code;
  });
  const deadline = performance.now() + spec.timeout_ms;
  for (;;) {
    reapAdopted(kernel, direct);
    if (exited && !children(process.pid).length) break;
    if (performance.now() >= deadline) interrupted = true;
    else {
      try {
        const message = channel.poll();
        if (message) {
          interrupted = true;
          ownerLost = message.type !== 'cancel' || message['id'] !== spec.id;
        }
      } catch {
        interrupted = true;
        ownerLost = true;
      }
    }
    if (interrupted) {
      clean = await terminateDescendants(kernel, direct);
      break;
    }
    await delay(5);
  }
  return { exit, interrupted, ownerLost, clean };
}
export async function runCommand(
  lease: Lease,
  channel: Channel,
  message: Message,
  kernel: Kernel,
  direct: Set<number>,
): Promise<void> {
  const spec = specOf(message, lease),
    source = inputSource(spec, kernel);
  try {
    const receipt: Record<string, unknown> = {
      schema: 1,
      operation_id: lease.operation,
      command_id: spec.id,
      supervisor: lease.supervisor,
      status: 'gated',
      expected_exit_codes: spec.expected_exit_codes,
    };
    durable(lease.receiptPath(spec.id), receipt);
    await channel.send({ type: 'gated', id: spec.id });
    const auth = await channel.receive();
    if (auth.type !== 'authorize' || auth['id'] !== spec.id)
      throw new Error('Owner did not authorize native execution');
    lease.mutated = true;
    receipt['status'] = 'authorized';
    durable(lease.receiptPath(spec.id), receipt);
    const child = launch(spec, source, receipt, lease, direct);
    const output = capture(child.stdout!),
      errors = capture(child.stderr!);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.input == null ? undefined : Buffer.from(spec.input, 'base64'));
    const state = await wait(child, spec, channel, kernel, direct);
    await complete(lease, channel, spec, receipt, state, output, errors);
  } finally {
    if (source !== undefined) closeSync(source);
  }
}

function validateEnvironment(env: Record<string, string>): void {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid command environment');
  if (
    Object.entries(env).some(([k, v]) => !k || /[=\0]/u.test(k) || typeof v !== 'string' || v.includes('\0'))
  )
    throw new Error('Invalid command environment');
}
function validateInput(s: Spec): void {
  for (const value of [s.cwd, s.input, s.input_file])
    if (value != null && typeof value !== 'string') throw new Error('Invalid command input');
  if (s.input != null && s.input_file != null) throw new Error('input and input_file are mutually exclusive');
  if (s.input != null && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(s.input))
    throw new Error('Invalid input encoding');
}

async function complete(
  lease: Lease,
  channel: Channel,
  spec: Spec,
  receipt: Record<string, unknown>,
  state: Awaited<ReturnType<typeof wait>>,
  output: ReturnType<typeof capture>,
  errors: ReturnType<typeof capture>,
): Promise<void> {
  if (state.clean) await Promise.all([output.closed, errors.closed]);
  if (output.overflow() || errors.overflow()) state.interrupted = true;
  const code = state.interrupted ? 124 : (state.exit ?? 128);
  if (uncertain(state, spec, code)) lease.uncertain = true;
  Object.assign(receipt, {
    status: 'completed',
    code,
    cleanup_proven: state.clean,
    interrupted: state.interrupted,
  });
  durable(lease.receiptPath(spec.id), receipt);
  if (state.ownerLost) throw new Error('Owner disconnected; device remains fenced');
  await channel.send({
    type: 'result',
    id: spec.id,
    code,
    stdout: output.output(),
    stderr: errors.output(),
    cleanup_proven: state.clean,
    interrupted: state.interrupted,
  });
}

function validateArguments(s: Spec): void {
  if (
    !safeId(s.id) ||
    !Array.isArray(s.args) ||
    !s.args.length ||
    s.args.some((v) => typeof v !== 'string' || v.includes('\0'))
  )
    throw new Error('Invalid native command specification');
}

function uncertain(state: Awaited<ReturnType<typeof wait>>, spec: Spec, code: number): boolean {
  return state.interrupted || state.exit === null || !spec.expected_exit_codes.includes(code) || !state.clean;
}
