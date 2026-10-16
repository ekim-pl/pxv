import {
  canonicalJson,
  type AndroidUserIdentity,
  type SeedvaultAdapterDefinition,
  type SelectedTarget,
  type UiSelector,
} from '@pxv/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import type { AndroidAdapter } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import { RecipeService } from './recipes.js';
import { matchUiNode, type UiNode } from './ui-snapshot.js';
import { foregroundUser, SEEDVAULT_PACKAGE, userUnlocked } from './seedvault-inspection.js';
import { seedvaultJobsQuiescent } from './seedvault-jobs.js';

const PUBLIC_ACTIVITIES = new Set([
  '.settings.SettingsActivity',
  '.restore.RestoreActivity',
  '.ui.check.AppCheckResultActivity',
  '.ui.check.FileCheckResultActivity',
]);
export async function seedvaultIdentity(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  signal?: AbortSignal,
): Promise<void> {
  await android.guardUser(target, user, signal);
  const identity = await android.installedIdentity(target, user, SEEDVAULT_PACKAGE, signal);
  const fingerprint = (
    await android.shell(target, ['getprop', 'ro.build.fingerprint'], signal ? { signal } : {})
  ).trim();
  if (
    canonicalJson(identity) !== canonicalJson(definition.package) ||
    fingerprint !== definition.buildFingerprint
  )
    throw new AdapterError('Seedvault package signer/version or Android build changed', 'MANUAL_PENDING');
}
export async function seedvaultGuard(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  signal?: AbortSignal,
): Promise<void> {
  await seedvaultIdentity(android, target, user, definition, signal);
  if (
    (await foregroundUser(android, target, signal)) !== user.userId ||
    !(await userUnlocked(android, target, user, signal))
  )
    throw new AdapterError('Foreground and privately unlock the intended Android user', 'MANUAL_PENDING');
  const policy = await android.shell(target, ['dumpsys', 'window', 'policy'], signal ? { signal } : {});
  const locked = [...policy.matchAll(/\b(?:showing|mShowingLockscreen|mKeyguardShowing)=(true|false)\b/g)];
  if (!locked.length || locked.some((match) => match[1] === 'true'))
    throw new AdapterError(
      'Privately dismiss the Android lock screen before Seedvault automation',
      'MANUAL_PENDING',
    );
}
async function publicActivity(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  signal?: AbortSignal,
): Promise<void> {
  await seedvaultGuard(android, target, user, definition, signal);
  const windows = await android.shell(target, ['dumpsys', 'window', 'windows'], signal ? { signal } : {});
  const matches = [
    ...windows.matchAll(/mCurrentFocus=Window\{[^\n]*?\bu(\d+)\s+([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/g),
  ];
  const match = matches[0];
  if (matches.length !== 1 || match?.[1] !== String(user.userId) || match[2] !== SEEDVAULT_PACKAGE)
    throw new AdapterError(
      'Focus the intended Seedvault public screen; consent remains private',
      'MANUAL_PENDING',
    );
  const activity = match[3]?.replace(SEEDVAULT_PACKAGE, '');
  if (!activity || !PUBLIC_ACTIVITIES.has(activity) || !definition.activities.includes(activity))
    throw new AdapterError(
      'Seedvault credential, storage-consent or unknown screen remains private',
      'MANUAL_PENDING',
    );
  assertPublicWindow(windows);
}
function assertPublicWindow(windows: string): void {
  const focus = /mCurrentFocus=(Window\{[^}\n]+\})/.exec(windows)?.[1];
  const start = focus ? windows.indexOf(focus + ':') : -1;
  const block = start < 0 ? '' : (windows.slice(start).split(/\n\s*Window #/)[0] ?? '');
  const flags = /\bfl=([^\n}]+)/.exec(block)?.[1];
  if (!flags || secureFlags(flags))
    throw new AdapterError('Seedvault secure or uninspectable window remains private', 'MANUAL_PENDING');
}
function secureFlags(flags: string): boolean {
  if (/\bSECURE\b/.test(flags)) return true;
  const numeric = /^(0x[0-9a-f]+|\d+)\b/i.exec(flags)?.[1];
  return Boolean(numeric && (Number(numeric) & 0x2000) !== 0);
}
export async function seedvaultSnapshot(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  signal?: AbortSignal,
): Promise<UiNode[]> {
  await publicActivity(android, target, user, definition, signal);
  const nodes = await new RecipeService(android).snapshot(target, user, SEEDVAULT_PACKAGE, signal);
  await publicActivity(android, target, user, definition, signal);
  if (nodes.some((node) => node.attributes['password'] === 'true'))
    throw new AdapterError('Seedvault secret input remains private', 'MANUAL_PENDING');
  return nodes;
}
export async function seedvaultNode(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  selector: UiSelector,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<UiNode> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const node = matchUiNode(
      await seedvaultSnapshot(android, target, user, definition, signal),
      selector,
      SEEDVAULT_PACKAGE,
    );
    if (node) return node;
    if (Date.now() >= deadline)
      throw new AdapterError('Reviewed Seedvault UI checkpoint is missing', 'MANUAL_PENDING');
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, signal ? { signal } : {});
  }
}
export async function tapSeedvault(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  node: UiNode,
  options: OperationOptions,
): Promise<void> {
  await publicActivity(android, target, user, definition, options.signal);
  await new RecipeService(android).tap(target, user, SEEDVAULT_PACKAGE, node, options);
}
export async function seedvaultQuiescent(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  definition: SeedvaultAdapterDefinition,
  operation: 'backup' | 'restore',
  signal?: AbortSignal,
): Promise<void> {
  await seedvaultNode(
    android,
    target,
    user,
    definition,
    definition[operation].completion.idle as UiSelector,
    1,
    signal,
  );
  await seedvaultWorkQuiescent(android, target, user, signal);
}
export async function seedvaultWorkQuiescent(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<void> {
  await android.guardUser(target, user, signal);
  const services = await android.shell(
    target,
    ['dumpsys', 'activity', 'services', SEEDVAULT_PACKAGE],
    signal ? { signal } : {},
  );
  const active = [
    ...services.matchAll(
      /ServiceRecord\{[^}\n]*\bu(\d+)\s+com\.stevesoltys\.seedvault\/([A-Za-z0-9_.$]+)[^}]*\}/g,
    ),
  ];
  const mutating = active.some(
    (record) =>
      record[1] === String(user.userId) &&
      /(?:FinalizeBackupService|RestoreService|StorageRestoreService|SystemForegroundService|SystemJobService|BackupService)$/.test(
        record[2] ?? '',
      ),
  );
  if (!services.includes('ACTIVITY MANAGER SERVICES') || mutating)
    throw new AdapterError(
      'Seedvault service ownership is not yet quiescent; do not disconnect storage or kill jobs',
      'MANUAL_PENDING',
    );
  await seedvaultJobsQuiescent(android, target, user, signal);
}
