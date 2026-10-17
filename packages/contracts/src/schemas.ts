import { parseDocument as parseYamlDocument } from 'yaml';
import { z } from 'zod';
import { canonicalLocale } from './locales.js';
import type {
  Action,
  AndroidUserIdentity,
  ArtifactPolicy,
  DeviceObservation,
  ExtensionLock,
  HandoffRecord,
  Inventory,
  OperatorAttestation,
  ExecutionPolicy,
  PolicyDocument,
  ProductDescriptor,
  ProjectConfig,
  RecoveryObligation,
  ReviewedPlan,
  RunEvent,
  SharedApkEffect,
  RecipePolicy,
  NetworkProbePolicy,
  ResolvedPolicy,
  AcceptedHandoffSnapshot,
} from './types.js';

const nonempty = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Control characters are forbidden');
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u, 'Expected a lowercase identifier');
const packageId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u, 'Expected an Android package name');
const version = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    'An exact semantic version is required',
  );
const sha256 = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/u)
  .transform((value) => value.toLowerCase());
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const https = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }, 'An HTTPS URL without credentials or fragment is required');
const relativePath = nonempty.refine(
  (value) =>
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '' || part === '.') &&
    !/^[A-Za-z]:/u.test(value),
  'Expected a contained relative path',
);
const isoDate = z.string().datetime({ offset: true });
const locale = z.string().transform((value, context) => {
  try {
    return canonicalLocale(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected one explicit BCP 47 locale tag' });
    return z.NEVER;
  }
});
const uniqueStrings = (values: readonly string[]): boolean => new Set(values).size === values.length;
const distinct = <T>(values: readonly T[], key: (value: T) => string): boolean =>
  uniqueStrings(values.map(key));

export const transportSchema = z
  .object({ kind: z.enum(['usb', 'wifi', 'emulator']), serial: nonempty })
  .strict();
export const deviceTargetSchema = z
  .object({
    assetId: id,
    kind: z.enum(['pixel', 'emulator']),
    canonicalSerial: nonempty,
    model: nonempty,
    codename: id,
    transports: z.array(transportSchema).min(1),
    groups: z.array(id).refine(uniqueStrings, 'Duplicate group'),
    inputs: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]*$/u),
        z
          .object({
            path: relativePath.refine(
              (value) => value.startsWith('secrets/'),
              'Private inputs must be contained under secrets/',
            ),
            sha256,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!distinct(value.transports, (transport) => `${transport.kind}:${transport.serial}`))
      context.addIssue({ code: 'custom', message: 'Duplicate transport' });
    if (value.kind === 'emulator' && value.transports.some((transport) => transport.kind !== 'emulator'))
      context.addIssue({ code: 'custom', message: 'Emulators require emulator transports' });
    if (value.kind === 'pixel' && value.transports.some((transport) => transport.kind === 'emulator'))
      context.addIssue({ code: 'custom', message: 'Physical devices cannot use emulator transports' });
  });

export const inventorySchema = z
  .object({ schemaVersion: z.literal(1), devices: z.array(deviceTargetSchema) })
  .strict()
  .superRefine((value, context) => {
    if (!distinct(value.devices, (device) => device.assetId))
      context.addIssue({ code: 'custom', message: 'Duplicate asset ID' });
    if (!distinct(value.devices, (device) => device.canonicalSerial))
      context.addIssue({ code: 'custom', message: 'Duplicate physical device identity' });
    const transports = value.devices.flatMap((device) =>
      device.transports.map((transport) => transport.serial),
    );
    if (!uniqueStrings(transports))
      context.addIssue({ code: 'custom', message: 'A transport cannot identify multiple devices' });
    const inputs = value.devices.flatMap((device) => Object.values(device.inputs ?? {}));
    if (!distinct(inputs, (input) => input.path) || !distinct(inputs, (input) => input.sha256))
      context.addIssue({
        code: 'custom',
        message: 'Private input files and content must be unique per device',
      });
  });

export const androidUserIdentitySchema = z
  .object({ userId: integer, serialNo: integer, name: nonempty })
  .strict();
