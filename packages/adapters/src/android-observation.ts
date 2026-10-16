import type { AndroidUserIdentity } from '@pxv/contracts';
import { AdapterError } from './command.js';
export function integer(value: string, label: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new AdapterError(`Invalid ${label}`);
  return parsed;
}
/** Parses verbose Android users only. A name/ID without serialNo is not an identity. */
export function parseUsers(output: string): AndroidUserIdentity[] {
  const users: AndroidUserIdentity[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('UserInfo{')) continue;
    const match = /UserInfo\{(\d+):([^:}]+):[a-fA-F0-9]+\}\s+serialNo=(\d+)\b/.exec(line);
    if (!match?.[1] || !match[2] || !match[3])
      throw new AdapterError('Android user serial identity cannot be inspected');
    users.push({
      userId: integer(match[1], 'user ID'),
      name: match[2],
      serialNo: integer(match[3], 'user serial'),
    });
  }
  if (
    !users.some((user) => user.userId === 0) ||
    new Set(users.map((user) => user.userId)).size !== users.length ||
    new Set(users.map((user) => user.serialNo)).size !== users.length
  )
    throw new AdapterError('Android users are missing or ambiguous');
  return users;
}
/** GrapheneOS exposes names through cmd user, while dumpsys redacts those names. */
export function parseNamedUsers(output: string): { userId: number; name: string }[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const header = /^(\d+) users?:$/.exec(lines[0] ?? '');
  if (!header?.[1]) throw new AdapterError('Android named user listing is malformed');
  const users = lines.slice(1).map((line) => {
    const row = /^\d+:\s+id=(\d+),\s+name=(.+?),\s+type=[A-Za-z0-9_.]+(?:,.*)?$/.exec(line);
    if (!row?.[1] || !row[2] || ['null', '(null)', 'undefined'].includes(row[2]))
      throw new AdapterError('Android user names could not be inspected');
    return { userId: integer(row[1], 'user ID'), name: row[2] };
  });
  if (
    users.length !== integer(header[1], 'user count') ||
    !users.some((user) => user.userId === 0) ||
    new Set(users.map((user) => user.userId)).size !== users.length
  )
    throw new AdapterError('Android named user listing is missing or ambiguous');
  return users;
}
function backupTransportPackage(name: string): string {
  // bmgr lists transport-defined names; Seedvault registers its class name rather than a component.
  if (name === 'com.stevesoltys.seedvault.transport.ConfigurableBackupTransport')
    return 'com.stevesoltys.seedvault';
  const component = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/[A-Za-z0-9_.$]+$/.exec(name);
  if (!component?.[1]) throw new AdapterError('Android backup transports could not be inspected');
  return component[1];
}
export function parseBackupObservation(
  enabledOutput: string,
  transportsOutput: string,
): { enabled: boolean; transportPackage: string | null } {
  const state = /^Backup Manager currently (enabled|disabled)\s*$/.exec(enabledOutput.trim());
  if (!state?.[1]) throw new AdapterError('Android backup enablement could not be inspected');
  const active: string[] = [];
  for (const raw of transportsOutput.trim().split('\n')) {
    const line = raw.trim();
    if (line === 'No transports available.') continue;
    const selected = line.startsWith('*');
    const transportPackage = backupTransportPackage(selected ? line.slice(1).trimStart() : line);
    if (selected) active.push(transportPackage);
  }
  if (active.length > 1) throw new AdapterError('Android backup selected transport is ambiguous');
  return { enabled: state[1] === 'enabled', transportPackage: active[0] ?? null };
}
