#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
const { CommandRunner, withDeviceLease, nativeReceipts, recoveryReservations } = await import(
  modulePath
    ? pathToFileURL(modulePath).href
    : new URL('../packages/runtime/dist/index.js', import.meta.url).href
);
const scratch = await mkdtemp('/tmp/pxv-native-baseline-');
try {
  const control = join(scratch, 'control');
  const runner = new CommandRunner();
  const operation = 'baseline-lease';
  const result = await withDeviceLease(
    control,
    'synthetic-baseline-device',
    'synthetic-baseline-transport',
    operation,
    (/** @type {import('../packages/runtime/dist/index.js').DeviceLease} */ lease) =>
      runner.run([process.execPath, '-e', 'process.stdout.write("pxv-native-baseline")'], {
        mutation: true,
        lease,
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
        timeoutMs: 5000,
      }),
  );
  const receipts = await nativeReceipts(control, operation);
  const completed = receipts.filter(
    (/** @type {import('../packages/runtime/dist/native-evidence.js').NativeReceipt} */ r) =>
      r.status === 'completed',
  );
  if (
    result.code !== 0 ||
    result.stdout !== 'pxv-native-baseline' ||
    completed.length !== 1 ||
    completed[0]?.code !== 0 ||
    completed[0]?.cleanupProven !== true ||
    (await recoveryReservations(control)).length
  )
    throw Error('Native baseline lease/receipt failed');
  process.stdout.write(
    JSON.stringify({
      status: 'passed',
      lease: true,
      mutationExitCode: result.code,
      cleanupProven: true,
      reservations: 0,
    }) + '\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