export const sharedApkEffectSchema = z
  .object({
    packageId,
    users: z.array(
      z.object({ user: androidUserIdentitySchema, versionCode: integer, signerSha256: sha256 }).strict(),
    ),
  })
  .strict()
  .refine(
    (value) =>
      distinct(value.users, (item) => String(item.user.userId)) &&
      distinct(value.users, (item) => String(item.user.serialNo)),
    'Duplicate shared APK user identity',
  );
export const artifactPolicySchema = z
  .object({
    packageId,
    versionCode: integer.positive(),
    sha256,
    signerSha256: sha256,
    path: nonempty.optional(),
    url: https.optional(),
    repositoryId: id.optional(),
    redirectHosts: z
      .array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u))
      .refine(uniqueStrings, 'Duplicate redirect host')
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.path ?? value.url ?? value.repositoryId),
    'An artifact requires a path, URL, or repository',
  );
export const settingPolicySchema = z
  .object({
    namespace: z.enum(['system', 'secure', 'global']),
    key: nonempty,
    value: z
      .string()
      .max(4096)
      .refine((value) => !value.includes('\0'), 'NUL is forbidden'),
  })
  .strict();
export const permissionPolicySchema = z
  .object({ packageId, permission: nonempty, granted: z.boolean() })
  .strict();
export const vpnPolicySchema = z
  .object({ packageId: packageId.nullable(), alwaysOn: z.boolean(), lockdown: z.boolean() })
  .strict()
  .refine((value) => !value.lockdown || value.alwaysOn, 'VPN lockdown requires always-on VPN')
  .refine(
    (value) => !(value.alwaysOn || value.lockdown) || value.packageId !== null,
    'VPN enforcement requires a package',
  );
export const uiSelectorSchema = z
  .object({
    resourceId: nonempty.max(200).optional(),
    text: nonempty.max(200).optional(),
    description: nonempty.max(200).optional(),
    checked: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.resourceId ?? value.text ?? value.description),
    'A UI selector requires an explicit identity',
  );
const timeoutMs = integer.positive().max(180_000).optional();
export const recipeStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['tap', 'wait']), selector: uiSelectorSchema, timeoutMs }).strict(),
  z
    .object({ action: z.literal('toggle'), selector: uiSelectorSchema, value: z.boolean(), timeoutMs })
    .strict(),
  z
    .object({
      action: z.literal('text'),
      selector: uiSelectorSchema.refine(
        (value) => Boolean(value.resourceId),
        'Text input requires a resource ID',
      ),
      value: z
        .string()
        .regex(/^[A-Za-z0-9._:/@+\-]{1,200}$/u, 'Only declared non-secret ASCII text is supported'),
      timeoutMs,
    })
    .strict(),
  z.object({ action: z.literal('back') }).strict(),
  z
    .object({
      action: z.enum(['stage-file', 'select-staged-file']),
      file: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    })
    .strict(),
]);
export const recipePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    packageId,
    versionCode: integer.positive(),
    signerSha256: sha256,
    buildFingerprint: nonempty,
    steps: z.array(recipeStepSchema).min(1).max(100),
    postconditions: z.array(uiSelectorSchema).min(1).max(100),
  })
  .strict();
export const networkProbePolicySchema = z
  .object({
    artifact: artifactPolicySchema.refine(
      (value) => value.packageId === 'org.pxv.probe',
      'A network probe requires the pinned probe helper',
    ),
    endpoint: https,
    expectedEgressCidrs: z
      .array(nonempty)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Duplicate expected egress CIDR'),
    requireVpn: z.boolean(),
    failurePackages: z.array(packageId).refine(uniqueStrings, 'Duplicate failure package'),
  })
  .strict();
