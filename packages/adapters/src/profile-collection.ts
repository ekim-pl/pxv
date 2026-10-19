import { randomUUID } from 'node:crypto';
import {
  sameAndroidUser,
  validateUserIdentity,
  type AndroidUserIdentity,
  type ObligationWriter,
  type RecoveryObligation,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter, CleanupOptions } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import { foregroundUser, userUnlocked } from './seedvault-inspection.js';

export type CollectionStatus = 'collected' | 'not-present' | 'unavailable' | 'skipped';
export interface CollectionProfile {
  profileId: string;
  user: AndroidUserIdentity;
}
/** Private return value; only explicitly allowlisted summaries may be serialized. */
export interface CollectedProfileValue extends CollectionProfile {
  status: CollectionStatus;
  value?: string;
  versionCode?: number;
  manual?: boolean;
}
export interface ProfileCollectionOptions extends OperationOptions {
  obligations: ObligationWriter;
  unlock(profileId: string): Promise<void>;
  manual?(profileId: string): Promise<string | undefined>;
}
export interface ProfileCollector {
  name: string;
  code: string;
  packageId: string;
  signer: string;
  obligationKind: 'oblivion-foreground' | 'collection-foreground';
  read(
    android: AndroidAdapter,
    target: SelectedTarget,
    profile: CollectionProfile,
    options: ProfileCollectionOptions,
  ): Promise<string>;
}

export async function assertCollectionUnlocked(
  android: AndroidAdapter,
  target: SelectedTarget,
  user: AndroidUserIdentity,
  signal?: AbortSignal,
): Promise<void> {
  if (
    (await foregroundUser(android, target, signal)) !== user.userId ||
    !(await userUnlocked(android, target, user, signal))
  )
    throw new AdapterError('The intended Android profile must be privately unlocked');
  const policy = await android.shell(target, ['dumpsys', 'window', 'policy'], signal ? { signal } : {});
  const states = [...policy.matchAll(/\b(?:showing|mShowingLockscreen|mKeyguardShowing)=(true|false)\b/g)];
  if (!states.length || states.some((entry) => entry[1] === 'true'))
    throw new AdapterError('Privately dismiss the Android lock screen before collection');
}

export async function restoreCollectionForeground(
  android: AndroidAdapter,
  target: SelectedTarget,
  obligation: RecoveryObligation,
  options: CleanupOptions,
): Promise<void> {
  if (
    !['oblivion-foreground', 'collection-foreground'].includes(obligation.kind) ||
    obligation.ownerOperationId !== options.operationId ||
    obligation.deviceSerial !== target.device.canonicalSerial ||
    !['pending', 'blocked'].includes(obligation.status)
  )
    throw new AdapterError('Collection foreground recovery scope is invalid');
  const previous = validateUserIdentity(obligation.payload['previousForeground']);
  if (!obligation.user || !sameAndroidUser(previous, obligation.user))
    throw new AdapterError('Collection foreground recovery identity is invalid');
  await android.guardUser(target, previous, options.signal);
  if ((await foregroundUser(android, target, options.signal)) !== previous.userId)
    await android.shell(target, ['am', 'switch-user', String(previous.userId)], {
      ...options,
      mutation: true,
    });
  await android.guardUser(target, previous, options.signal);
  if ((await foregroundUser(android, target, options.signal)) !== previous.userId)
    throw new AdapterError('Original foreground profile was not restored');
}

async function trustedVersion(
  android: AndroidAdapter,
  target: SelectedTarget,
  profile: CollectionProfile,
  collector: ProfileCollector,
  signal?: AbortSignal,
) {
  await android.guardUser(target, profile.user, signal);
  const identity = await android.installedIdentity(target, profile.user, collector.packageId, signal);
  if (identity.packageId !== collector.packageId || identity.signerSha256 !== collector.signer)
    throw new AdapterError('Installed app signing identity is not trusted');
  return identity.versionCode;
}

async function collectProfile(
  android: AndroidAdapter,
  target: SelectedTarget,
  profile: CollectionProfile,
  collector: ProfileCollector,
  options: ProfileCollectionOptions,
): Promise<CollectedProfileValue> {
  const versionCode = await trustedVersion(android, target, profile, collector, options.signal);
  await android.shell(target, ['am', 'switch-user', String(profile.user.userId)], {
    ...options,
    mutation: true,
  });
  await options.unlock(profile.profileId);
  options.signal?.throwIfAborted();
  await assertCollectionUnlocked(android, target, profile.user, options.signal);
  let value: string | undefined;
  let manual = false;
  try {
    value = await collector.read(android, target, profile, options);
  } catch {
    options.signal?.throwIfAborted();
    if (!options.manual) throw new AdapterError('App value is unavailable');
    await assertCollectionUnlocked(android, target, profile.user, options.signal);
    if ((await trustedVersion(android, target, profile, collector, options.signal)) !== versionCode)
      throw new AdapterError('App version changed during collection');
    value = await options.manual(profile.profileId);
    manual = true;
  }
  options.signal?.throwIfAborted();
  await assertCollectionUnlocked(android, target, profile.user, options.signal);
  if ((await trustedVersion(android, target, profile, collector, options.signal)) !== versionCode)
    throw new AdapterError('App version changed during collection');
  return {
    ...profile,
    status: value === undefined ? 'skipped' : 'collected',
    versionCode,
    manual,
    ...(value === undefined ? {} : { value }),
  };
}

export async function collectProfileValues(
  android: AndroidAdapter,
  target: SelectedTarget,
  profiles: CollectionProfile[],
  collector: ProfileCollector,
  options: ProfileCollectionOptions,
): Promise<CollectedProfileValue[]> {
  await android.guardTarget(target, options.signal);
  const original = await foregroundUser(android, target, options.signal);
  const previous = (await android.users(target, options.signal)).find((user) => user.userId === original);
  if (!previous) throw new AdapterError('Original foreground profile cannot be identified');
  const obligation: RecoveryObligation = {
    schemaVersion: 1,
    id: randomUUID(),
    operationId: options.obligations.operationId,
    ownerOperationId: options.obligations.ownerOperationId,
    deviceSerial: target.device.canonicalSerial,
    user: previous,
    kind: collector.obligationKind,
    resource: 'foreground-user',
    payload: { previousForeground: previous },
    status: 'pending',
  };
  await options.obligations.record(obligation);
  try {
    const results: CollectedProfileValue[] = [];
    for (const profile of profiles) {
      options.signal?.throwIfAborted();
      await android.guardUser(target, profile.user, options.signal);
      if (!(await android.listPackages(target, profile.user, options.signal)).has(collector.packageId)) {
        results.push({ ...profile, status: 'not-present' });
        continue;
      }
      results.push(await collectProfile(android, target, profile, collector, options));
    }
    return results;
  } catch {
    throw new AdapterError(
      `${collector.name} collection failed; no values were saved`,
      `${collector.code}_COLLECTION_FAILED`,
    );
  } finally {
    try {
      await restoreCollectionForeground(android, target, obligation, {
        lease: options.lease,
        operationId: options.obligations.ownerOperationId,
      });
      await options.obligations.resolve(obligation.id);
    } catch {
      throw new AdapterError(
        `${collector.name} foreground restoration requires inspection and device recover`,
        `${collector.code}_RECOVERY_REQUIRED`,
      );
    }
  }
}
