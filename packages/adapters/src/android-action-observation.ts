import {
  canonicalJson,
  sameAndroidUser,
  type Action,
  type AndroidUserIdentity,
  type DeviceObservation,
  type ExecutionPolicy,
  type SelectedTarget,
  type ProfileObservation,
} from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError } from './command.js';

/** Refresh action state, retaining the timestamp of the last full observation. */
export async function inspectAndroidAction(
  android: AndroidAdapter,
  target: SelectedTarget,
  policy: ExecutionPolicy,
  previous: DeviceObservation,
  action: Action,
  signal?: AbortSignal,
): Promise<DeviceObservation> {
  if (action.kind !== 'setting' && action.kind !== 'permission' && action.kind !== 'install-apk')
    return android.inspect(target, policy, signal);
  await android.guardTarget(target, signal);
  const users = await android.users(target, signal);
  assertProfileUsers(previous, users);
  const observed = structuredClone(previous);
  if (action.kind === 'install-apk')
    await refreshPackage(android, target, policy, observed, action.artifact.packageId, signal);
  else {
    const profile = observed.profiles.find((value) => value.profileId === action.profileId);
    if (!profile) throw new AdapterError('Selected Android profile is absent');
    if (action.kind === 'setting')
      await refreshSetting(android, target, observed, profile, action.setting, signal);
    else {
      const permission = await android.permission(target, profile.user, action.permission, signal);
      const existing = profile.permissions.find(
        (value) => value.packageId === permission.packageId && value.permission === permission.permission,
      );
      if (existing) Object.assign(existing, permission);
      else profile.permissions.push(permission);
    }
  }
  await android.guardTarget(target, signal);
  if (canonicalJson(users) !== canonicalJson(await android.users(target, signal)))
    throw new AdapterError('Android users changed during action observation');
  return observed;
}

function assertProfileUsers(previous: DeviceObservation, users: AndroidUserIdentity[]): void {
  for (const profile of previous.profiles)
    if (!users.some((user) => sameAndroidUser(user, profile.user)))
      throw new AdapterError('Android user identity changed during execution');
}

async function refreshPackage(
  android: AndroidAdapter,
  target: SelectedTarget,
  policy: ExecutionPolicy,
  observed: DeviceObservation,
  packageId: string,
  signal?: AbortSignal,
): Promise<void> {
  const effect = (await android.inspectSharedEffects(target, [packageId], signal))[0];
  if (!effect) throw new AdapterError('Installed APK effects are missing');
  for (const profile of observed.profiles) {
    const configured = policy.profiles.find((value) => value.id === profile.profileId);
    const installed = effect.users.find((value) => sameAndroidUser(value.user, profile.user));
    profile.packages = profile.packages.filter((value) => value.packageId !== packageId);
    if (installed && configured?.packages.some((value) => value.packageId === packageId)) {
      const { user, ...identity } = installed;
      void user;
      profile.packages.push({ packageId, ...identity });
    }
    for (const permission of profile.permissions)
      if (permission.packageId === packageId)
        Object.assign(
          permission,
          installed ? await android.permission(target, profile.user, permission, signal) : { granted: false },
        );
  }
}

async function refreshSetting(
  android: AndroidAdapter,
  target: SelectedTarget,
  observed: DeviceObservation,
  profile: ProfileObservation,
  wanted: Extract<Action, { kind: 'setting' }>['setting'],
  signal?: AbortSignal,
): Promise<void> {
  const setting = { ...wanted, value: await android.readSetting(target, profile.user, wanted, signal) };
  for (const candidate of observed.profiles) {
    if (candidate !== profile && setting.namespace !== 'global') continue;
    const existing = candidate.settings.find(
      (value) => value.namespace === setting.namespace && value.key === setting.key,
    );
    if (existing) Object.assign(existing, setting);
    else if (candidate === profile) candidate.settings.push(setting);
  }
}