function profilePackageReferences(value: z.infer<typeof profileBaseSchema>, context: z.RefinementCtx): void {
  for (const permission of value.permissions) {
    if (!value.packages.some((artifact) => artifact.packageId === permission.packageId))
      context.addIssue({
        code: 'custom',
        message: `Permission references undeclared package ${permission.packageId}`,
      });
  }
  if (
    value.vpn.packageId !== null &&
    !value.packages.some((artifact) => artifact.packageId === value.vpn.packageId)
  )
    context.addIssue({ code: 'custom', message: 'VPN references an undeclared package' });
}
function profileRecipeReferences(value: z.infer<typeof profileBaseSchema>, context: z.RefinementCtx): void {
  for (const recipe of value.recipes ?? []) {
    if (
      !value.packages.some(
        (artifact) =>
          artifact.packageId === recipe.packageId &&
          artifact.versionCode === recipe.versionCode &&
          artifact.signerSha256 === recipe.signerSha256,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Recipe app identity must match a declared pinned artifact',
      });
  }
}
function profileProbeReferences(value: z.infer<typeof profileBaseSchema>, context: z.RefinementCtx): void {
  if (
    value.networkProbe?.failurePackages.some(
      (packageName) => !value.packages.some((artifact) => artifact.packageId === packageName),
    )
  )
    context.addIssue({ code: 'custom', message: 'Probe failure package is not declared in the profile' });
  if (
    value.networkProbe?.failurePackages.length &&
    (!value.networkProbe.requireVpn || !value.vpn.alwaysOn || !value.vpn.lockdown)
  )
    context.addIssue({ code: 'custom', message: 'Probe failure exercises require enforced VPN lockdown' });
}
const defaultCredentialPolicySchema = z.object({ type: z.enum(['pin', 'password']), secretRef: id }).strict();
const defaultDuressPolicySchema = z.object({ ownerCredentialRef: id, pinRef: id, passwordRef: id }).strict();
function profileCredentialReferences(
  value: z.infer<typeof profileBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (!value.defaultDuress) return;
  if (value.kind !== 'owner')
    context.addIssue({ code: 'custom', message: 'Default duress requires the owner profile' });
}
const profileBaseSchema = z
  .object({
    id,
    name: nonempty,
    kind: z.enum(['owner', 'secondary']),
    packages: z.array(artifactPolicySchema),
    settings: z.array(settingPolicySchema),
    permissions: z.array(permissionPolicySchema),
    vpn: vpnPolicySchema,
    defaultCredential: defaultCredentialPolicySchema.optional(),
    defaultDuress: defaultDuressPolicySchema.optional(),
    defaultLocale: locale.optional(),
    language: locale.optional(),
    recipes: z
      .array(recipePolicySchema)
      .refine((value) => distinct(value, (recipe) => recipe.id), 'Duplicate recipe ID')
      .optional(),
    networkProbe: networkProbePolicySchema.optional(),
    backup: z.object({ enabled: z.boolean(), transportPackage: packageId }).strict().optional(),
  })
  .strict();
export const profilePolicySchema = profileBaseSchema.superRefine((value, context) => {
  if (value.defaultLocale && value.language && value.defaultLocale !== value.language)
    context.addIssue({ code: 'custom', message: 'Profile defaultLocale conflicts with alternate language' });
  if (!distinct(value.packages, (artifact) => artifact.packageId))
    context.addIssue({ code: 'custom', message: 'Duplicate profile package' });
  if (!distinct(value.settings, (setting) => `${setting.namespace}:${setting.key}`))
    context.addIssue({ code: 'custom', message: 'Duplicate profile setting' });
  if (!distinct(value.permissions, (permission) => `${permission.packageId}:${permission.permission}`))
    context.addIssue({ code: 'custom', message: 'Duplicate profile permission' });
  profilePackageReferences(value, context);
  profileRecipeReferences(value, context);
  profileProbeReferences(value, context);
  profileCredentialReferences(value, context);
});
export const repositoryPolicySchema = z
  .object({
    id,
    url: https,
    signerSha256: sha256,
    maxAgeDays: integer.positive().max(365),
    redirectHosts: z
      .array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u))
      .refine(uniqueStrings, 'Duplicate redirect host'),
  })
  .strict();
export const osPolicySchema = z
  .object({
    codename: id,
    release: nonempty,
    url: https,
    signatureUrl: https,
    signerPrincipal: nonempty,
    namespace: nonempty,
    publicKey: nonempty.refine(
      (value) => /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+=*(?: .*)?$/u.test(value),
      'Expected an OpenSSH public key',
    ),
  })
  .strict();

