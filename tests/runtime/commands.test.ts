import { CommandError } from '../../packages/runtime/src/command-contracts.js';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  CommandRunner,
  deviceLeaseKeys,
  recoveryReservations,
  hostControlRoot,
  supervisorPath,
  withDeviceLease,
  withRecoveryLease,
  nativeReceipts,
} from '../../packages/runtime/src/index.js';

const runner = new CommandRunner();
const node = process.execPath;
async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Condition did not become true');
}

describe('checked runtime', () => {
  test('inspection supports explicit environment, input, timeout and checked exit', async () => {
    const result = await runner.run(
      [node, '-e', 'process.stdin.pipe(process.stdout); console.error(process.env.ONLY,process.env.HOME)'],
      { input: 'hello', env: { ONLY: 'yes' } },
    );
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('yes undefined\n');
    await expect(runner.run([node, '-e', 'process.exit(2)'])).rejects.toBeInstanceOf(CommandError);
    expect((await runner.run([node, '-e', 'process.exit(3)'], { check: false })).code).toBe(3);
    expect(
      (await runner.run([node, '-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 50, check: false })).code,
    ).toBe(124);
    await expect(runner.run([])).rejects.toThrow('argument vector');
    await expect(runner.run(['echo'], { timeoutMs: 0 })).rejects.toThrow('timeout');
    await expect(runner.run(['echo'], { input: Buffer.alloc(9 * 1024 * 1024) })).rejects.toThrow('inputFile');
    await expect(runner.run(['echo'], { mutation: true, lease: {} })).rejects.toThrow('native DeviceLease');
  });
  test('streams regular file input without loading it into IPC', async () => {
    const directory = await mkdtemp('/tmp/pxv-command-');
    const file = join(directory, 'input');
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 42));
    const command = [
      node,
      '-e',
      'let count=0;process.stdin.on("data",b=>count+=b.length).on("end",()=>console.log(count))',
    ];
    expect((await runner.run(command, { inputFile: file })).stdout).toBe('2097152\n');
    await withDeviceLease(join(directory, 'control'), 'device', 'transport', 'stream', async (lease) => {
      expect((await runner.run(command, { inputFile: file, mutation: true, lease })).stdout).toBe(
        '2097152\n',
      );
    });
    await expect(runner.run(command, { input: 'x', inputFile: file })).rejects.toThrow('mutually exclusive');
    await expect(runner.run(command, { inputFile: directory })).rejects.toThrow('regular file');
  });
  test('inspection cancellation, spawn failure and output bounds terminate promptly', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('already aborted'));
    await expect(runner.run(['/bin/true'], { signal: aborted.signal })).rejects.toThrow('already aborted');
    const active = new AbortController();
    const command = runner.run([node, '-e', 'setTimeout(()=>{},10000)'], {
      signal: active.signal,
      check: false,
    });
    active.abort();
    expect((await command).code).toBe(124);
    await expect(runner.run(['/nonexistent-pxv-command'])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await runner.run([node, '-e', 'process.stdout.write(Buffer.alloc(10*1024*1024))'], { check: false }))
        .code,
    ).toBe(124);
  });
});

