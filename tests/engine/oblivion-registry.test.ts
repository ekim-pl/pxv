import { describe, expect, it } from '../test-api.js';
import { mergeOblivionRegistryKeys, phoneRegistrySummary } from '@pxv/engine';
import { device } from '../contracts/fixtures.js';
import { emptyRegistry, registryDocument, registryTime } from '../contracts/phone-registry-fixtures.js';

const user = { userId: 0, serialNo: 0, name: 'Administrator' };
const work = { userId: 10, serialNo: 22, name: 'Work' };
const key = 'SYNTHETIC-COLLECTED-PRIVATE-KEY';
const inventory = { schemaVersion: 1 as const, devices: [device] };
const generation = {
  canonicalSerial: device.canonicalSerial,
  codename: device.codename,
  deviceEpoch: '',
  profileEpochs: {},
  observedUsers: { admin: user, work },
};
const options = {
  expectedRevision: 0,
  expectedRecordRevision: null,
  confirmedCurrent: true,
  now: '2026-10-19T12:00:00.000Z',
  inventory,
  generation,
};

describe('private Oblivion registry merge', () => {
  it('creates a minimal record and records current only after operator confirmation', () => {
    const keys = [{ profileId: 'admin', user, key }];
    expect(() =>
      mergeOblivionRegistryKeys(emptyRegistry(), device, keys, { ...options, confirmedCurrent: false }),
    ).toThrow('Explicit current');
    const updated = mergeOblivionRegistryKeys(emptyRegistry(), device, keys, options);
    expect(updated.devices[0]?.fields).toEqual({});
    expect(updated.devices[0]?.profiles[0]?.fields).toEqual({
      oblivionNotificationWipeKey: {
        value: key,
        state: 'current',
        source: 'net.oblivion.wipe QR dialog',
        updatedAt: options.now,
        confirmedAt: options.now,
      },
    });
    expect(
      JSON.stringify(phoneRegistrySummary(updated, new Map([[device.assetId, generation]]), inventory)),
    ).not.toContain(key);
  });

  it('preserves unrelated fields, timestamps, absent-app profiles and prior history', () => {
    const previous = registryDocument();
    const updated = mergeOblivionRegistryKeys(previous, device, [{ profileId: 'admin', user, key }], {
      ...options,
      expectedRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(updated.devices[0]?.fields).toEqual(previous.devices[0]?.fields);
    expect(updated.devices[0]?.profiles[1]).toEqual(previous.devices[0]?.profiles[1]);
    expect(updated.devices[0]?.profiles[0]?.fields.password).toEqual(
      previous.devices[0]?.profiles[0]?.fields.password,
    );
    expect(updated.devices[0]?.profiles[0]?.fields.password?.updatedAt).toBe(registryTime);
    expect(updated.history[0]).toEqual(previous.history[0]);
    expect(updated.history[1]?.record).toEqual(updated.devices[0]);
    expect(previous.devices[0]?.profiles[0]?.fields.oblivionNotificationWipeKey).toBeUndefined();
  });

  it('rejects stale revisions, duplicate profiles, reused Android users and changed device identity', () => {
    const previous = registryDocument();
    const keys = [{ profileId: 'admin', user, key }];
    expect(() => mergeOblivionRegistryKeys(previous, device, keys, options)).toThrow('revision changed');
    expect(() => mergeOblivionRegistryKeys(emptyRegistry(), device, [...keys, ...keys], options)).toThrow(
      'distinct',
    );
    expect(() =>
      mergeOblivionRegistryKeys(
        emptyRegistry(),
        device,
        [{ profileId: 'admin', user: { ...user, serialNo: 9 }, key }],
        options,
      ),
    ).toThrow('identity');
    const replaced = structuredClone(previous);
    replaced.devices[0]!.canonicalSerial = 'REPLACED';
    expect(() =>
      mergeOblivionRegistryKeys(replaced, device, keys, {
        ...options,
        expectedRevision: 1,
        expectedRecordRevision: 1,
      }),
    ).toThrow('device identity');
  });
});
