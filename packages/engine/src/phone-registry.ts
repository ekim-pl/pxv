import { createHash, randomUUID } from 'node:crypto';
import {
  validatePhoneRegistryDocument,
  validatePhoneRegistryEpoch,
  validatePhoneRegistryRecord,
  validatePhoneRegistryRecordInput,
  validateObservation,
  sameAndroidUser,
  type DeviceTarget,
  type Inventory,
  type PhoneRegistryDocument,
  type PhoneRegistryEpoch,
  type PhoneRegistryRecord,
  type PhoneRegistryRecordInput,
  type PhoneRegistryValue,
  type PhoneRegistryValueInput,
} from '@pxv/contracts';
import type { Store } from '@pxv/runtime';

type DeviceIdentity = Pick<DeviceTarget, 'assetId' | 'canonicalSerial' | 'codename'>;
type EpochStore = Pick<Store, 'get' | 'compareAndSet'>;
interface StoredEpoch {
  schemaVersion: 1;
  canonicalSerial: string;
  codename: string;
  invalidationEpoch: string;
  profileEpochs: Record<string, string>;
  invalidatedAt?: string;
  profileInvalidatedAt?: Record<string, string>;
}
export interface PhoneRegistryUpdateOptions {
  expectedRevision: number;
  expectedRecordRevision: number | null;
  confirmedCurrent: boolean;
  now: string;
  generation: PhoneRegistryEpoch;
  inventory: Inventory;
}
const namespace = 'registry-generation';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const invalidGeneration = (): Error => new Error('Invalid phone registry generation');

function storedEpoch(value: unknown, device: DeviceIdentity): StoredEpoch {
  if (value === undefined)
    return {
      schemaVersion: 1,
      canonicalSerial: device.canonicalSerial,
      codename: device.codename,
      invalidationEpoch: '',
      profileEpochs: {},
    };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidGeneration();
  const entry = value as StoredEpoch;
  validateStoredEpoch(entry);
  return entry;
}
function validateStoredEpoch(entry: StoredEpoch): void {
  if (
    Object.keys(entry).some(
      (key) =>
        ![
          'schemaVersion',
          'canonicalSerial',
          'codename',
          'invalidationEpoch',
          'profileEpochs',
          'invalidatedAt',
          'profileInvalidatedAt',
        ].includes(key),
    ) ||
    entry.schemaVersion !== 1 ||
    typeof entry.invalidationEpoch !== 'string' ||
    (entry.invalidationEpoch !== '' && !uuid.test(entry.invalidationEpoch))
  )
    throw invalidGeneration();
  if (entry.invalidatedAt !== undefined && !validTime(entry.invalidatedAt)) throw invalidGeneration();
  validatePhoneRegistryEpoch({
    canonicalSerial: entry.canonicalSerial,
    codename: entry.codename,
    deviceEpoch: '',
    profileEpochs: entry.profileEpochs,
  });
  validateProfileFloors(entry);
}
function validateProfileFloors(entry: StoredEpoch): void {
  const floors = entry.profileInvalidatedAt;
  if (floors === undefined) return;
  if (floors === null || typeof floors !== 'object' || Array.isArray(floors)) throw invalidGeneration();
  const values = Object.entries(floors);
  if (
    values.length > 128 ||
    values.some(
      ([profileId, at]) =>
        !identifier.test(profileId) ||
        !validTime(at) ||
        !Object.hasOwn(entry.profileEpochs, profileId) ||
        !entry.profileEpochs[profileId],
    )
  )
    throw invalidGeneration();
}
function currentStoredEpoch(value: unknown, device: DeviceIdentity): StoredEpoch {
  const entry = storedEpoch(value, device);
  return entry.canonicalSerial === device.canonicalSerial && entry.codename === device.codename
    ? entry
    : storedEpoch(undefined, device);
}

function validTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function validateIdentity(device: DeviceIdentity): void {
  if (!identifier.test(device.assetId)) throw invalidGeneration();
  validatePhoneRegistryEpoch({
    canonicalSerial: device.canonicalSerial,
    codename: device.codename,
    deviceEpoch: '',
    profileEpochs: {},
  });
}

