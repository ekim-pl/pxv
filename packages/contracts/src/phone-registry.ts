import { z } from 'zod';
import type { AndroidUserIdentity } from './types.js';

export const PHONE_REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
export const PHONE_REGISTRY_DEVICE_FIELDS = ['duressPin', 'duressPassword', 'phoneNumber'] as const;
export const PHONE_REGISTRY_PROFILE_FIELDS = [
  'pin',
  'password',
  'oblivionNotificationWipeKey',
  'sessionMessengerId',
  'protonVpnUsername',
  'protonVpnPassword',
  'phoneNumber',
] as const;
export type PhoneRegistryDeviceField = (typeof PHONE_REGISTRY_DEVICE_FIELDS)[number];
export type PhoneRegistryProfileField = (typeof PHONE_REGISTRY_PROFILE_FIELDS)[number];
export type PhoneRegistryValueState = 'initial' | 'current' | 'unknown' | 'stale';

export interface PhoneRegistryValue {
  value: string;
  state: PhoneRegistryValueState;
  source?: string;
  updatedAt: string;
  confirmedAt?: string;
}
export interface PhoneRegistryValueInput extends Omit<PhoneRegistryValue, 'updatedAt'> {
  updatedAt?: string;
}
export interface PhoneRegistryGeneration {
  deviceEpoch: string;
  profileEpochs: Record<string, string>;
}
export interface PhoneRegistryEpoch extends PhoneRegistryGeneration {
  canonicalSerial: string;
  codename: string;
  observedUsers?: Record<string, AndroidUserIdentity>;
  unobservedProfiles?: string[];
}
export interface PhoneRegistryProfile {
  profileId: string;
  user: AndroidUserIdentity;
  fields: Partial<Record<PhoneRegistryProfileField, PhoneRegistryValue>>;
}
export interface PhoneRegistryRecord {
  assetId: string;
  canonicalSerial: string;
  codename: string;
  revision: number;
  generation: PhoneRegistryGeneration;
  fields: Partial<Record<PhoneRegistryDeviceField, PhoneRegistryValue>>;
  profiles: PhoneRegistryProfile[];
}
export interface PhoneRegistryRecordInput {
  assetId: string;
  canonicalSerial: string;
  codename: string;
  fields: Partial<Record<PhoneRegistryDeviceField, PhoneRegistryValueInput>>;
  profiles: {
    profileId: string;
    user: AndroidUserIdentity;
    fields: Partial<Record<PhoneRegistryProfileField, PhoneRegistryValueInput>>;
  }[];
}
export interface PhoneRegistryHistoryEntry {
  revision: number;
  recordedAt: string;
  record: PhoneRegistryRecord;
}
export interface PhoneRegistryDocument {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  devices: PhoneRegistryRecord[];
  history: PhoneRegistryHistoryEntry[];
}

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const label = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().min(0).max(10_000);
const user = z
  .object({
    userId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    serialNo: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    name: label,
  })
  .strict();
const valueBase = z
  .object({
    value: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes('\0')),
    state: z.enum(['initial', 'current', 'unknown', 'stale']),
    source: label.optional(),
    updatedAt: timestamp,
    confirmedAt: timestamp.optional(),
  })
  .strict();
const valueSchema = valueBase.refine((value) => value.state !== 'current' || Boolean(value.confirmedAt));
const inputValueSchema = valueBase.extend({ updatedAt: timestamp.optional() });
function fields<T extends readonly string[]>(names: T, schema: z.ZodType) {
  return z.object(Object.fromEntries(names.map((name) => [name, schema.optional()]))).strict();
}
const epoch = z.string().regex(/^(?:[a-f0-9]{64})?$/u);
const profileEpoch = z.string().regex(/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/u);
const generation = z
  .object({
    deviceEpoch: epoch,
    profileEpochs: z.record(id, profileEpoch).refine((value) => Object.keys(value).length <= 128),
  })
  .strict();
const profileSchema = z
  .object({
    profileId: id,
    user,
    fields: fields(PHONE_REGISTRY_PROFILE_FIELDS, valueSchema),
  })
  .strict();
