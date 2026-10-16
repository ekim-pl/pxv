import { z } from 'zod';
import type { AndroidUserIdentity } from './types.js';
import { androidUserIdentitySchema, uiSelectorSchema } from './schemas.js';

const text = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const token = z.string().regex(/^[a-f0-9]{1,16}$/u);
const selector = uiSelectorSchema.refine((value) => Boolean(value.resourceId), 'A resource ID is required');
const step = z.discriminatedUnion('action', [
  z
    .object({
      action: z.enum([
        'tap',
        'wait',
        'start-backup',
        'start-restore',
        'start-files-restore',
        'observe-files-running',
      ]),
      selector,
      timeoutMs: z.number().int().min(1).max(300000).optional(),
    })
    .strict(),
  z.object({ action: z.enum(['select-source', 'select-file-source']) }).strict(),
]);
const completion = z
  .object({
    apps: selector,
    files: selector,
    finalized: selector,
    idle: selector,
    generation: selector,
    fileGeneration: selector,
  })
  .strict();
const flow = z.object({ steps: z.array(step).max(200), completion }).strict();

/** An externally qualified, exact-build UI recipe. No production acceptance is shipped. */
export const seedvaultAdapterDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: text,
    buildFingerprint: text,
    package: z
      .object({
        packageId: z.literal('com.stevesoltys.seedvault'),
        versionCode: z.number().int().positive(),
        signerSha256: hash,
      })
      .strict(),
    acceptance: z.object({ path: text, sha256: hash }).strict(),
    activities: z.array(text).min(1).max(20),
    restoreSourceResourceId: text,
    restoreFileSourceResourceId: text,
    backup: flow,
    restore: flow,
  })
  .strict()
  .refine(
    (value) =>
      orderedSteps(value.backup.steps, ['start-backup', 'observe-files-running']) &&
      orderedSteps(value.restore.steps, [
        'select-source',
        'start-restore',
        'select-file-source',
        'start-files-restore',
        'observe-files-running',
      ]),
    'Each flow must observe fresh files running after its explicit start trigger; restore must select the reviewed source for apps and files before each restore trigger',
  );
export type SeedvaultAdapterDefinition = z.infer<typeof seedvaultAdapterDefinitionSchema>;
export const seedvaultSourceProfileSchema = z
  .object({
    profileId: text,
    token,
    selector: selector.refine(
      (value) => Boolean(value.text),
      'Restore source requires an exact public generation label',
    ),
    filesSelector: selector.refine(
      (value) => Boolean(value.text),
      'Restore files source requires an exact public generation label',
    ),
  })
  .strict();
export type SeedvaultSourceProfile = z.infer<typeof seedvaultSourceProfileSchema>;
export const seedvaultRequestSchema = z
  .object({
    operation: z.enum(['backup', 'restore']),
    adapter: seedvaultAdapterDefinitionSchema.optional(),
    sources: z.array(seedvaultSourceProfileSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === 'restore' && !value.sources?.length)
      context.addIssue({ code: 'custom', message: 'Restore requires explicit profile sources' });
    const ids = value.sources?.map((source) => source.profileId) ?? [];
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Duplicate source profile' });
  });
export type SeedvaultRequest = z.infer<typeof seedvaultRequestSchema>;
export const validateSeedvaultRequest = (value: unknown): SeedvaultRequest =>
  seedvaultRequestSchema.parse(defined(value));
export const validateSeedvaultAdapter = (value: unknown): SeedvaultAdapterDefinition =>
  seedvaultAdapterDefinitionSchema.parse(defined(value));
function orderedSteps(steps: { action: string }[], actions: string[]): boolean {
  const indexes = actions.map((action) => steps.findIndex((step) => step.action === action));
  return indexes.every((position, index) => position >= 0 && (index === 0 || position > indexes[index - 1]!));
}

export interface SeedvaultProfileIdentity {
  profileId: string;
  user: AndroidUserIdentity;
  package: { packageId: string; versionCode: number; signerSha256: string };
  backup: { enabled: boolean; transportPackage: string | null };
  unlocked: boolean;
}
export interface SeedvaultInspection {
  deviceSerial: string;
  osFingerprint: string;
  foregroundUserId: number;
  profiles: SeedvaultProfileIdentity[];
  unsupportedUsers: AndroidUserIdentity[];
}
export interface SeedvaultProfileProgress {
  phase: 'prepared' | 'running' | 'completed';
  beforeTokens: string[];
  obligationIds: string[];
  adapterDigest: string;
  step: number;
  inFlight?: number;
  previousForeground: AndroidUserIdentity;
}
export interface SeedvaultProfileEvidence {
  profileId: string;
  user: AndroidUserIdentity;
  operation: 'backup' | 'restore';
  token: string;
  observedAt: string;
  adapterDigest: string;
  apps: true;
  files: true;
  finalized: true;
  source: SeedvaultSourceProfile;
  coverage?: {
    scope: 'representative-ui-only';
    exclusions: 'not-enumerated';
    contentVerification: 'owner-required';
  };
}
export type SeedvaultProfileResult =
  | { status: 'measured'; evidence: SeedvaultProfileEvidence; progress: SeedvaultProfileProgress }
  | { status: 'manual-pending'; instructions: string; progress?: SeedvaultProfileProgress };

