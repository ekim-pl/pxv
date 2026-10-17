import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectRegistryBinding,
  invalidateRegistryBindings,
  phoneRegistryRecordSummary,
  phoneRegistrySummary,
  reconcilePhoneRegistryDocument,
  readRegistryGeneration,
  upsertPhoneRegistryRecord,
} from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import type { PhoneRegistryEpoch } from '@pxv/contracts';
import { device, observation } from '../contracts/fixtures.js';
import {
  emptyRegistry,
  registryDocument,
  registryInput,
  registryMarker,
  registryTime,
} from '../contracts/phone-registry-fixtures.js';

class EpochStore {
  readonly values = new Map<string, unknown>();
  get<T>(collection: string, key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(`${collection}:${key}`)) as T | undefined);
  }
  compareAndSet(collection: string, key: string, expected: unknown, next: unknown): Promise<boolean> {
    const address = `${collection}:${key}`;
    if (JSON.stringify(this.values.get(address)) !== JSON.stringify(expected)) return Promise.resolve(false);
    this.values.set(address, structuredClone(next));
    return Promise.resolve(true);
  }
}
const inventory = { schemaVersion: 1 as const, devices: [device] };
const epoch: PhoneRegistryEpoch = {
  canonicalSerial: device.canonicalSerial,
  codename: device.codename,
  deviceEpoch: '',
  profileEpochs: {},
};
const options = {
  expectedRevision: 0,
  expectedRecordRevision: null,
  confirmedCurrent: true,
  now: registryTime,
  generation: epoch,
  inventory,
};