const inputProfileSchema = profileSchema.extend({
  fields: fields(PHONE_REGISTRY_PROFILE_FIELDS, inputValueSchema),
});
function uniqueProfiles(profiles: { profileId: string; user: AndroidUserIdentity }[]): boolean {
  return (
    new Set(profiles.map((profile) => profile.profileId)).size === profiles.length &&
    new Set(profiles.map((profile) => profile.user.userId)).size === profiles.length &&
    new Set(profiles.map((profile) => profile.user.serialNo)).size === profiles.length
  );
}
const recordSchema = z
  .object({
    assetId: id,
    canonicalSerial: label,
    codename: id,
    revision: revision.refine((value) => value > 0),
    generation,
    fields: fields(PHONE_REGISTRY_DEVICE_FIELDS, valueSchema),
    profiles: z.array(profileSchema).max(64).refine(uniqueProfiles),
  })
  .strict();
const inputSchema = recordSchema
  .omit({ revision: true, generation: true })
  .extend({
    fields: fields(PHONE_REGISTRY_DEVICE_FIELDS, inputValueSchema),
    profiles: z.array(inputProfileSchema).max(64).refine(uniqueProfiles),
  })
  .strict();
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: label,
    revision,
    devices: z.array(recordSchema).max(1000),
    history: z
      .array(
        z
          .object({
            revision: revision.refine((value) => value > 0),
            recordedAt: timestamp,
            record: recordSchema,
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

/** No parser error may echo private values or unrecognized input keys. */
function parsePrivate<T>(schema: z.ZodType, value: unknown): T {
  try {
    const bytes = JSON.stringify(value);
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > PHONE_REGISTRY_MAX_BYTES) throw new Error();
    rejectUndefined(value);
    return schema.parse(value) as T;
  } catch {
    throw new Error('Invalid private phone registry data');
  }
}
function rejectUndefined(value: unknown): void {
  if (value === undefined) throw new Error();
  if (Array.isArray(value)) value.forEach(rejectUndefined);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(rejectUndefined);
}

export function validatePhoneRegistryRecordInput(value: unknown): PhoneRegistryRecordInput {
  return parsePrivate(inputSchema, value);
}
export function validatePhoneRegistryRecord(value: unknown): PhoneRegistryRecord {
  return parsePrivate(recordSchema, value);
}
export function validatePhoneRegistryEpoch(value: unknown): PhoneRegistryEpoch {
  return parsePrivate(
    generation
      .extend({
        canonicalSerial: label,
        codename: id,
        observedUsers: z
          .record(id, user)
          .refine((values) => Object.keys(values).length <= 128)
          .optional(),
        unobservedProfiles: z
          .array(id)
          .max(128)
          .refine((values) => new Set(values).size === values.length)
          .optional(),
      })
      .strict()
      .refine((epoch) =>
        (epoch.unobservedProfiles ?? []).every(
          (profileId) =>
            Object.hasOwn(epoch.profileEpochs, profileId) && Boolean(epoch.profileEpochs[profileId]),
        ),
      ),
    value,
  );
}
export function validatePhoneRegistryDocument(value: unknown): PhoneRegistryDocument {
  const document = parsePrivate<PhoneRegistryDocument>(documentSchema, value);
  validateHistory(document);
  validateIdentities(document);
  return document;
}
function validateHistory(document: PhoneRegistryDocument): void {
  const latest = new Map<string, PhoneRegistryRecord>();
  for (const [index, entry] of document.history.entries()) {
    if (entry.revision !== index + 1) throw new Error('Invalid private phone registry history');
    const previous = latest.get(entry.record.assetId);
    if (entry.record.revision !== (previous?.revision ?? 0) + 1)
      throw new Error('Invalid private phone registry history');
    latest.set(entry.record.assetId, entry.record);
  }
  if (document.revision !== document.history.length || document.devices.length !== latest.size)
    throw new Error('Invalid private phone registry history');
  for (const record of document.devices)
    if (JSON.stringify(record) !== JSON.stringify(latest.get(record.assetId)))
      throw new Error('Invalid private phone registry history');
}
function validateIdentities(document: PhoneRegistryDocument): void {
  const identities = new Set(document.devices.map((record) => record.canonicalSerial));
  const assets = new Set(document.devices.map((record) => record.assetId));
  if (identities.size !== document.devices.length || assets.size !== document.devices.length)
    throw new Error('Invalid private phone registry identity');
}
