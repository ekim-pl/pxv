import {
  sameAndroidUser,
  type AndroidUserIdentity,
  type ExecutionPolicy,
  type SeedvaultInspection,
  type SeedvaultProfileIdentity,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { parseBackupObservation } from './android-observation.js';
import { AdapterError } from './command.js';

export const SEEDVAULT_PACKAGE = 'com.stevesoltys.seedvault';
function persistentFullUsers(
  output: string,
  users: AndroidUserIdentity[],
): { full: AndroidUserIdentity[]; unsupported: AndroidUserIdentity[] } {
  const full: AndroidUserIdentity[] = [],
    unsupported: AndroidUserIdentity[] = [];
  for (const user of users) {
    const modern = output.split('\n').find((line) => new RegExp('\\bid=' + user.userId + ',').test(line));
    const legacy = output.split('\n').find((line) => line.includes('UserInfo{' + user.userId + ':'));
    if (modern) classifyModern(modern, user, full, unsupported);
    else if (legacy) classifyLegacy(legacy, user, full, unsupported);
    else throw new AdapterError('Every Android user needs an inspected persistent/full classification');
  }
  return { full, unsupported };
}
function classifyModern(
  line: string,
  user: AndroidUserIdentity,
  full: AndroidUserIdentity[],
  unsupported: AndroidUserIdentity[],
): void {
  const type = /\btype=([A-Za-z0-9_.]+)/.exec(line)?.[1];
  if (!type) throw new AdapterError('Android user type is missing');
  const numericFlags = /\bflags=(0x[a-f0-9]+|\d+)(?:,|\s|$)/i.exec(line)?.[1];
  const excluded =
    /\b(?:EPHEMERAL|GUEST|PARTIAL|REMOVING)\b|\((?:partial|removing)\)/.test(line) ||
    Boolean(numericFlags && (Number(numericFlags) & (4 | 32 | 256 | 4096)) !== 0);
  (/^(?:android\.os\.usertype\.)?full\.(?:SYSTEM|SECONDARY)$/.test(type) && !excluded
    ? full
    : unsupported
  ).push(user);
}
function classifyLegacy(
  line: string,
  user: AndroidUserIdentity,
  full: AndroidUserIdentity[],
  unsupported: AndroidUserIdentity[],
): void {
  const flags = /UserInfo\{\d+:[^:}]+:([a-fA-F0-9]+)\}/.exec(line)?.[1];
  if (!flags) throw new AdapterError('Android user flags are missing');
  const excluded =
    (Number.parseInt(flags, 16) & (4 | 32 | 256 | 4096)) !== 0 || /partial|removing/i.test(line);
  (excluded ? unsupported : full).push(user);
}
export async function inspectSeedvault(
  android: AndroidAdapter,
  target: SelectedTarget,
  policy: ExecutionPolicy,
  signal?: AbortSignal,
): Promise<SeedvaultInspection> {
  await android.guardTarget(target, signal);
  const users = await android.users(target, signal);
  const output = await android.shell(target, ['cmd', 'user', 'list', '-v'], signal ? { signal } : {});
  const classified = persistentFullUsers(output, users);
  const profiles: SeedvaultProfileIdentity[] = [];
  for (const user of classified.full)
    profiles.push(await inspectProfile(android, target, policy, user, signal));
  const after = await android.users(target, signal);
  if (
    users.length !== after.length ||
    users.some((user) => !after.some((item) => sameAndroidUser(user, item)))
  )
    throw new AdapterError('Android users changed during Seedvault inspection');
  return {
    deviceSerial: target.device.canonicalSerial,
    osFingerprint: (
      await android.shell(target, ['getprop', 'ro.build.fingerprint'], signal ? { signal } : {})
    ).trim(),
    foregroundUserId: await foregroundUser(android, target, signal),
    profiles,
    unsupportedUsers: classified.unsupported,
  };
}
async function inspectProfile(
  android: AndroidAdapter,
  target: SelectedTarget,
  policy: ExecutionPolicy,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<SeedvaultProfileIdentity> {
  const profile = policy.profiles.find(
    (item) => item.name === user.name && (item.kind === 'owner') === (user.userId === 0),
  );
  const options = signal ? { signal } : {};
  const activated = (
    await android.shell(target, ['bmgr', '--user', String(user.userId), 'activated'], options)
  ).trim();
  if (!/^Backup Manager currently (?:activated|deactivated)$/.test(activated))
    throw new AdapterError('Seedvault backup service activation could not be inspected');
  const inactive = activated === 'Backup Manager currently deactivated';
  const enabled = inactive
    ? ''
    : await android.shell(target, ['bmgr', '--user', String(user.userId), 'enabled'], options);
  const transports = inactive
    ? 'No transports available.'
    : await android.shell(target, ['bmgr', '--user', String(user.userId), 'list', 'transports'], options);
  return {
    profileId: profile?.id ?? 'unreviewed-user-' + user.userId,
    user,
    package: await android.installedIdentity(target, user, SEEDVAULT_PACKAGE, signal),
    backup: inactive
      ? { enabled: false, transportPackage: null }
      : parseBackupObservation(enabled, transports),
    unlocked: await userUnlocked(android, target, user, signal),
  };
}
export async function foregroundUser(
  android: AndroidAdapter,
  target: SelectedTarget,
  signal?: AbortSignal,
): Promise<number> {
  const value = (await android.shell(target, ['am', 'get-current-user'], signal ? { signal } : {})).trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AdapterError('Foreground Android user is unknown');
  return Number(value);
}
export async function userUnlocked(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  const value = (
    await android.shell(
      target,
      ['am', 'get-started-user-state', String(user.userId)],
      signal ? { signal } : {},
    )
  ).trim();
  if (value === 'RUNNING_UNLOCKED') return true;
  if (
    /^(?:BOOTING|RUNNING_LOCKED|RUNNING_UNLOCKING|STOPPING|SHUTDOWN)$/.test(value) ||
    value === 'User is not started: ' + user.userId
  )
    return false;
  throw new AdapterError('Android user unlock state is unknown');
}
export async function seedvaultTokens(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<string[]> {
  await android.guardUser(target, user, signal);
  const output = await android.shell(
    target,
    ['bmgr', '--user', String(user.userId), 'list', 'sets'],
    signal ? { signal } : {},
  );
  if (output.trim() === 'No restore sets') return [];
  const tokens = output
    .trim()
    .split('\n')
    .map((line) => /^\s*([a-f0-9]{1,16}) : .+\s*$/.exec(line)?.[1]);
  if (!tokens.length || tokens.some((value) => value === undefined) || new Set(tokens).size !== tokens.length)
    throw new AdapterError('Seedvault durable restore sets could not be inspected', 'MANUAL_PENDING');
  return tokens as string[];
}