export const DEFAULT_ATTESTATIONS = [
  'routes',
  'network_failure_tests',
  'backup_recovery',
  'recipient_acceptance',
  'operator_signoff',
] as const;

function policyArtifactReferences(value: z.infer<typeof policyBaseSchema>, context: z.RefinementCtx): void {
  const shared = new Map<string, string>();
  for (const profile of value.profiles)
    for (const artifact of profile.packages) {
      if (
        artifact.repositoryId &&
        !value.repositories.some((repository) => repository.id === artifact.repositoryId)
      )
        context.addIssue({ code: 'custom', message: `Unknown repository ${artifact.repositoryId}` });
      const identity = `${artifact.versionCode}:${artifact.sha256}:${artifact.signerSha256}`;
      const existing = shared.get(artifact.packageId);
      if (existing !== undefined && existing !== identity)
        context.addIssue({ code: 'custom', message: `Conflicting device-wide APK ${artifact.packageId}` });
      shared.set(artifact.packageId, identity);
    }
}

function policyGlobalSettings(value: z.infer<typeof policyBaseSchema>, context: z.RefinementCtx): void {
  const globals = new Map<string, string>();
  for (const profile of value.profiles)
    for (const setting of profile.settings) {
      if (setting.namespace !== 'global') continue;
      const previous = globals.get(setting.key);
      if (previous !== undefined && previous !== setting.value)
        context.addIssue({ code: 'custom', message: `Conflicting device-wide setting ${setting.key}` });
      globals.set(setting.key, setting.value);
    }
}
function policyCredentialReferences(value: z.infer<typeof policyBaseSchema>, context: z.RefinementCtx): void {
  const normalRefs = new Set(
    value.profiles.flatMap((profile) => [
      ...(profile.defaultCredential ? [profile.defaultCredential.secretRef] : []),
      ...(profile.defaultDuress ? [profile.defaultDuress.ownerCredentialRef] : []),
    ]),
  );
  for (const profile of value.profiles) {
    const duress = profile.defaultDuress;
    if (duress && (normalRefs.has(duress.pinRef) || normalRefs.has(duress.passwordRef)))
      context.addIssue({ code: 'custom', message: 'Duress references must differ from normal credentials' });
  }
}

const policyBaseSchema = z
  .object({
    id,
    name: nonempty,
    profiles: z.array(profilePolicySchema).min(1),
    capabilities: z.array(id).refine(uniqueStrings, 'Duplicate capability'),
    requiredAttestations: z
      .array(id)
      .refine(uniqueStrings, 'Duplicate required attestation')
      .default([...DEFAULT_ATTESTATIONS]),
    repositories: z.array(repositoryPolicySchema),
    osByCodename: z.record(id, osPolicySchema).optional(),
  })
  .strict();
export const executionPolicySchema = policyBaseSchema.superRefine((value, context) => {
  if (value.profiles.filter((profile) => profile.kind === 'owner').length !== 1)
    context.addIssue({ code: 'custom', message: 'Exactly one owner profile is required' });
  if (!distinct(value.profiles, (profile) => profile.id))
    context.addIssue({ code: 'custom', message: 'Duplicate profile ID' });
  if (!distinct(value.profiles, (profile) => profile.name))
    context.addIssue({ code: 'custom', message: 'Duplicate Android user name' });
  if (!distinct(value.repositories, (repository) => repository.id))
    context.addIssue({ code: 'custom', message: 'Duplicate repository ID' });
  policyArtifactReferences(value, context);
  policyCredentialReferences(value, context);
  policyGlobalSettings(value, context);
  policyOsPins(value, context);
});

function policyOsPins(value: z.infer<typeof policyBaseSchema>, context: z.RefinementCtx): void {
  if (value.osByCodename) {
    if (!Object.keys(value.osByCodename).length)
      context.addIssue({ code: 'custom', message: 'OS model pins cannot be empty' });
    for (const [codename, pin] of Object.entries(value.osByCodename))
      if (codename !== pin.codename)
        context.addIssue({ code: 'custom', message: `OS model pin key differs from codename ${codename}` });
  }
}

