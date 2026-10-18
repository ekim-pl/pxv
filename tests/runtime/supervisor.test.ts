import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { afterEach, expect, it } from '../test-api.js';
import { loadKernel } from '../../packages/runtime/src/supervisor-native.js';
import {
  children,
  identity,
  ownedDescendant,
  parseChildren,
  signalPid,
} from '../../packages/runtime/src/supervisor-process.js';
import { validExitCodes, validateMessage } from '../../packages/runtime/src/supervisor-protocol.js';
import { digest, safeId } from '../../packages/runtime/src/supervisor-storage.js';
import { supervisorPath } from '../../packages/runtime/src/commands.js';
it('rejects path injection', () => {
  expect(safeId('../x')).toBe(false);
  expect(digest('../../file')).toBe(false);
  expect(safeId('run-123')).toBe(true);
  expect(digest('a'.repeat(64))).toBe(true);
});
it('binds live process identity', () => {
  const first = identity(process.pid);
  expect(identity(first.pid)).toEqual(first);
  expect(first.boot_id).not.toBe('');
  expect(first.start_ticks).not.toBe('');
});
it('rejects unknown protocol fields', () => {
  expect(() => validateMessage({ type: 'finish', success: true, env: 'secret' })).toThrow();
  expect(() =>
    validateMessage({
      type: 'recover',
      device_key: 'a'.repeat(64),
      transport_key: 'b'.repeat(64),
      operation_id: 'old-run',
      device_recovery_acknowledged: true,
    }),
  ).toThrow();
});
it('child enumeration fails closed', () => {
  expect(parseChildren('12 34\n')).toEqual([12, 34]);
  expect(parseChildren('')).toEqual([]);
  for (const value of ['12 invalid 34', '0', '-1', '2147483648'])
    expect(() => parseChildren(value)).toThrow();
  expect(() => children(-1)).toThrow();
});
it('never signals supervisor or unrelated ancestors', () => {
  expect(ownedDescendant(process.pid)).toBe(false);
  expect(ownedDescendant(process.ppid)).toBe(false);
  expect(ownedDescendant(-1)).toBe(false);
  signalPid(loadKernel(), process.pid, 9);
});
it('validates expected normal exit codes', () => {
  expect(validExitCodes([0])).toBe(true);
  expect(validExitCodes([0, 255])).toBe(true);
  for (const value of [[], [0, 0], [-1], [256], [0, 1, 2, 3, 4, 5, 6, 7, 8]])
    expect(validExitCodes(value)).toBe(false);
});
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function fixture() {
  const root = await mkdtemp('/tmp/pxv-supervisor-receipts-');
  await chmod(root, 0o700);
  const child = spawn(process.execPath, [await supervisorPath(), '--control-root', root], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  const ipc = child.stdio[3] as Duplex;
  const lines = createInterface({ input: ipc })[Symbol.asyncIterator]();
  const closed = new Promise<number | null>((done) => child.once('close', done));
  disposers.push(async () => {
    ipc.destroy();
    child.kill('SIGKILL');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const send = (value: unknown) => ipc.write(JSON.stringify(value) + '\n');
  const receive = async (): Promise<Record<string, unknown>> => {
    const line = await lines.next();
    if (line.done) throw new Error('Supervisor IPC closed');
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  send({
    type: 'acquire',
    device_key: 'a'.repeat(64),
    transport_key: 'b'.repeat(64),
    operation_id: 'fault-run',
  });
  expect((await receive())['type']).toBe('ready');
  return {
    root,
    ipc,
    send,
    receive,
    closed,
    submit(args: string[]) {
      send({
        type: 'run',
        id: 'command',
        args,
        env: {},
        cwd: null,
        input: null,
        input_file: null,
        timeout_ms: 5000,
      });
    },
    async authorize() {
      expect((await receive())['type']).toBe('gated');
      send({ type: 'authorize', id: 'command' });
    },
    async breakReceipts() {
      const path = join(root, 'receipts');
      await rm(path, { recursive: true });
      await writeFile(path, 'blocked receipt directory');
    },
    async fenced() {
      expect((await receive())['type']).toBe('error');
      expect(await closed).toBe(125);
      expect(await readdir(join(root, 'reservations'))).toHaveLength(2);
    },
  };
}
it('failed gate receipt never authorizes a child', async () => {
  const f = await fixture();
  await f.breakReceipts();
  const marker = join(f.root, 'must-not-run');
  f.submit(['/usr/bin/touch', marker]);
  await f.fenced();
  await expect(readFile(marker)).rejects.toThrow('ENOENT');
});
it('successful command retains fences when operation receipt fails', async () => {
  const f = await fixture();
  f.submit(['/bin/true']);
  await f.authorize();
  expect(await f.receive()).toMatchObject({ type: 'result', code: 0, cleanup_proven: true });
  await f.breakReceipts();
  f.send({ type: 'finish', success: true });
  await f.fenced();
});
it('mutated command receipt failure preserves both reservations', async () => {
  const f = await fixture(),
    release = join(f.root, 'release-child'),
    mutation = join(f.root, 'mutation-completed');
  f.submit([
    '/bin/sh',
    '-c',
    'while [ ! -f "$1" ]; do /bin/sleep 0.01; done; printf mutated > "$2"',
    'receipt-fault',
    release,
    mutation,
  ]);
  await f.authorize();
  await viWait(
    async () =>
      (
        JSON.parse(await readFile(join(f.root, 'receipts/fault-run-command.json'), 'utf8')) as Record<
          string,
          unknown
        >
      )['status'] === 'running',
  );
  await f.breakReceipts();
  await writeFile(release, 'release');
  await f.fenced();
  expect(await readFile(mutation, 'utf8')).toBe('mutated');
});
async function viWait(callback: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await callback())) {
    if (Date.now() > deadline) throw new Error('Child never reached running receipt');
    await new Promise((done) => setTimeout(done, 2));
  }
}

it.each(['live', 'same-boot-unclean', 'changed-boot', 'same-boot-clean', 'invalid-uid'] as const)(
  'recovers schema 1 Rust-produced reservations conservatively: %s',
  async (scenario) => {
    const root = await mkdtemp('/tmp/pxv-rust-recovery-record-');
    disposers.push(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o700);
    const { deviceLeaseKeys, withRecoveryLease } = await import('../../packages/runtime/src/commands.js');
    const keys = deviceLeaseKeys('rust-device', 'rust-usb');
    for (const name of ['locks', 'reservations', 'receipts']) await mkdir(join(root, name), { mode: 0o700 });
    const owner = identity(process.pid);
    const supervisor = {
      boot_id: scenario === 'changed-boot' ? 'previous-host-boot' : owner.boot_id,
      pid: scenario === 'live' ? owner.pid : 2147483647,
      start_ticks: owner.start_ticks,
      uid: scenario === 'invalid-uid' ? -1 : owner.uid,
    };
    const record = {
      cleanup_proven: scenario === 'same-boot-clean',
      device_key: keys.device,
      mutation_started: true,
      operation_id: 'rust-operation',
      previous_operation_id: null,
      schema: 1,
      status: 'recovery_required',
      supervisor,
      transport_key: keys.transport,
    };
    for (const key of [`device-${keys.device}`, `transport-${keys.transport}`]) {
      await writeFile(join(root, 'locks', key + '.lock'), '', { mode: 0o600 });
      await writeFile(join(root, 'reservations', key + '.json'), JSON.stringify(record), { mode: 0o600 });
    }
    const recover = () =>
      withRecoveryLease(root, 'rust-device', 'rust-usb', 'rust-operation', () => Promise.resolve());
    if (scenario === 'live' || scenario === 'same-boot-unclean' || scenario === 'invalid-uid') {
      await expect(recover()).rejects.toThrow(
        scenario === 'live'
          ? 'still alive'
          : scenario === 'invalid-uid'
            ? 'Malformed recovery owner'
            : 'reboot',
      );
      const retained = JSON.parse(
        await readFile(join(root, 'reservations', `device-${keys.device}.json`), 'utf8'),
      ) as unknown;
      expect(retained).toEqual(record);
    } else {
      await recover();
      expect(await readdir(join(root, 'reservations'))).toEqual([]);
      const lineage = (await readdir(join(root, 'receipts'))).find((p) =>
        p.endsWith('-previous-reservation.json'),
      )!;
      expect(JSON.parse(await readFile(join(root, 'receipts', lineage), 'utf8')) as unknown).toEqual(record);
    }
  },
);

it.each([
  { timeout_ms: 0 },
  { timeout_ms: 86400001 },
  { expected_exit_codes: [] },
  { expected_exit_codes: [0, 0] },
  { args: [] },
  { args: ['bad\0argument'] },
  { env: [] },
  { env: { 'bad=key': 'value' } },
  { cwd: 123 },
  { input: 'a', input_file: '/unused' },
  { input: 'not base64!' },
  { id: '../escape' },
])('rejects malformed direct IPC command specifications before authorization: %j', async (override) => {
  const f = await fixture();
  f.send({ type: 'run', id: 'invalid', args: ['/bin/true'], env: {}, timeout_ms: 5000, ...override });
  expect((await f.receive())['type']).toBe('error');
  expect(await f.closed).toBe(125);
});
it('requires an exact authorization and rejects replay of a completed command ID', async () => {
  const wrong = await fixture();
  wrong.submit(['/bin/true']);
  expect((await wrong.receive())['type']).toBe('gated');
  wrong.send({ type: 'authorize', id: 'other' });
  expect((await wrong.receive())['type']).toBe('error');
  await wrong.closed;
  const replay = await fixture();
  replay.submit(['/bin/true']);
  await replay.authorize();
  expect((await replay.receive())['type']).toBe('result');
  replay.submit(['/bin/true']);
  expect(await replay.receive()).toMatchObject({
    type: 'error',
    message: expect.stringContaining('refusing replay'),
  });
  await replay.closed;
});
it('bounds command output and retains the fence on capture overflow', async () => {
  const f = await fixture();
  f.submit([process.execPath, '-e', 'process.stdout.write("x".repeat(9*1024*1024))']);
  await f.authorize();
  expect(await f.receive()).toMatchObject({ type: 'result', code: 124, stdout: '', interrupted: true });
  f.send({ type: 'finish', success: true });
  expect(await f.receive()).toMatchObject({ type: 'finished', success: false });
  await f.closed;
  expect(await readdir(join(f.root, 'reservations'))).toHaveLength(2);
});
it('checks informational entrypoints and refuses unsupported invocation or ownership messages', async () => {
  const entry = await supervisorPath();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  expect((await execute(process.execPath, [entry, '--version'])).stdout.trim()).toBe('pxv-supervisor 0.1.0');
  await expect(execute(process.execPath, [entry])).rejects.toMatchObject({ code: 125 });
  const f = await fixture();
  f.send({ type: 'authorize', id: 'unexpected' });
  expect((await f.receive())['type']).toBe('error');
  await f.closed;
});

it('bounds malformed input while closing the rejected ownership channel', async () => {
  const f = await fixture();
  f.ipc.on('error', () => undefined);
  f.send({
    type: 'run',
    id: 'oversized',
    args: ['/bin/true'],
    env: { LARGE: 'x'.repeat(17 * 1024 * 1024) },
    timeout_ms: 5000,
  });
  expect(await f.receive()).toMatchObject({
    type: 'error',
    message: expect.stringContaining('IPC message exceeds limit'),
  });
  expect(await f.closed).toBe(125);
});

it('rejects FIFO command input before authorization without blocking owner cleanup', async () => {
  const f = await fixture();
  const input = join(f.root, 'input.fifo');
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [input]);
  f.send({ type: 'run', id: 'fifo', args: ['/bin/true'], env: {}, input_file: input, timeout_ms: 5000 });
  expect(await f.receive()).toMatchObject({
    type: 'error',
    message: expect.stringContaining('regular file'),
  });
  expect(await f.closed).toBe(125);
});
