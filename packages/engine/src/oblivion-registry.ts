import type { AndroidUserIdentity, DeviceTarget, PhoneRegistryDocument } from '@pxv/contracts';
import { mergeCollectedRegistryValues } from './collection-registry.js';
import type { PhoneRegistryUpdateOptions } from './phone-registry.js';

export interface CollectedOblivionKey {
  profileId: string;
  user: AndroidUserIdentity;
  key: string;
  source?: string;
}

/** Compatibility entry point for the existing private Oblivion merge. */
export function mergeOblivionRegistryKeys(
  document: PhoneRegistryDocument,
  device: DeviceTarget,
  keys: CollectedOblivionKey[],
  options: PhoneRegistryUpdateOptions,
): PhoneRegistryDocument {
  return mergeCollectedRegistryValues(
    document,
    device,
    keys.map((entry) => ({
      scope: 'profile',
      profileId: entry.profileId,
      user: entry.user,
      field: 'oblivionNotificationWipeKey',
      value: entry.key,
      source: entry.source ?? 'net.oblivion.wipe QR dialog',
    })),
    options,
  );
}
