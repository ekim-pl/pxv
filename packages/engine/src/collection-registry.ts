import {
  sameAndroidUser,
  validatePhoneRegistryDocument,
  type AndroidUserIdentity,
  type DeviceTarget,
  type PhoneRegistryDocument,
  type PhoneRegistryRecord,
} from '@pxv/contracts';
import {
  inspectRegistryBinding,
  upsertPhoneRegistryRecord,
  type PhoneRegistryUpdateOptions,
} from './phone-registry.js';

/** Private updates: never include these in ordinary output or retained workflow evidence. */
export type CollectedRegistryValue = { value: string; source: string } & (
  | { scope: 'device'; field: 'phoneNumber' }
  | {
      scope: 'profile';
      profileId: string;
      user: AndroidUserIdentity;
      field: 'oblivionNotificationWipeKey' | 'sessionMessengerId';
    }
);

function applyValues(
  previous: PhoneRegistryRecord | undefined,
  values: CollectedRegistryValue[],
  options: PhoneRegistryUpdateOptions,
) {
  const fields = structuredClone(previous?.fields ?? {});
  const profiles = structuredClone(previous?.profiles ?? []);
  for (const entry of values) {
    const value = {
      value: entry.value,
      source: entry.source,
      state: 'current' as const,
      updatedAt: options.now,
    };
    if (entry.scope === 'device') {
      fields[entry.field] = value;
      continue;
    }
    collectedProfile(profiles, entry, options).fields[entry.field] = value;
  }
  return { fields, profiles };
}

function collectedProfile(
  profiles: PhoneRegistryRecord['profiles'],
  entry: Extract<CollectedRegistryValue, { scope: 'profile' }>,
  options: PhoneRegistryUpdateOptions,
) {
  const observed = options.generation.observedUsers?.[entry.profileId];
  if (!observed || !sameAndroidUser(observed, entry.user))
    throw new Error('Collected profile differs from enrolled Android identity');
  let profile = profiles.find((item) => item.profileId === entry.profileId);
  if (profile && !sameAndroidUser(profile.user, entry.user))
    throw new Error('Registry profile identity changed; reconcile it privately before collection');
  if (!profile) {
    profile = { profileId: entry.profileId, user: entry.user, fields: {} };
    profiles.push(profile);
  }
  return profile;
}

function preserveUncollected(
  record: PhoneRegistryRecord,
  previous: PhoneRegistryRecord | undefined,
  values: CollectedRegistryValue[],
): void {
  const deviceValues = record.fields;
  record.fields = { ...previous?.fields };
  for (const entry of values)
    if (entry.scope === 'device') record.fields[entry.field] = deviceValues[entry.field]!;
  for (const profile of record.profiles) {
    const captured = profile.fields;
    profile.fields = { ...previous?.profiles.find((item) => item.profileId === profile.profileId)?.fields };
    for (const entry of values)
      if (entry.scope === 'profile' && entry.profileId === profile.profileId)
        profile.fields[entry.field] = captured[entry.field]!;
  }
}

/** Merge only confirmed captured fields, retaining unrelated metadata and encrypted history. */
export function mergeCollectedRegistryValues(
  document: PhoneRegistryDocument,
  device: DeviceTarget,
  values: CollectedRegistryValue[],
  options: PhoneRegistryUpdateOptions,
): PhoneRegistryDocument {
  const keys = values.map(
    (entry) => `${entry.scope}:${entry.scope === 'profile' ? entry.profileId : ''}:${entry.field}`,
  );
  if (!values.length || new Set(keys).size !== keys.length)
    throw new Error('Collection needs distinct enrolled profiles and fields');
  const saved = document.devices.find((entry) => entry.assetId === device.assetId);
  if (saved && (saved.canonicalSerial !== device.canonicalSerial || saved.codename !== device.codename))
    throw new Error('Registry device identity changed; reconcile it privately before collection');
  const previous = saved && inspectRegistryBinding(saved, options.generation, options.inventory);
  const updated = upsertPhoneRegistryRecord(
    document,
    {
      assetId: device.assetId,
      canonicalSerial: device.canonicalSerial,
      codename: device.codename,
      ...applyValues(previous, values, options),
    },
    options,
  );
  const record = updated.devices.find((entry) => entry.assetId === device.assetId)!;
  preserveUncollected(record, previous, values);
  updated.history[updated.history.length - 1]!.record = record;
  return validatePhoneRegistryDocument(updated);
}