const profileDocumentSchema = profileBaseSchema
  .omit({ packages: true })
  .extend({
    apps: z.array(id).refine(uniqueStrings, 'Duplicate profile app'),
    settings: z.array(
      settingPolicySchema.refine(
        (setting) => setting.namespace !== 'global',
        'Global settings belong in deviceSettings',
      ),
    ),
  })
  .strict();

const policyDocumentSchema = policyBaseSchema
  .omit({ profiles: true, osByCodename: true })
  .extend({
    apps: z.record(id, artifactPolicySchema),
    profiles: z.array(profileDocumentSchema).min(1),
    deviceSettings: z
      .array(
        settingPolicySchema.refine(
          (setting) => setting.namespace === 'global',
          'Device settings must use the global namespace',
        ),
      )
      .refine((settings) => distinct(settings, (setting) => setting.key), 'Duplicate device setting'),
    os: z.record(id, osPolicySchema).optional(),
  })
  .strict();

function normalizePolicy(document: PolicyDocument): ExecutionPolicy {
  const { apps, deviceSettings, os, profiles, ...base } = document;
  const identities = new Map<string, string>();
  for (const artifact of Object.values(apps)) {
    if (
      artifact.repositoryId &&
      !base.repositories.some((repository) => repository.id === artifact.repositoryId)
    )
      throw new Error(`Unknown repository ${artifact.repositoryId}`);
    const identity = `${artifact.versionCode}:${artifact.sha256}:${artifact.signerSha256}`;
    const existing = identities.get(artifact.packageId);
    if (existing !== undefined && existing !== identity)
      throw new Error(`Conflicting device-wide APK ${artifact.packageId}`);
    identities.set(artifact.packageId, identity);
  }
  const normalized = {
    ...base,
    profiles: profiles.map(({ apps: references, settings, ...profile }) => ({
      ...profile,
      packages: references.map((reference) => {
        const artifact = Object.hasOwn(apps, reference) ? apps[reference] : undefined;
        if (!artifact) throw new Error(`Unknown app catalog reference ${reference}`);
        return artifact;
      }),
      settings: profile.kind === 'owner' ? [...settings, ...deviceSettings] : settings,
    })),
    ...(os ? { osByCodename: os } : {}),
  };
  return parseContract(executionPolicySchema, normalized);
}

export const extensionLockSchema = z
  .object({
    id: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
    version,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u, 'Expected SHA-512 SRI'),
    apiVersion: z.literal(1),
    entry: relativePath.refine(
      (value) => /\.(?:m?js)$/u.test(value),
      'An extension entry must be compiled JavaScript',
    ),
    installPath: relativePath,
  })
  .strict();
export const projectConfigSchema = z
  .object({
    format: z.literal('pxv-ts'),
    schemaVersion: z.literal(1),
    id,
    productId: id,
    policyFile: relativePath,
    inventoryFile: relativePath,
    extensions: z
      .array(extensionLockSchema)
      .refine((value) => distinct(value, (extension) => extension.id), 'Duplicate extension'),
  })
  .strict();
export const productDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    name: nonempty,
    command: id,
    packageName: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
    debName: z.string().regex(/^[a-z0-9][a-z0-9+.-]+$/u),
    image: nonempty,
    upstreamVersion: z.literal('0.1.0'),
    engineApi: z.literal(1),
    assets: z.record(z.string(), relativePath),
    defaultPolicy: relativePath,
    features: z.object({ extensions: z.boolean(), seedvault: z.boolean() }).strict().optional(),
    support: z.object({ name: nonempty, email: z.string().email(), url: https }).strict(),
  })
  .strict();

export const resolvedPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.literal('0.1.0'),
    engineDigest: sha256,
    project: projectConfigSchema,
    product: productDescriptorSchema,
    policy: executionPolicySchema,
    digest: sha256,
  })
  .strict();
export const acceptedHandoffSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: id,
    recordId: nonempty,
    resolvedPolicy: resolvedPolicySchema,
  })
  .strict();

