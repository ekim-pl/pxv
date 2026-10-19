import { describe, expect, it } from '../test-api.js';
import { mergeCollectedRegistryValues, type CollectedRegistryValue } from '@pxv/engine';
import { device } from '../contracts/fixtures.js';
import { emptyRegistry, registryDocument, registryTime } from '../contracts/phone-registry-fixtures.js';

const generation = {
  canonicalSerial: device.canonicalSerial,
  codename: device.codename,
  deviceEpoch: '',
  profileEpochs: {},
  observedUsers: {
    admin: { userId: 0, serialNo: 0, name: 'Administrator' },
    work: { userId: 10, serialNo: 22, name: 'Work' },
  },
};
const options = {
  expectedRevision: 1,
  expectedRecordRevision: 1,
  confirmedCurrent: true,
  now: '2026-10-19T12:00:00.000Z',
  generation,
  inventory: { schemaVersion: 1 as const, devices: [device] },
};
const updates: CollectedRegistryValue[] = [
  {
    scope: 'device',
    field: 'phoneNumber',
    value: '+48111222333\n+48222333444',
    source: 'synthetic SIM collection',
  },
  {
    scope: 'profile',
    profileId: 'admin',
    user: generation.observedUsers.admin,
    field: 'sessionMessengerId',
    value: '05' + 'a'.repeat(64),
    source: 'synthetic Session collection',
  },
];
describe('shared private collection registry merge', () => {
  it('merges device and profile updates while preserving other fields, dates and history', () => {
    const previous = registryDocument();
    const updated = mergeCollectedRegistryValues(previous, device, updates, options);
    expect(updated.revision).toBe(2);
    expect(updated.devices[0]?.fields.phoneNumber).toMatchObject({
      value: updates[0]?.value,
      state: 'current',
      confirmedAt: options.now,
    });
    expect(updated.devices[0]?.profiles[0]?.fields.sessionMessengerId).toMatchObject({
      value: updates[1]?.value,
      confirmedAt: options.now,
    });
    expect(updated.devices[0]?.fields.duressPin).toEqual(previous.devices[0]?.fields.duressPin);
    expect(updated.devices[0]?.profiles[0]?.fields.password?.confirmedAt).toBe(registryTime);
    expect(updated.devices[0]?.profiles[1]).toEqual(previous.devices[0]?.profiles[1]);
    expect(updated.history[0]).toEqual(previous.history[0]);
    expect(updated.history[1]?.record).toEqual(updated.devices[0]);
    expect(previous.revision).toBe(1);
  });
  it('creates a device-only record without requiring profile observations', () => {
    const updated = mergeCollectedRegistryValues(emptyRegistry(), device, [updates[0]!], {
      ...options,
      expectedRevision: 0,
      expectedRecordRevision: null,
      generation: { ...generation, observedUsers: {} },
    });
    expect(updated.devices[0]?.profiles).toEqual([]);
    expect(updated.devices[0]?.fields.phoneNumber?.value).toBe(updates[0]?.value);
  });
  it('requires confirmation and rejects duplicates, unknown profiles and stale revisions', () => {
    expect(() =>
      mergeCollectedRegistryValues(registryDocument(), device, updates, {
        ...options,
        confirmedCurrent: false,
      }),
    ).toThrow('Explicit current');
    expect(() =>
      mergeCollectedRegistryValues(registryDocument(), device, [...updates, updates[0]!], options),
    ).toThrow('distinct');
    expect(() =>
      mergeCollectedRegistryValues(registryDocument(), device, updates, { ...options, expectedRevision: 0 }),
    ).toThrow('revision changed');
    expect(() =>
      mergeCollectedRegistryValues(registryDocument(), device, updates, {
        ...options,
        generation: { ...generation, observedUsers: {} },
      }),
    ).toThrow('identity');
  });
});
