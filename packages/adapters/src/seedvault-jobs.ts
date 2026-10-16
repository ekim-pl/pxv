import type { AndroidUserIdentity, SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError } from './command.js';
import { SEEDVAULT_PACKAGE } from './seedvault-inspection.js';

/** Scheduled WorkManager work can mutate storage without a live foreground service. */
export async function seedvaultJobsQuiescent(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<void> {
  await android.guardUser(target, user, signal);
  const options = signal ? { signal } : {};
  const packages = await android.shell(
    target,
    ['pm', 'list', 'packages', '--user', String(user.userId), '-U', SEEDVAULT_PACKAGE],
    options,
  );
  const uid = seedvaultUid(packages, user);
  const jobs = await android.shell(target, ['dumpsys', 'jobscheduler', SEEDVAULT_PACKAGE], options);
  assertSeedvaultJobsIdle(jobs, uid);
  await android.guardUser(target, user, signal);
}
function seedvaultUid(output: string, user: AndroidUserIdentity): number {
  const rows = output.trim().split('\n');
  const match = /^package:com\.stevesoltys\.seedvault uid:(\d+)$/.exec(rows[0] ?? '');
  const uid = Number(match?.[1]);
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(uid) ||
    Math.floor(uid / 100000) !== user.userId ||
    uid % 100000 < 10000
  )
    throw new AdapterError(
      'Seedvault package UID cannot be bound to the selected stable user',
      'MANUAL_PENDING',
    );
  return uid;
}
function assertSeedvaultJobsIdle(output: string, uid: number): void {
  const header = /Registered \d+ jobs:\s*\n/.exec(output);
  if (!header || !output.includes('Pending queue:'))
    throw new AdapterError(
      'Seedvault JobScheduler state is unknown; preserve remote-job ownership',
      'MANUAL_PENDING',
    );
  const following = output.slice(header.index + header[0].length);
  const rows = following.split('\n').filter((line) => /^\s*JOB /.test(line));
  if (!rows.length && !following.trimStart().startsWith('(none)'))
    throw new AdapterError('Seedvault scheduled work could not be enumerated', 'MANUAL_PENDING');
  const expected = 'u' + Math.floor(uid / 100000) + 'a' + ((uid % 100000) - 10000);
  for (const row of rows) {
    const identity = /^\s*JOB #([A-Za-z0-9]+)\//.exec(row)?.[1];
    if (!identity) throw new AdapterError('Seedvault scheduled-job identity is unknown', 'MANUAL_PENDING');
    if (identity === expected || identity === String(uid))
      throw new AdapterError(
        'Seedvault has queued or running work for this profile; disable scheduling privately and verify quiescence before disconnecting storage',
        'MANUAL_PENDING',
      );
  }
}