const profileObservationSchema = z
  .object({
    profileId: id,
    user: androidUserIdentitySchema,
    packages: z
      .array(z.object({ packageId, versionCode: integer, signerSha256: sha256 }).strict())
      .refine((value) => distinct(value, (item) => item.packageId), 'Duplicate observed package'),
    settings: z
      .array(settingPolicySchema)
      .refine(
        (value) => distinct(value, (item) => `${item.namespace}:${item.key}`),
        'Duplicate observed setting',
      ),
    permissions: z
      .array(permissionPolicySchema)
      .refine(
        (value) => distinct(value, (item) => `${item.packageId}:${item.permission}`),
        'Duplicate observed permission',
      ),
    vpn: vpnPolicySchema,
    language: locale.optional(),
    backup: z.object({ enabled: z.boolean(), transportPackage: packageId.nullable() }).strict().optional(),
  })
  .strict();
export const deviceObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    device: deviceTargetSchema,
    observedAt: isoDate,
    os: z.object({ codename: id, release: nonempty, bootVerified: z.boolean() }).strict(),
    profiles: z.array(profileObservationSchema),
    helpers: z
      .array(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+(?:@user:\d+:serial:\d+)?$/u),
      )
      .refine(uniqueStrings, 'Duplicate helper'),
    debuggingEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!distinct(value.profiles, (profile) => profile.profileId))
      context.addIssue({ code: 'custom', message: 'Duplicate observed profile' });
    if (!distinct(value.profiles, (profile) => String(profile.user.userId)))
      context.addIssue({ code: 'custom', message: 'Multiple profiles share a user ID' });
    if (!distinct(value.profiles, (profile) => String(profile.user.serialNo)))
      context.addIssue({ code: 'custom', message: 'Multiple profiles share a user serial' });
  });

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create-user'), profileId: id, name: nonempty }).strict(),
  z.object({ kind: z.literal('install-apk'), profileId: id, artifact: artifactPolicySchema }).strict(),
  z.object({ kind: z.literal('setting'), profileId: id, setting: settingPolicySchema }).strict(),
  z.object({ kind: z.literal('permission'), profileId: id, permission: permissionPolicySchema }).strict(),
  z.object({ kind: z.literal('vpn'), profileId: id, vpn: vpnPolicySchema }).strict(),
  z.object({ kind: z.literal('install-os'), os: osPolicySchema }).strict(),
  z.object({ kind: z.literal('language'), profileId: id, language: locale }).strict(),
  z
    .object({
      kind: z.literal('default-credential'),
      profileId: id,
      credential: defaultCredentialPolicySchema,
    })
    .strict(),
  z.object({ kind: z.literal('default-duress'), profileId: id, duress: defaultDuressPolicySchema }).strict(),
  z.object({ kind: z.literal('recipe'), profileId: id, recipe: recipePolicySchema }).strict(),
  z.object({ kind: z.literal('network-probe'), profileId: id, probe: networkProbePolicySchema }).strict(),
  z.object({ kind: z.literal('manual'), capability: id, instructions: nonempty }).strict(),
]);
export const reviewedPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    projectId: id,
    device: deviceTargetSchema,
    policyDigest: sha256,
    createdAt: isoDate,
    actions: z.array(actionSchema),
    digest: sha256,
  })
  .strict();
export const operatorAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    planDigest: sha256,
    observationDigest: sha256,
    check: id,
    operator: nonempty,
    recordedAt: isoDate,
    profileIds: z.array(id).refine(uniqueStrings, 'Duplicate attestation profile'),
    note: nonempty.optional(),
  })
  .strict();
export const recoveryObligationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    operationId: nonempty,
    ownerOperationId: nonempty,
    deviceSerial: nonempty,
    user: androidUserIdentitySchema.optional(),
    kind: id,
    resource: nonempty,
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(['pending', 'resolved', 'blocked']),
  })
  .strict();
export const runEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    runId: nonempty,
    sequence: integer,
    at: isoDate,
    type: id,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const handoffRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: nonempty,
    projectId: id,
    deviceSerial: nonempty,
    policyDigest: sha256,
    observationDigest: sha256,
    locale: z.enum(['en', 'pl']),
    outcome: z.enum(['subset', 'emulator', 'ready-for-handoff', 'completed-custody']),
    operator: nonempty,
    createdAt: isoDate,
    acceptedBy: nonempty.optional(),
    acceptedAt: isoDate.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'completed-custody' && (!value.acceptedBy || !value.acceptedAt))
      context.addIssue({ code: 'custom', message: 'Completed custody requires recipient acceptance' });
    if (Boolean(value.acceptedBy) !== Boolean(value.acceptedAt))
      context.addIssue({
        code: 'custom',
        message: 'Recipient and acceptance time must be recorded together',
      });
  });