describe('Linux native ownership', () => {
  test('gated command retains redacted evidence and releases both leases only after durable completion', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const sentinel = 'super-secret-sentinel-784';
    let savedLease;
    await withDeviceLease(root, 'physical-1', 'usb-1', 'complete', async (lease) => {
      savedLease = lease;
      expect(await recoveryReservations(root)).toHaveLength(1);
      const result = await runner.run(
        [node, '-e', 'process.stdin.pipe(process.stdout);console.error(process.env.PRIVATE)'],
        { mutation: true, lease, env: { PRIVATE: sentinel }, input: Uint8Array.from([0, 255, 42]) },
      );
      expect(Buffer.from(result.stdout, 'utf8')).toEqual(Buffer.from([0, 0xef, 0xbf, 0xbd, 42]));
      expect(result.stderr.trim()).toBe(sentinel);
    });
    expect(await recoveryReservations(root)).toHaveLength(0);
    const native = await nativeReceipts(root, 'complete');
    expect(native).toHaveLength(1);
    expect(native[0]?.status).toBe('completed');
    expect(native[0]?.cleanupProven).toBe(true);
    expect(native[0]?.code).toBe(0);
    for (const file of await readdir(join(root, 'receipts'))) {
      expect(await readFile(join(root, 'receipts', file), 'utf8')).not.toContain(sentinel);
      expect((await stat(join(root, 'receipts', file))).mode & 0o777).toBe(0o600);
    }
    if (!savedLease) throw new Error('Fixture lease missing');
    await expect(runner.run(['/bin/true'], { mutation: true, lease: savedLease })).rejects.toThrow('closed');
  });
  test('locks physical identity across different transports and transport identity across different devices', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await withDeviceLease(root, 'physical', 'usb', 'outer', async () => {
      await expect(
        withDeviceLease(root, 'physical', 'different', 'other', () => Promise.resolve(undefined)),
      ).rejects.toThrow('busy');
      await expect(
        withDeviceLease(root, 'different', 'usb', 'other', () => Promise.resolve(undefined)),
      ).rejects.toThrow('busy');
    });
  });
  test('timeout kills escaped descendants and retains a recoverable device fence', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const marker = join(root, 'escaped');
    // setsid detaches the grandchild from the original process group. The
    // subreaper still adopts it when its intermediate shell exits.
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'timeout', async (lease) => {
        await runner.run(
          [
            '/bin/sh',
            '-c',
            `setsid /bin/sh -c 'sleep 0.5; touch "$1"' child "$1" </dev/null >/dev/null 2>&1 & wait`,
            'parent',
            marker,
          ],
          { mutation: true, lease, timeoutMs: 75 },
        );
      }),
    ).rejects.toThrow('124');
    await delay(650);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const reservations = await recoveryReservations(root);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.cleanup_proven).toBe(true);
    expect((await nativeReceipts(root, 'timeout'))[0]?.interrupted).toBe(true);
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'again', () => Promise.resolve(undefined)),
    ).rejects.toThrow('unresolved');
    await withRecoveryLease(root, 'physical', 'usb', 'timeout', () => Promise.resolve());
    await withDeviceLease(root, 'physical', 'usb', 'recovered', () => Promise.resolve(undefined));
  });
  test('recovery executes under the inherited fence and only clears it after successful cleanup', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'interrupted', (lease) =>
        runner.run(['/bin/sh', '-c', 'exit 4'], { mutation: true, lease }),
      ),
    ).rejects.toThrow('4');
    await expect(
      withRecoveryLease(root, 'physical', 'usb', 'wrong', () => Promise.resolve()),
    ).rejects.toThrow('Matching recovery');
    await expect(
      withRecoveryLease(root, 'physical', 'usb', 'interrupted', () =>
        Promise.reject(new Error('user identity mismatch')),
      ),
    ).rejects.toThrow('user identity mismatch');
    const [next] = await recoveryReservations(root);
    expect(next?.previous_operation_id).toBe('interrupted');
    await withRecoveryLease(root, 'physical', 'usb', next!.operation_id, async (lease) => {
      await expect(
        withDeviceLease(root, 'physical', 'usb', 'bypass', () => Promise.resolve()),
      ).rejects.toThrow('busy');
      await runner.run(['/bin/true'], { mutation: true, lease });
      expect(await recoveryReservations(root)).toHaveLength(1);
    });
    expect(await recoveryReservations(root)).toEqual([]);
  });
  test('SIGKILL of the Node owner cleans escaped descendants and leaves recovery reservation', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const marker = join(root, 'late');
    const ready = join(root, 'ready');
    const module = resolve('packages/runtime/dist/index.js');
    const command = [
      '/bin/sh',
      '-c',
      'touch "$1"; setsid /bin/sh -c \'sleep 1; touch "$1"\' child "$2" </dev/null >/dev/null 2>&1 & wait',
      'sh',
      ready,
      marker,
    ];
    const code = `import {withDeviceLease,CommandRunner} from ${JSON.stringify(`file://${module}`)}; await withDeviceLease(${JSON.stringify(root)},'physical','usb','owner-death',async lease=>new CommandRunner().run(${JSON.stringify(command)},{mutation:true,lease,timeoutMs:20000}));`;
    const child = spawn(node, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr?.on('data', (buffer: Buffer) => {
      diagnostic += buffer.toString();
    });
    await eventually(async () => {
      try {
        await stat(ready);
        return true;
      } catch {
        if (child.exitCode !== null) throw new Error(diagnostic);
        return false;
      }
    });
    child.kill('SIGKILL');
    await eventually(async () => (await recoveryReservations(root))[0]?.status === 'recovery_required');
    await delay(1100);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const receipts = await readdir(join(root, 'receipts'));
    expect(receipts.some((name) => name === 'owner-death-operation.json')).toBe(true);
    expect((await recoveryReservations(root))[0]?.cleanup_proven).toBe(true);
  });
  test('nonzero mutations retain fences even with unchecked results', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'partial', async (lease) => {
        expect(
          (await runner.run(['/bin/sh', '-c', 'exit 7'], { mutation: true, lease, check: false })).code,
        ).toBe(7);
      }),
    ).rejects.toThrow('remains fenced');
    expect(await recoveryReservations(root)).toHaveLength(1);
  });
  test('declared normal exits retain raw evidence and require successful adapter validation', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await withDeviceLease(root, 'physical', 'usb', 'expected', async (lease) => {
      expect(
        (
          await runner.run(['/bin/sh', '-c', 'exit 255'], {
            mutation: true,
            lease,
            check: false,
            expectedExitCodes: [0, 255],
          })
        ).code,
      ).toBe(255);
    });
    expect(await recoveryReservations(root)).toEqual([]);
    expect((await nativeReceipts(root, 'expected'))[0]).toMatchObject({
      code: 255,
      cleanupProven: true,
      interrupted: false,
      expectedExitCodes: [0, 255],
    });
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'post-check', async (lease) => {
        await runner.run(['/bin/sh', '-c', 'exit 255'], {
          mutation: true,
          lease,
          check: false,
          expectedExitCodes: [0, 255],
        });
        throw new Error('Postcondition did not hold');
      }),
    ).rejects.toThrow('Postcondition');
    expect(await recoveryReservations(root)).toHaveLength(1);
  });
  test.each([
    { args: ['/bin/sh', '-c', 'kill -TERM $$'], codes: [0, 128], timeoutMs: 5000 },
    { args: ['/bin/sleep', '10'], codes: [0, 124], timeoutMs: 20 },
    { args: ['/bin/sh', '-c', 'exit 2'], codes: [0, 255], timeoutMs: 5000 },
  ])(
    'declared codes never allow signals, timeouts or unexpected exits %#',
    async ({ args, codes, timeoutMs }) => {
      const root = await mkdtemp('/tmp/pxv-native-');
      await expect(
        withDeviceLease(root, 'physical', 'usb', 'interrupted', (lease) =>
          runner.run(args, { mutation: true, lease, check: false, timeoutMs, expectedExitCodes: codes }),
        ),
      ).rejects.toThrow('remains fenced');
      expect(await recoveryReservations(root)).toHaveLength(1);
    },
  );
  test.each(
    [[], [0, 0], [-1], [256], [1.5], Array.from({ length: 9 }, (_, i) => i)].map((expectedExitCodes) => ({
      expectedExitCodes,
    })),
  )('invalid expected exit declarations fail before execution %#', async ({ expectedExitCodes }) => {
    await expect(runner.run(['/bin/true'], { expectedExitCodes })).rejects.toThrow('expected exit');
  });
  test('capability keys are domain separated and malformed evidence fails closed', async () => {
    expect(deviceLeaseKeys('same', 'same').device).not.toBe(deviceLeaseKeys('same', 'same').transport);
    const root = await mkdtemp('/tmp/pxv-native-');
    await withDeviceLease(root, 'physical', 'usb', 'setup', () => Promise.resolve(undefined));
    await writeFile(join(root, 'reservations', 'broken.json'), '{broken');
    await expect(recoveryReservations(root)).rejects.toThrow('Malformed recovery');
    expect(await readFile(join(root, 'reservations', 'broken.json'), 'utf8')).toBe('{broken');
  });
  test.each([
    {},
    { schema: 1 },
    { schema: 1, operation_id: 'a' },
    { schema: 1, operation_id: 'a', device_key: 'd' },
    { schema: 1, operation_id: 'a', device_key: 'd', transport_key: 't' },
    { schema: 1, operation_id: 'a', device_key: 'd', transport_key: 't', supervisor: {} },
  ])('preserves malformed structured recovery evidence %#', async (record) => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await withDeviceLease(root, 'physical', 'usb', 'setup', () => Promise.resolve());
    const path = join(root, 'reservations', 'invalid.json');
    await writeFile(path, JSON.stringify(record));
    await writeFile(join(root, 'reservations', 'ignore.txt'), 'unrelated');
    await expect(recoveryReservations(root)).rejects.toThrow('Malformed recovery evidence');
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(record));
  });
  test('native receipt reconciliation rejects malformed or secret-bearing evidence without deleting it', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    expect(await nativeReceipts(root, 'absent')).toEqual([]);
    await expect(nativeReceipts(root, '../invalid')).rejects.toThrow('identity');
    await withDeviceLease(root, 'physical', 'usb', 'receipt-test', (lease) =>
      runner.run(['/bin/true'], { mutation: true, lease }),
    );
    const [native] = await nativeReceipts(root, 'receipt-test');
    const path = join(root, 'receipts', `receipt-test-${native!.commandId}.json`);
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const variants = [
      null,
      {},
      { ...original, env: { TOKEN: 'secret' } },
      { ...original, supervisor: null },
      { ...original, supervisor: { pid: 1, uid: 0, start_ticks: 'bad', boot_id: 'id' } },
      { ...original, child: {} },
      { ...original, code: '0' },
      { ...original, cleanup_proven: 'yes' },
      { ...original, interrupted: 'no' },
      { ...original, expected_exit_codes: [] },
      { ...original, expected_exit_codes: [255, 255] },
    ];
    for (const value of variants) {
      await writeFile(path, JSON.stringify(value));
      await expect(nativeReceipts(root, 'receipt-test')).rejects.toThrow('Malformed native');
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(value));
    }
    await writeFile(path, '{broken');
    await expect(nativeReceipts(root, 'receipt-test')).rejects.toThrow('Malformed native receipt');
    const gated: Record<string, unknown> = { ...original, status: 'gated' };
    delete gated['child'];
    delete gated['code'];
    delete gated['cleanup_proven'];
    delete gated['interrupted'];
    await writeFile(path, JSON.stringify(gated));
    expect((await nativeReceipts(root, 'receipt-test'))[0]?.status).toBe('gated');
  });
  test('aborts supervised commands and keeps interruption evidence', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const controller = new AbortController();
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'abort', async (lease) => {
        const pending = runner.run([node, '-e', 'setTimeout(()=>{},10000)'], {
          mutation: true,
          lease,
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 50);
        await pending;
      }),
    ).rejects.toThrow('124');
    expect((await recoveryReservations(root))[0]?.cleanup_proven).toBe(true);
  });
  test('errors before mutation release clean reservations, live recovery cannot bypass a lock', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    await expect(
      withDeviceLease(root, 'physical', 'usb', 'throw', () => Promise.reject(new Error('review changed'))),
    ).rejects.toThrow('review changed');
    expect(await recoveryReservations(root)).toEqual([]);
    await withDeviceLease(root, 'physical', 'usb', 'live', async () => {
      await expect(
        withRecoveryLease(root, 'physical', 'usb', 'live', () => Promise.resolve()),
      ).rejects.toThrow('still alive');
    });
    await expect(
      withDeviceLease(root, 'physical', 'usb', '../bad', () => Promise.resolve(undefined)),
    ).rejects.toThrow('Invalid operation');
    expect(() => deviceLeaseKeys('', 'usb')).toThrow('identities');
    expect(await recoveryReservations(join(root, 'absent'))).toEqual([]);
  });
  test('native executable discovery fails closed for missing, symlink and nonexecutable overrides', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const actual = await supervisorPath();
    const link = join(root, 'link');
    await symlink(actual, link);
    try {
      vi.stubEnv('PXV_SUPERVISOR', join(root, 'missing'));
      await expect(supervisorPath()).rejects.toThrow('required');
      vi.stubEnv('PXV_SUPERVISOR', link);
      await expect(supervisorPath()).rejects.toThrow('required');
      const denied = join(root, 'denied');
      await writeFile(denied, 'no');
      await chmod(denied, 0o600);
      vi.stubEnv('PXV_SUPERVISOR', denied);
      await expect(supervisorPath()).rejects.toThrow('required');
      vi.stubEnv('PXV_CONTROL_ROOT', join(root, 'shared'));
      expect(hostControlRoot()).toBe(join(root, 'shared'));
      vi.stubEnv('PXV_CONTROL_ROOT', undefined);
      vi.stubEnv('XDG_STATE_HOME', root);
      expect(hostControlRoot()).toBe(join(root, 'pxv-host-control'));
      vi.stubEnv('XDG_STATE_HOME', undefined);
      expect(hostControlRoot()).toContain('.local/state/pxv-host-control');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('rejects invalid IPC and explicit native errors without executing a tool', async () => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const program = join(root, 'fake.mjs');
    try {
      vi.stubEnv('PXV_SUPERVISOR', program);
      for (const payload of [
        'not-json\n',
        '{"type":"unexpected"}\n',
        '{"type":"error","message":"native refusal"}\n',
        '{"type":"error"}\n',
      ]) {
        await writeFile(
          program,
          `#!${node}\nimport {writeSync} from 'node:fs';writeSync(3,${JSON.stringify(payload)});setTimeout(()=>{},100);`,
          { mode: 0o700 },
        );
        await expect(
          withDeviceLease(join(root, 'control'), 'device', 'transport', 'invalid', () => Promise.resolve()),
        ).rejects.toThrow();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test.each([
    { type: 'result', cleanup_proven: false },
    { type: 'result', cleanup_proven: true },
  ])('rejects missing or unproven completion receipts %#', async (response) => {
    const root = await mkdtemp('/tmp/pxv-native-');
    const program = join(root, 'fake.mjs');
    const source = `#!${node}\nimport {writeSync,createReadStream} from 'node:fs';import{createInterface}from'node:readline';const send=v=>writeSync(3,JSON.stringify(v)+'\\n');createInterface({input:createReadStream('',{fd:3})}).on('line',line=>{const m=JSON.parse(line);if(m.type==='acquire')send({type:'ready'});if(m.type==='run'){send({type:'gated',id:m.id});send({...${JSON.stringify(response)},id:m.id});}if(m.type==='finish'){send({type:'finished',success:false,cleanup_proven:true});process.exit(0);}});`;
    await writeFile(program, source, { mode: 0o700 });
    try {
      vi.stubEnv('PXV_SUPERVISOR', program);
      await expect(
        withDeviceLease(join(root, 'control'), 'device', 'transport', 'invalid', (lease) =>
          runner.run(['/bin/true'], { mutation: true, lease, expectedExitCodes: [0, 255] }),
        ),
      ).rejects.toThrow(
        response.cleanup_proven ? 'Invalid native completion receipt' : 'cleanup could not be proven',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('rejects response backlogs, oversized IPC lines and post-ready native failure', async () => {
    const root = await mkdtemp('/tmp/pxv-native-protocol-');
    const program = join(root, 'fake.mjs');
    try {
      vi.stubEnv('PXV_SUPERVISOR', program);
      const scripts = [
        "for(let i=0;i<5;i++)writeSync(3,JSON.stringify({type:'result',id:'unrequested-'+i})+'\\n');",
        "writeSync(3,'x'.repeat(33*1024*1024)+'\\n');",
        "writeSync(3,JSON.stringify({type:'ready'})+'\\n'+JSON.stringify({type:'error',message:'post-ready refusal'})+'\\n');",
      ];
      for (const source of scripts) {
        await writeFile(
          program,
          '#!' + node + "\nimport {writeSync} from 'node:fs';" + source + 'setTimeout(()=>{},50);',
          { mode: 0o700 },
        );
        await expect(
          withDeviceLease(join(root, 'control'), 'device', 'transport', 'protocol', async (lease) => {
            await delay(10);
            await runner.run(['/bin/true'], { mutation: true, lease });
          }),
        ).rejects.toThrow(/backlog|response exceeded|post-ready refusal/u);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(
      withRecoveryLease(root, 'device', 'transport', '../escape', () => Promise.resolve()),
    ).rejects.toThrow('previous operation identity');
  });

  test('cancellation while a command waits at the gate never authorizes it', async () => {
    const root = await mkdtemp('/tmp/pxv-native-gate-');
    const program = join(root, 'fake.mjs');
    const marker = join(root, 'authorized');
    await writeFile(
      program,
      '#!' +
        node +
        '\n' +
        "import {writeSync,writeFileSync,createReadStream} from 'node:fs';import{createInterface}from'node:readline';" +
        "const send=v=>writeSync(3,JSON.stringify(v)+'\\n');createInterface({input:createReadStream('',{fd:3})}).on('line',line=>{const m=JSON.parse(line);if(m.type==='acquire')send({type:'ready'});if(m.type==='run')setTimeout(()=>send({type:'gated',id:m.id}),30);if(m.type==='authorize')writeFileSync(" +
        JSON.stringify(marker) +
        ", 'bad');});",
      { mode: 0o700 },
    );
    try {
      vi.stubEnv('PXV_SUPERVISOR', program);
      const controller = new AbortController();
      await expect(
        withDeviceLease(join(root, 'control'), 'device', 'transport', 'gate', async (lease) => {
          const pending = runner.run(['/bin/true'], { mutation: true, lease, signal: controller.signal });
          setTimeout(() => controller.abort(new Error('cancelled while gated')), 10);
          await pending;
        }),
      ).rejects.toThrow('cancelled while gated');
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