const packageIdentity = z
  .object({ packageId: text, versionCode: z.number().int().positive(), signerSha256: hash })
  .strict();
export const seedvaultAcceptanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterId: text,
    buildFingerprint: text,
    package: packageIdentity,
    recipeDigest: hash,
    testedAt: z.string().datetime({ offset: true }),
    result: z.literal('pass'),
    profiles: z
      .array(
        z
          .object({
            profileId: text,
            userSerialNo: z.number().int().nonnegative(),
            evidenceSha256: hash,
            appsBackup: z.literal(true),
            apksBackup: z.literal(true),
            filesBackup: z.literal(true),
            appsRestore: z.literal(true),
            apksRestore: z.literal(true),
            filesRestore: z.literal(true),
            finalized: z.literal(true),
            durableGeneration: z.literal(true),
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.profiles.map((profile) => profile.profileId)).size === value.profiles.length &&
      new Set(value.profiles.map((profile) => profile.userSerialNo)).size === value.profiles.length,
    'Acceptance requires distinct stable Android profiles',
  );
export type SeedvaultAcceptance = z.infer<typeof seedvaultAcceptanceSchema>;
export const validateSeedvaultAcceptance = (value: unknown): SeedvaultAcceptance =>
  seedvaultAcceptanceSchema.parse(defined(value));
const profileIdentity = z
  .object({
    profileId: text,
    user: androidUserIdentitySchema,
    package: packageIdentity,
    backup: z.object({ enabled: z.boolean(), transportPackage: text.nullable() }).strict(),
    unlocked: z.boolean(),
  })
  .strict();
export const seedvaultInspectionSchema = z
  .object({
    deviceSerial: text,
    osFingerprint: text,
    foregroundUserId: z.number().int().nonnegative(),
    profiles: z.array(profileIdentity).min(1),
    unsupportedUsers: z.array(androidUserIdentitySchema),
  })
  .strict();
export const seedvaultProgressSchema = z
  .object({
    phase: z.enum(['prepared', 'running', 'completed']),
    beforeTokens: z.array(token),
    obligationIds: z
      .array(text)
      .length(2)
      .refine((values) => new Set(values).size === 2),
    adapterDigest: hash,
    step: z.number().int().nonnegative().max(200),
    inFlight: z.number().int().nonnegative().max(200).optional(),
    previousForeground: androidUserIdentitySchema,
  })
  .strict();
export const seedvaultEvidenceSchema = z
  .object({
    profileId: text,
    user: androidUserIdentitySchema,
    operation: z.enum(['backup', 'restore']),
    token,
    observedAt: z.string().datetime({ offset: true }),
    adapterDigest: hash,
    apps: z.literal(true),
    files: z.literal(true),
    finalized: z.literal(true),
    source: seedvaultSourceProfileSchema,
    coverage: z
      .object({
        scope: z.literal('representative-ui-only'),
        exclusions: z.literal('not-enumerated'),
        contentVerification: z.literal('owner-required'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SeedvaultProgress = SeedvaultProfileProgress;
export type SeedvaultEvidence = SeedvaultProfileEvidence;
export const validateSeedvaultInspection = (value: unknown): SeedvaultInspection =>
  seedvaultInspectionSchema.parse(defined(value));
export const validateSeedvaultProgress = (value: unknown): SeedvaultProfileProgress =>
  seedvaultProgressSchema.parse(defined(value)) as SeedvaultProfileProgress;
export const validateSeedvaultEvidence = (value: unknown): SeedvaultProfileEvidence =>
  seedvaultEvidenceSchema.parse(defined(value)) as SeedvaultProfileEvidence;
function defined(value: unknown): unknown {
  if (value === undefined) throw new Error('Explicit undefined is not valid Seedvault configuration');
  if (value !== null && typeof value === 'object') Object.values(value).forEach(defined);
  return value;
}