async function observedUsers(
  store: Pick<Store, 'get'>,
  device: DeviceIdentity,
  current: StoredEpoch,
): Promise<Pick<PhoneRegistryEpoch, 'observedUsers' | 'unobservedProfiles'>> {
  const workflow = await store.get<{ observation?: unknown }>('workflow', device.assetId);
  if (workflow === undefined) return {};
  let observation;
  try {
    observation = validateObservation(workflow.observation);
  } catch {
    throw invalidGeneration();
  }
  if (
    observation.device.assetId !== device.assetId ||
    observation.device.canonicalSerial !== device.canonicalSerial ||
    observation.device.codename !== device.codename
  )
    return {};
  if (current.invalidatedAt && Date.parse(observation.observedAt) < Date.parse(current.invalidatedAt))
    return {};
  const pending = Object.entries(current.profileInvalidatedAt ?? {})
    .filter(([, at]) => Date.parse(observation.observedAt) < Date.parse(at))
    .map(([profileId]) => profileId)
    .sort();
  return {
    observedUsers: Object.fromEntries(
      observation.profiles.map((profile) => [profile.profileId, profile.user]),
    ),
    ...(pending.length ? { unobservedProfiles: pending } : {}),
  };
}

/** Reads public invalidation tokens only; no credential bytes or hashes enter SQLite. */
export async function readRegistryGeneration(
  store: Pick<Store, 'get'>,
  device: DeviceIdentity,
): Promise<PhoneRegistryEpoch> {
  validateIdentity(device);
  const raw = await store.get<unknown>(namespace, device.assetId);
  const current = currentStoredEpoch(raw, device);
  const lifecycle = await store.get<unknown>('plan-generations', device.assetId);
  if (lifecycle !== undefined && (typeof lifecycle !== 'string' || !uuid.test(lifecycle)))
    throw invalidGeneration();
  const deviceEpoch =
    current.invalidationEpoch || lifecycle
      ? createHash('sha256')
          .update(JSON.stringify([current.invalidationEpoch, lifecycle ?? '']))
          .digest('hex')
      : '';
  const users = await observedUsers(store, device, current);
  return validatePhoneRegistryEpoch({
    canonicalSerial: device.canonicalSerial,
    codename: device.codename,
    deviceEpoch,
    profileEpochs: current.profileEpochs,
    ...users,
  });
}

/** Must finish durably before destructive flash or creation of the named Android profile. */
export async function invalidateRegistryBindings(
  store: EpochStore,
  device: DeviceIdentity,
  profileId?: string,
  now = new Date().toISOString(),
): Promise<PhoneRegistryEpoch> {
  validateIdentity(device);
  if (!validTime(now)) throw invalidGeneration();
  if (profileId !== undefined && !identifier.test(profileId)) throw invalidGeneration();
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.get<unknown>(namespace, device.assetId);
    const next = invalidatedEpoch(currentStoredEpoch(previous, device), profileId, now);
    validateStoredEpoch(next);
    if (await store.compareAndSet(namespace, device.assetId, previous, next))
      return readRegistryGeneration(store, device);
  }
  throw new Error('Phone registry generation changed concurrently');
}
function invalidatedEpoch(current: StoredEpoch, profileId: string | undefined, now: string): StoredEpoch {
  if (profileId !== undefined)
    return {
      ...current,
      profileEpochs: { ...current.profileEpochs, [profileId]: randomUUID() },
      profileInvalidatedAt: {
        ...current.profileInvalidatedAt,
        [profileId]: latestTime(current.profileInvalidatedAt?.[profileId], now),
      },
    };
  return {
    ...current,
    invalidationEpoch: randomUUID(),
    profileEpochs: {},
    profileInvalidatedAt: {},
    invalidatedAt: latestTime(current.invalidatedAt, now),
  };
}
function latestTime(previous: string | undefined, now: string): string {
  return previous && Date.parse(previous) > Date.parse(now) ? previous : now;
}