describe('private registry revision and binding semantics', () => {
  it('requires explicit current confirmation, replaces timestamps and preserves immutable value history', () => {
    const input = registryInput();
    expect(() =>
      upsertPhoneRegistryRecord(emptyRegistry(), input, { ...options, confirmedCurrent: false }),
    ).toThrow('Explicit current');
    input.fields.duressPin!.updatedAt = '2020-01-01T00:00:00.000Z';
    const first = upsertPhoneRegistryRecord(emptyRegistry(), input, options);
    expect(first.devices[0]?.fields.duressPin).toMatchObject({
      updatedAt: registryTime,
      confirmedAt: registryTime,
    });
    const changed = registryInput();
    changed.fields.duressPin!.value = `${registryMarker}_rotated`;
    const second = upsertPhoneRegistryRecord(first, changed, {
      ...options,
      expectedRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(second.revision).toBe(2);
    expect(second.devices[0]?.revision).toBe(2);
    expect(second.history[0]?.record.fields.duressPin?.value).toBe(input.fields.duressPin?.value);
    expect(first.devices[0]?.fields.duressPin?.value).toBe(input.fields.duressPin?.value);
    expect(second.history[1]?.record.fields.duressPin?.value).toBe(changed.fields.duressPin?.value);
    expect(() =>
      upsertPhoneRegistryRecord(second, input, {
        ...options,
        expectedRevision: 1,
        expectedRecordRevision: 2,
      }),
    ).toThrow('revision changed');
    expect(() =>
      upsertPhoneRegistryRecord(second, input, {
        ...options,
        expectedRevision: 2,
        expectedRecordRevision: 1,
      }),
    ).toThrow('record revision changed');
    expect(() =>
      upsertPhoneRegistryRecord(emptyRegistry(), { ...input, canonicalSerial: 'ANOTHER_PHONE' }, options),
    ).toThrow('identity differs');
  });

  it('stales only the invalidated profile, then all values after a flash or lifecycle token change', async () => {
    const store = new EpochStore();
    const document = registryDocument();
    expect(await readRegistryGeneration(store, device)).toEqual(epoch);
    const changedProfile = await invalidateRegistryBindings(store, device, 'work', registryTime);
    const record = inspectRegistryBinding(document.devices[0]!, changedProfile, inventory);
    expect(record.fields.duressPin?.state).toBe('current');
    expect(record.profiles[0]?.fields.password?.state).toBe('current');
    expect(record.profiles[1]?.fields.pin?.state).toBe('stale');
    const changedDevice = await invalidateRegistryBindings(store, device, undefined, registryTime);
    expect(
      inspectRegistryBinding(document.devices[0]!, changedDevice, inventory).fields.duressPin?.state,
    ).toBe('stale');
    store.values.set(`plan-generations:${device.assetId}`, randomUUID());
    expect((await readRegistryGeneration(store, device)).deviceEpoch).not.toBe(changedDevice.deviceEpoch);
    expect(JSON.stringify([...store.values])).not.toContain(registryMarker);
    expect(document.devices[0]?.fields.duressPin?.state).toBe('current');
  });

  it('never restores historical or missing-epoch values to current and exposes no values in public summaries', () => {
    const document = registryDocument();
    const stale = inspectRegistryBinding(document.devices[0]!, undefined, inventory);
    expect(inspectRegistryBinding(stale, epoch, inventory).fields.duressPin?.state).toBe('stale');
    const summary = phoneRegistrySummary(document, new Map([[device.assetId, epoch]]), inventory);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(registryMarker);
    expect(serialized).not.toContain(device.canonicalSerial);
    expect(serialized).not.toContain('Administrator');
    expect(serialized).not.toContain('synthetic-test');
    expect(summary.devices[0]?.fields.duressPin).toEqual({
      present: true,
      state: 'current',
      confirmed: true,
    });
    expect(
      phoneRegistryRecordSummary(document.history[0]!.record, undefined, inventory).fields.duressPin,
    ).toEqual({ present: true, state: 'stale', confirmed: false });
    expect(phoneRegistrySummary(document, new Map(), inventory).devices[0]?.binding).toBe('stale');
    expect(
      inspectRegistryBinding(document.devices[0]!, epoch, {
        schemaVersion: 1,
        devices: [{ ...device, canonicalSerial: 'REPLACED' }],
      }).fields.duressPin?.state,
    ).toBe('stale');
  });

  it('checks retained Android serial identity and name when a fresh workflow observation is known', async () => {
    const store = new EpochStore();
    store.values.set(`workflow:${device.assetId}`, { observation });
    const known = await readRegistryGeneration(store, device);
    const record = registryDocument().devices[0]!;
    expect(inspectRegistryBinding(record, known, inventory).profiles[0]?.fields.password?.state).toBe(
      'current',
    );
    expect(inspectRegistryBinding(record, known, inventory).profiles[1]?.fields.pin?.state).toBe('stale');
    const reused = structuredClone(observation);
    reused.profiles[0]!.user.serialNo = 99;
    store.values.set(`workflow:${device.assetId}`, { observation: reused });
    const changed = await readRegistryGeneration(store, device);
    expect(inspectRegistryBinding(record, changed, inventory).profiles[0]?.fields.password?.state).toBe(
      'stale',
    );
    expect(() =>
      upsertPhoneRegistryRecord(emptyRegistry(), registryInput(), { ...options, generation: changed }),
    ).toThrow('retained Android user identity');
    reused.profiles[0]!.user = { userId: 0, serialNo: 0, name: 'Renamed' };
    store.values.set(`workflow:${device.assetId}`, { observation: reused });
    expect(
      inspectRegistryBinding(record, await readRegistryGeneration(store, device), inventory).profiles[0]
        ?.fields.password?.state,
    ).toBe('stale');
  });

  it('does not use a pre-invalidation observation to block a newly confirmed profile binding', async () => {
    const store = new EpochStore();
    store.values.set(`workflow:${device.assetId}`, { observation });
    const changed = await invalidateRegistryBindings(store, device, 'work', registryTime);
    expect(changed.observedUsers?.admin).toEqual(observation.profiles[0]?.user);
    expect(changed.unobservedProfiles).toEqual(['work']);
    expect(
      upsertPhoneRegistryRecord(emptyRegistry(), registryInput(), { ...options, generation: changed })
        .devices[0]?.profiles[1]?.fields.pin?.state,
    ).toBe('current');
    store.values.set(`plan-generations:${device.assetId}`, 'malformed-private-token');
    await expect(readRegistryGeneration(store, device)).rejects.toThrow('Invalid phone registry generation');
  });

  it('keeps mismatched known users stale when an unrelated profile is invalidated', async () => {
    const store = new EpochStore();
    const original = registryDocument();
    const record = original.devices[0]!;
    expect(
      inspectRegistryBinding(record, await readRegistryGeneration(store, device), inventory).profiles[0]
        ?.fields.password?.state,
    ).toBe('current');
    const known = structuredClone(observation);
    known.profiles[0]!.user.serialNo = 99;
    store.values.set(`workflow:${device.assetId}`, { observation: known });
    expect(
      inspectRegistryBinding(record, await readRegistryGeneration(store, device), inventory).profiles[0]
        ?.fields.password?.state,
    ).toBe('stale');
    const scoped = await invalidateRegistryBindings(store, device, 'work', registryTime);
    expect(scoped.observedUsers?.admin?.serialNo).toBe(99);
    expect(scoped.unobservedProfiles).toEqual(['work']);
    expect(inspectRegistryBinding(record, scoped, inventory).profiles[0]?.fields.password?.state).toBe(
      'stale',
    );
    expect(() =>
      upsertPhoneRegistryRecord(emptyRegistry(), registryInput(), { ...options, generation: scoped }),
    ).toThrow('retained Android user identity');

    const supplied = registryInput();
    supplied.profiles[0]!.user.serialNo = 99;
    supplied.profiles[1]!.user.serialNo = 23;
    const fresh = upsertPhoneRegistryRecord(original, supplied, {
      ...options,
      expectedRevision: 1,
      expectedRecordRevision: 1,
      generation: scoped,
    });
    expect(inspectRegistryBinding(fresh.devices[0]!, scoped, inventory).profiles[1]?.fields.pin?.state).toBe(
      'current',
    );
    known.observedAt = '2026-10-17T12:00:01.000Z';
    known.profiles.push({
      ...structuredClone(known.profiles[0]!),
      profileId: 'work',
      user: supplied.profiles[1]!.user,
    });
    store.values.set(`workflow:${device.assetId}`, { observation: known });
    const observed = await readRegistryGeneration(store, device);
    expect(observed.unobservedProfiles).toBeUndefined();
    expect(
      inspectRegistryBinding(fresh.devices[0]!, observed, inventory).profiles[1]?.fields.pin?.state,
    ).toBe('current');
    expect(inspectRegistryBinding(record, observed, inventory).profiles[0]?.fields.password?.state).toBe(
      'stale',
    );
  });

  it('rejects excess profile floors before writing public invalidation metadata', async () => {
    const store = new EpochStore();
    const profiles = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`profile-${index}`, randomUUID()]),
    );
    const previous = {
      schemaVersion: 1,
      canonicalSerial: device.canonicalSerial,
      codename: device.codename,
      invalidationEpoch: '',
      profileEpochs: profiles,
      profileInvalidatedAt: Object.fromEntries(
        Object.keys(profiles).map((profile) => [profile, registryTime]),
      ),
    };
    store.values.set(`registry-generation:${device.assetId}`, structuredClone(previous));
    await expect(invalidateRegistryBindings(store, device, 'one-too-many', registryTime)).rejects.toThrow(
      'registry',
    );
    expect(store.values.get(`registry-generation:${device.assetId}`)).toEqual(previous);
  });

  it('persists invalidation before returning and survives reopening local storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pxv-registry-epoch-'));
    const path = join(root, 'state.sqlite3');
    let store = await SqliteStore.open(path);
    try {
      const changed = await invalidateRegistryBindings(store, device, undefined, registryTime);
      await store.close();
      store = await SqliteStore.open(path);
      expect(await readRegistryGeneration(store, device)).toEqual(changed);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reconciles a backup by appending stale revisions without changing retained history or timestamps', () => {
    const original = registryDocument();
    const before = structuredClone(original);
    const now = '2026-10-18T09:00:00.000Z';
    const recovered = reconcilePhoneRegistryDocument(original, now);
    expect(original).toEqual(before);
    expect(recovered.revision).toBe(2);
    expect(recovered.devices[0]?.revision).toBe(2);
    expect(recovered.history[0]).toEqual(before.history[0]);
    expect(recovered.history[1]?.recordedAt).toBe(now);
    expect(recovered.devices[0]?.fields.duressPin).toEqual({
      ...before.devices[0]?.fields.duressPin,
      state: 'stale',
    });
    expect(recovered.devices[0]?.profiles[1]?.fields.oblivionNotificationWipeKey?.state).toBe('stale');
    expect(recovered.devices[0]?.generation).toEqual(before.devices[0]?.generation);
    expect(reconcilePhoneRegistryDocument(emptyRegistry(), now)).toEqual(emptyRegistry());
    expect(() => reconcilePhoneRegistryDocument(original, 'invalid-private-input')).toThrow(
      'reconciliation time',
    );
  });
});