/** Parse JSON or YAML while rejecting duplicate keys, aliases and multiple documents. */
export function parseDocument(source: string): unknown {
  const document = parseYamlDocument(source, { uniqueKeys: true, strict: true, stringKeys: true });
  if (document.errors.length > 0)
    throw new Error(`Invalid configuration: ${document.errors.map((error) => error.message).join('; ')}`);
  if (document.warnings.length > 0)
    throw new Error(
      `Unsupported configuration: ${document.warnings.map((warning) => warning.message).join('; ')}`,
    );
  return document.toJS({ maxAliasCount: 0 });
}

function parseContract<T>(schema: z.ZodType, value: unknown): T {
  const output: unknown = schema.parse(value);
  const rejectUndefined = (item: unknown): void => {
    if (item === undefined) throw new Error('Explicit undefined is not valid configuration');
    if (Array.isArray(item)) item.forEach(rejectUndefined);
    else if (item !== null && typeof item === 'object') Object.values(item).forEach(rejectUndefined);
  };
  rejectUndefined(output);
  // Zod represents optional fields as T | undefined. The recursive guard above ensures
  // these validated JSON contracts satisfy exactOptionalPropertyTypes as well.
  return output as T;
}

export function validatePolicyDocument(value: unknown): PolicyDocument {
  const document = parseContract<PolicyDocument>(policyDocumentSchema, value);
  normalizePolicy(document);
  return document;
}
export function validatePolicy(value: unknown): ExecutionPolicy {
  return normalizePolicy(validatePolicyDocument(value));
}
/** Validate expanded engine/lock data, never authored app-catalog documents. */
export const validateExecutionPolicy = (value: unknown): ExecutionPolicy =>
  parseContract(executionPolicySchema, value);
export const validateInventory = (value: unknown): Inventory => parseContract(inventorySchema, value);
export const validateProject = (value: unknown): ProjectConfig => parseContract(projectConfigSchema, value);
export const validateProduct = (value: unknown): ProductDescriptor =>
  parseContract(productDescriptorSchema, value);
export const validateExtension = (value: unknown): ExtensionLock => parseContract(extensionLockSchema, value);
export const validateUserIdentity = (value: unknown): AndroidUserIdentity =>
  parseContract(androidUserIdentitySchema, value);
export const validateArtifact = (value: unknown): ArtifactPolicy =>
  parseContract(artifactPolicySchema, value);
export const validateObservation = (value: unknown): DeviceObservation =>
  parseContract(deviceObservationSchema, value);
export const validateAction = (value: unknown): Action => parseContract(actionSchema, value);
export const validatePlan = (value: unknown): ReviewedPlan => parseContract(reviewedPlanSchema, value);
export const validateAttestation = (value: unknown): OperatorAttestation =>
  parseContract(operatorAttestationSchema, value);
export const validateObligation = (value: unknown): RecoveryObligation =>
  parseContract(recoveryObligationSchema, value);
export const validateRunEvent = (value: unknown): RunEvent => parseContract(runEventSchema, value);
export const validateHandoff = (value: unknown): HandoffRecord => parseContract(handoffRecordSchema, value);
export const validateSharedEffect = (value: unknown): SharedApkEffect =>
  parseContract(sharedApkEffectSchema, value);
export const validateRecipe = (value: unknown): RecipePolicy => parseContract(recipePolicySchema, value);
export const validateNetworkProbe = (value: unknown): NetworkProbePolicy =>
  parseContract(networkProbePolicySchema, value);
export const validateResolvedPolicy = (value: unknown): ResolvedPolicy =>
  parseContract(resolvedPolicySchema, value);
export const validateAcceptedHandoffSnapshot = (value: unknown): AcceptedHandoffSnapshot =>
  parseContract(acceptedHandoffSnapshotSchema, value);