function binding(record: PhoneRegistryRecord, epoch: PhoneRegistryEpoch | undefined, inventory: Inventory) {
  const devices = inventory.devices.filter((device) => device.assetId === record.assetId);
  const device = devices.length === 1 ? devices[0] : undefined;
  const valid = Boolean(
    device &&
    epoch &&
    device.canonicalSerial === record.canonicalSerial &&
    device.codename === record.codename &&
    epoch.canonicalSerial === record.canonicalSerial &&
    epoch.codename === record.codename &&
    epoch.deviceEpoch === record.generation.deviceEpoch,
  );
  const profiles = Object.fromEntries(
    record.profiles.map((profile) => [
      profile.profileId,
      valid &&
        (epoch?.profileEpochs[profile.profileId] ?? '') ===
          (record.generation.profileEpochs[profile.profileId] ?? '') &&
        observedUserMatches(profile, epoch),
    ]),
  );
  return { device: valid, profiles };
}
function observedUserMatches(
  profile: Pick<PhoneRegistryRecord['profiles'][number], 'profileId' | 'user'>,
  epoch: PhoneRegistryEpoch | undefined,
): boolean {
  if (!epoch?.observedUsers || epoch.unobservedProfiles?.includes(profile.profileId)) return true;
  const observed = epoch.observedUsers[profile.profileId];
  return observed !== undefined && sameAndroidUser(profile.user, observed);
}
function staleFields<T extends Record<string, PhoneRegistryValue | undefined>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value ? { ...value, state: 'stale' } : value]),
  ) as T;
}

/** Returns a private copy with invalid bindings marked stale; it never promotes a field to current. */
export function inspectRegistryBinding(
  record: PhoneRegistryRecord,
  epoch: PhoneRegistryEpoch | undefined,
  inventory: Inventory,
): PhoneRegistryRecord {
  const retained = validatePhoneRegistryRecord(record);
  const current = epoch ? validatePhoneRegistryEpoch(epoch) : undefined;
  const status = binding(retained, current, inventory);
  return {
    ...retained,
    fields: status.device ? retained.fields : staleFields(retained.fields),
    profiles: retained.profiles.map((profile) => ({
      ...profile,
      fields: status.profiles[profile.profileId] ? profile.fields : staleFields(profile.fields),
    })),
  };
}

function confirmedFields<T extends string>(
  values: Partial<Record<T, PhoneRegistryValueInput>>,
  options: PhoneRegistryUpdateOptions,
): Partial<Record<T, PhoneRegistryValue>> {
  const result: Partial<Record<T, PhoneRegistryValue>> = {};
  for (const [key, entry] of Object.entries(values) as [T, PhoneRegistryValueInput][]) {
    if (entry.state === 'current' && !options.confirmedCurrent)
      throw new Error('Explicit current credential confirmation is required');
    result[key] = {
      value: entry.value,
      state: entry.state,
      updatedAt: options.now,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.state === 'current' ? { confirmedAt: options.now } : {}),
    };
  }
  return result;
}
function assertUpdate(
  document: PhoneRegistryDocument,
  input: PhoneRegistryRecordInput,
  options: PhoneRegistryUpdateOptions,
): void {
  if (document.revision !== options.expectedRevision) throw new Error('Phone registry revision changed');
  const previous = document.devices.find((record) => record.assetId === input.assetId);
  if ((previous?.revision ?? null) !== options.expectedRecordRevision)
    throw new Error('Phone registry record revision changed');
  assertInventoryBinding(input, options);
  assertKnownUsers(input, options.generation);
}
function assertInventoryBinding(input: PhoneRegistryRecordInput, options: PhoneRegistryUpdateOptions): void {
  const matches = options.inventory.devices.filter(
    (device) =>
      device.assetId === input.assetId &&
      device.canonicalSerial === input.canonicalSerial &&
      device.codename === input.codename,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.kind !== 'pixel' ||
    options.generation.canonicalSerial !== input.canonicalSerial ||
    options.generation.codename !== input.codename
  )
    throw new Error('Phone registry identity differs from inventory');
}
function assertKnownUsers(input: PhoneRegistryRecordInput, generation: PhoneRegistryEpoch): void {
  for (const profile of input.profiles) {
    if (
      Object.values(profile.fields).some((entry) => entry?.state === 'current') &&
      !observedUserMatches(profile, generation)
    )
      throw new Error('Phone registry profile differs from retained Android user identity');
  }
}

