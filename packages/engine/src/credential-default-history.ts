import {
  digest,
  sameAndroidUser,
  validateAction,
  validateUserIdentity,
  type Action,
  type AndroidUserIdentity,
  type DeviceObservation,
  type SelectedTarget,
} from '@pxv/contracts';
import type { Store } from '@pxv/runtime';

export type DefaultCredentialAction = Extract<Action, { kind: 'default-credential' | 'default-duress' }>;
interface AcceptedDefault {
  kind: DefaultCredentialAction['kind'];
  profileId: string;
  user: AndroidUserIdentity;
  configurationDigest: string;
  runId: string;
  status: 'command-accepted' | 'existing-lock-preserved';
}
const collection = 'credential-defaults';
const malformed = (): Error => new Error('Malformed credential default history retained for inspection');
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
const label = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
function exactFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function defaultAction(action: Action): action is DefaultCredentialAction {
  return action.kind === 'default-credential' || action.kind === 'default-duress';
}
function validStatus(kind: unknown, status: unknown): status is AcceptedDefault['status'] {
  return (
    status === 'command-accepted' || (kind === 'default-credential' && status === 'existing-lock-preserved')
  );
}
function acceptedEntry(value: unknown): AcceptedDefault {
  if (
    !exactFields(value, ['kind', 'profileId', 'user', 'configurationDigest', 'runId', 'status']) ||
    (value.kind !== 'default-credential' && value.kind !== 'default-duress') ||
    !identifier(value.profileId) ||
    typeof value.configurationDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.configurationDigest) ||
    !label(value.runId) ||
    !validStatus(value.kind, value.status)
  )
    throw malformed();
  return {
    kind: value.kind,
    profileId: value.profileId,
    user: validateUserIdentity(value.user),
    configurationDigest: value.configurationDigest,
    runId: value.runId,
    status: value.status,
  };
}
function matches(
  entry: AcceptedDefault,
  action: DefaultCredentialAction,
  user: AndroidUserIdentity,
): boolean {
  return (
    entry.kind === action.kind && entry.profileId === action.profileId && sameAndroidUser(entry.user, user)
  );
}
function entryKey(entry: AcceptedDefault): string {
  return JSON.stringify([entry.kind, entry.profileId, entry.user]);
}

/** Callers hold project and device ownership while accepting or clearing one-time defaults. */
export class CredentialDefaultHistory {
  constructor(readonly store: Store) {}

  private async read(target: SelectedTarget): Promise<AcceptedDefault[]> {
    const value = await this.store.get<unknown>(collection, target.device.assetId);
    if (value === undefined) return [];
    if (!exactFields(value, ['deviceSerial', 'entries']) || !Array.isArray(value.entries)) throw malformed();
    if (value.deviceSerial !== target.device.canonicalSerial)
      throw new Error('Credential default history device identity changed; inspect retained records');
    try {
      const entries = value.entries.map(acceptedEntry);
      if (new Set(entries.map(entryKey)).size !== entries.length) throw malformed();
      return entries;
    } catch {
      throw malformed();
    }
  }

  async pending(target: SelectedTarget, baseline: DeviceObservation, actions: Action[]): Promise<Action[]> {
    const entries = await this.read(target);
    return actions.filter((action) => {
      if (!defaultAction(action)) return true;
      const user = baseline.profiles.find((profile) => profile.profileId === action.profileId)?.user;
      return !user || !entries.some((entry) => matches(entry, action, user));
    });
  }

  async alreadyAccepted(
    target: SelectedTarget,
    action: DefaultCredentialAction,
    user: AndroidUserIdentity,
  ): Promise<boolean> {
    return (await this.read(target)).some((entry) => matches(entry, action, user));
  }

  async recordAccepted(
    target: SelectedTarget,
    action: DefaultCredentialAction,
    user: AndroidUserIdentity,
    runId: string,
    status: AcceptedDefault['status'] = 'command-accepted',
  ): Promise<void> {
    const checked = validateAction(action);
    if (!defaultAction(checked) || !label(runId) || !validStatus(checked.kind, status)) throw malformed();
    const identity = validateUserIdentity(user);
    const entries = (await this.read(target)).filter((entry) => !matches(entry, checked, identity));
    entries.push({
      kind: checked.kind,
      profileId: checked.profileId,
      user: identity,
      configurationDigest: digest(checked),
      runId,
      status,
    });
    await this.store.set(collection, target.device.assetId, {
      deviceSerial: target.device.canonicalSerial,
      entries,
    });
  }

  async clear(target: SelectedTarget): Promise<void> {
    await this.read(target);
    await this.store.delete(collection, target.device.assetId);
  }
}
