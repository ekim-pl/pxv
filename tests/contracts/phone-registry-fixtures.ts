import type { PhoneRegistryDocument, PhoneRegistryRecordInput, PhoneRegistryRecord } from '@pxv/contracts';
import { device } from './fixtures.js';

export const registryTime = '2026-10-17T12:00:00.000Z';
export const registryMarker = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_USE';
export function registryInput(): PhoneRegistryRecordInput {
  const value = (name: string) => ({
    value: `${registryMarker}_${name}`,
    state: 'current' as const,
    source: 'synthetic-test',
  });
  return {
    assetId: device.assetId,
    canonicalSerial: device.canonicalSerial,
    codename: device.codename,
    fields: {
      duressPin: value('duressPin'),
      duressPassword: value('duressPassword'),
      phoneNumber: value('deviceNumber'),
    },
    profiles: [
      {
        profileId: 'admin',
        user: { userId: 0, serialNo: 0, name: 'Administrator' },
        fields: { password: value('ownerPassword'), sessionMessengerId: value('sessionId') },
      },
      {
        profileId: 'work',
        user: { userId: 10, serialNo: 22, name: 'Work' },
        fields: {
          pin: value('workPin'),
          oblivionNotificationWipeKey: value('oblivionKey'),
          protonVpnUsername: value('vpnName'),
          protonVpnPassword: value('vpnPassword'),
          phoneNumber: value('profileNumber'),
        },
      },
    ],
  };
}
export function emptyRegistry(): PhoneRegistryDocument {
  return { schemaVersion: 1, projectId: 'registry-test', revision: 0, devices: [], history: [] };
}
export function registryDocument(): PhoneRegistryDocument {
  const input = registryInput();
  const fields = <T extends Record<string, unknown>>(values: T) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { ...(value as object), updatedAt: registryTime, confirmedAt: registryTime },
      ]),
    );
  const record: PhoneRegistryRecord = {
    ...input,
    revision: 1,
    generation: { deviceEpoch: '', profileEpochs: {} },
    fields: fields(input.fields),
    profiles: input.profiles.map((profile) => ({ ...profile, fields: fields(profile.fields) })),
  };
  return {
    schemaVersion: 1,
    projectId: 'registry-test',
    revision: 1,
    devices: [record],
    history: [{ revision: 1, recordedAt: registryTime, record: structuredClone(record) }],
  };
}