/** Each supplied current value is an explicit operator claim, never a phone-side verification. */
export function upsertPhoneRegistryRecord(
  document: PhoneRegistryDocument,
  input: PhoneRegistryRecordInput,
  options: PhoneRegistryUpdateOptions,
): PhoneRegistryDocument {
  const retained = validatePhoneRegistryDocument(document);
  const supplied = validatePhoneRegistryRecordInput(input);
  const generation = validatePhoneRegistryEpoch(options.generation);
  assertUpdate(retained, supplied, options);
  const previous = retained.devices.find((record) => record.assetId === supplied.assetId);
  const record = validatePhoneRegistryRecord({
    assetId: supplied.assetId,
    canonicalSerial: supplied.canonicalSerial,
    codename: supplied.codename,
    revision: (previous?.revision ?? 0) + 1,
    generation: { deviceEpoch: generation.deviceEpoch, profileEpochs: generation.profileEpochs },
    fields: confirmedFields(supplied.fields, options),
    profiles: supplied.profiles.map((profile) => ({
      ...profile,
      fields: confirmedFields(profile.fields, options),
    })),
  });
  const revision = retained.revision + 1;
  return validatePhoneRegistryDocument({
    ...retained,
    revision,
    devices: [...retained.devices.filter((item) => item.assetId !== record.assetId), record],
    history: [...retained.history, { revision, recordedAt: options.now, record }],
  });
}

/** Explicit backup recovery retains history while making every recovered value stale. */
export function reconcilePhoneRegistryDocument(
  document: PhoneRegistryDocument,
  now: string,
): PhoneRegistryDocument {
  if (!validTime(now)) throw new Error('Invalid private phone registry reconciliation time');
  const retained = validatePhoneRegistryDocument(document);
  let revision = retained.revision;
  const snapshots = retained.devices.map((record) => ({
    revision: ++revision,
    recordedAt: now,
    record: {
      ...inspectRegistryBinding(record, undefined, { schemaVersion: 1, devices: [] }),
      revision: record.revision + 1,
    },
  }));
  return validatePhoneRegistryDocument({
    ...retained,
    revision,
    devices: snapshots.map((entry) => entry.record),
    history: [...retained.history, ...snapshots],
  });
}

function fieldSummary(values: Record<string, PhoneRegistryValue | undefined>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      {
        present: true,
        state: value?.state ?? 'unknown',
        confirmed: value?.state === 'current' && Boolean(value.confirmedAt),
      },
    ]),
  );
}

/** Use an absent epoch for historical snapshots so they cannot be described as current. */
export function phoneRegistryRecordSummary(
  record: PhoneRegistryRecord,
  epoch: PhoneRegistryEpoch | undefined,
  inventory: Inventory,
) {
  const inspected = inspectRegistryBinding(record, epoch, inventory);
  const status = binding(inspected, epoch, inventory);
  return {
    assetId: inspected.assetId,
    codename: inspected.codename,
    revision: inspected.revision,
    binding: status.device ? 'valid' : 'stale',
    fields: fieldSummary(inspected.fields),
    profiles: inspected.profiles.map((profile) => ({
      profileId: profile.profileId,
      userId: profile.user.userId,
      serialNo: profile.user.serialNo,
      binding: status.profiles[profile.profileId] ? 'valid' : 'stale',
      fields: fieldSummary(profile.fields),
    })),
  };
}

/** Explicit allowlist: no values, account IDs, phone numbers, hardware serials or source text. */
export function phoneRegistrySummary(
  document: PhoneRegistryDocument,
  epochs: ReadonlyMap<string, PhoneRegistryEpoch>,
  inventory: Inventory,
) {
  const retained = validatePhoneRegistryDocument(document);
  return {
    projectId: retained.projectId,
    revision: retained.revision,
    devices: retained.devices.map((record) =>
      phoneRegistryRecordSummary(record, epochs.get(record.assetId), inventory),
    ),
  };
}
