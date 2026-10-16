import { createHash } from 'node:crypto';
import { profileLocale } from './locales.js';
import {
  validateInventory,
  validateObservation,
  validatePolicy,
  validateProduct,
  validateProject,
  validateResolvedPolicy,
} from './schemas.js';
import type {
  Action,
  AndroidUserIdentity,
  DeviceObservation,
  DeviceTarget,
  Inventory,
  ObservationCheck,
  ObservationReport,
  PolicyPack,
  ProfilePolicy,
  ProductDescriptor,
  ProjectConfig,
  ReadinessRequirement,
  RecoveryObligation,
  ResolvedPolicy,
  SelectedTarget,
  TargetSelector,
  Transport,
} from './types.js';

/** Canonical JSON rejects values JSON would silently discard or alter. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Canonical data cannot contain non-finite numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('Canonical data must contain only JSON values');
    if (ancestors.has(item)) throw new Error('Canonical data cannot contain cycles');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length)
        throw new Error('Canonical data cannot contain sparse or decorated arrays');
      result = `[${item.map(encode).join(',')}]`;
    } else {
      result = encodeObject(item);
    }
    ancestors.delete(item);
    return result;
  };
  const encodeObject = (item: object): string => {
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error('Canonical data requires plain objects');
    if (Reflect.ownKeys(item).some((key) => typeof key !== 'string'))
      throw new Error('Canonical data cannot contain symbol keys');
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  };
  return encode(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function resolvePolicy(
  policy: PolicyPack,
  project: ProjectConfig,
  product: ProductDescriptor,
  engineDigest = digest({ version: '0.1.0', api: 1 }),
): ResolvedPolicy {
  if (!/^[a-f0-9]{64}$/u.test(engineDigest)) throw new Error('Engine content digest must be SHA-256');
  const validatedProject = validateProject(project);
  const validatedProduct = validateProduct(product);
  if (validatedProject.productId !== validatedProduct.id)
    throw new Error('Project product ID does not match this build');
  const lock = {
    schemaVersion: 1 as const,
    engineVersion: '0.1.0' as const,
    engineDigest,
    project: validatedProject,
    product: validatedProduct,
    policy: validatePolicy(policy),
  };
  return { ...lock, digest: digest(lock) };
}

export function verifyResolvedPolicy(value: unknown): ResolvedPolicy {
  const retained = validateResolvedPolicy(value);
  const resolved = resolvePolicy(retained.policy, retained.project, retained.product, retained.engineDigest);
  if (resolved.digest !== retained.digest) throw new Error('Retained policy snapshot digest mismatch');
  return resolved;
}

function chooseTransport(device: DeviceTarget, preferred?: Transport['kind']): Transport {
  const matching = preferred
    ? device.transports.filter((transport) => transport.kind === preferred)
    : device.transports;
  if (matching.length === 0)
    throw new Error(`No ${preferred ?? 'available'} transport for ${device.assetId}`);
  if (matching.length === 1 && matching[0]) return matching[0];
  if (!preferred) {
    const usb = matching.filter((transport) => transport.kind === 'usb');
    if (usb.length === 1 && usb[0]) return usb[0];
  }
  throw new Error(`Ambiguous transport for ${device.assetId}; select a transport explicitly`);
}

/** 'all' is a normal asset identifier. Fleet selection is a separate tagged value. */
export function resolveSelection(
  inventory: Inventory,
  selector: TargetSelector,
  preferredTransport?: Transport['kind'],
): SelectedTarget[] {
  const devices = validateInventory(inventory).devices;
  let selected: DeviceTarget[];
  switch (selector.kind) {
    case 'asset':
      selected = devices.filter((device) => device.assetId === selector.assetId);
      break;
    case 'group':
      selected = devices.filter((device) => device.groups.includes(selector.group));
      break;
    case 'fleet':
      selected = devices;
      break;
    default:
      throw new Error('Unsupported target selector');
  }
  if (selected.length === 0) throw new Error('Target selection is empty');
  return selected.map((device) => ({ device, transport: chooseTransport(device, preferredTransport) }));
}

/** Exclude only collection time; every measured security property invalidates old evidence. */
export function observationDigest(observation: DeviceObservation): string {
  const validated = validateObservation(observation);
  const { observedAt: _observedAt, ...evidence } = validated;
  void _observedAt;
  // ADB listings have no stable order. Canonicalize sets without excluding any measurement.
  return digest({
    ...evidence,
    device: {
      ...evidence.device,
      groups: [...evidence.device.groups].sort(),
      transports: [...evidence.device.transports].sort((a, b) =>
        `${a.kind}:${a.serial}`.localeCompare(`${b.kind}:${b.serial}`),
      ),
    },
    helpers: [...evidence.helpers].sort(),
    profiles: [...evidence.profiles]
      .sort((a, b) => a.profileId.localeCompare(b.profileId))
      .map((profile) => ({
        ...profile,
        packages: [...profile.packages].sort((a, b) => a.packageId.localeCompare(b.packageId)),
        settings: [...profile.settings].sort((a, b) =>
          `${a.namespace}:${a.key}`.localeCompare(`${b.namespace}:${b.key}`),
        ),
        permissions: [...profile.permissions].sort((a, b) =>
          `${a.packageId}:${a.permission}`.localeCompare(`${b.packageId}:${b.permission}`),
        ),
      })),
  });
}

type ObservationChecker = (key: string, expected: unknown, actual: unknown) => void;
type ObservedProfile = DeviceObservation['profiles'][number];
function checkPackages(profile: ProfilePolicy, actual: ObservedProfile, check: ObservationChecker): void {
  for (const artifact of profile.packages) {
    const installed = actual.packages.find((item) => item.packageId === artifact.packageId);
    check(
      `${profile.id}.package.${artifact.packageId}.version`,
      artifact.versionCode,
      installed?.versionCode,
    );
    check(
      `${profile.id}.package.${artifact.packageId}.signer`,
      artifact.signerSha256,
      installed?.signerSha256,
    );
  }
}
function checkProfile(profile: ProfilePolicy, actual: ObservedProfile, check: ObservationChecker): void {
  check(`${profile.id}.name`, profile.name, actual.user.name);
  check(`${profile.id}.owner`, profile.kind === 'owner', actual.user.userId === 0);
  checkPackages(profile, actual, check);
  for (const setting of profile.settings) {
    const observed = actual.settings.find(
      (item) => item.namespace === setting.namespace && item.key === setting.key,
    );
    check(`${profile.id}.setting.${setting.namespace}.${setting.key}`, setting.value, observed?.value);
  }
  for (const permission of profile.permissions) {
    const observed = actual.permissions.find(
      (item) => item.packageId === permission.packageId && item.permission === permission.permission,
    );
    check(
      `${profile.id}.permission.${permission.packageId}.${permission.permission}`,
      permission.granted,
      observed?.granted,
    );
  }
  check(`${profile.id}.vpn`, profile.vpn, actual.vpn);
  const locale = profileLocale(profile);
  if (locale) check(`${profile.id}.language`, locale, actual.language);
  if (profile.backup) check(`${profile.id}.backup`, profile.backup, actual.backup);
}

/** Shared by attestation and finalization; operator receipts cannot change failed checks. */
export function evaluateObservation(
  input: PolicyPack | ResolvedPolicy,
  observation: DeviceObservation,
): ObservationReport {
  const policy = validatePolicy('policy' in input ? input.policy : input);
  const measured = validateObservation(observation);
  const checks: ObservationCheck[] = [];
  const check = (key: string, expected: unknown, actual: unknown): void => {
    const present = actual === undefined ? null : actual;
    checks.push({
      key,
      expected,
      actual: present,
      passed: canonicalJson(expected) === canonicalJson(present),
    });
  };
  check('device.codename', measured.device.codename, measured.os.codename);
  if (policy.os) {
    check('os.codename', policy.os.codename, measured.os.codename);
    check('os.release', policy.os.release, measured.os.release);
  }
  if (measured.device.kind === 'pixel') check('os.verified_boot', true, measured.os.bootVerified);
  for (const profile of policy.profiles) {
    const actual = measured.profiles.find((item) => item.profileId === profile.id);
    check(`${profile.id}.present`, true, actual !== undefined);
    if (!actual) continue;
    checkProfile(profile, actual, check);
  }
  return {
    schemaVersion: 1,
    policyDigest: 'policy' in input ? input.digest : digest(policy),
    observationDigest: observationDigest(measured),
    checks,
    passed: checks.every((item) => item.passed),
  };
}

/** Compare all three fields; reused user IDs and names are not sufficient identity. */
export function sameAndroidUser(expected: AndroidUserIdentity, actual: AndroidUserIdentity): boolean {
  return (
    expected.userId === actual.userId &&
    expected.serialNo === actual.serialNo &&
    expected.name === actual.name
  );
}

/** A nested operation can resolve only obligations it owns. */
export function ownedObligations(
  obligations: readonly RecoveryObligation[],
  operationId: string,
): RecoveryObligation[] {
  return obligations.filter(
    (obligation) => obligation.ownerOperationId === operationId && obligation.status !== 'resolved',
  );
}

function normalCredentialsRequired(policy: PolicyPack): boolean {
  return (
    policy.capabilities.includes('normal_credentials') ||
    policy.profiles.some(
      (profile) => profileLocale(profile) || profile.defaultCredential || profile.defaultDuress,
    )
  );
}
function duressRequired(policy: PolicyPack): boolean {
  return policy.capabilities.includes('duress') || policy.profiles.some((profile) => profile.defaultDuress);
}
export function requiredAttestations(
  policy: PolicyPack,
  deviceKind: DeviceTarget['kind'] = 'pixel',
): string[] {
  const result = new Set(policy.requiredAttestations);
  result.delete('verified_boot');
  result.delete('emulator_image_provenance');
  result.add(deviceKind === 'emulator' ? 'emulator_image_provenance' : 'verified_boot');
  result.add('recipient_acceptance');
  result.add('operator_signoff');
  if (normalCredentialsRequired(policy)) result.add('normal_credentials');
  if (duressRequired(policy)) result.add('duress');
  if (policy.profiles.some((profile) => profile.recipes?.length)) result.add('app_setup');
  if (policy.profiles.some((profile) => profile.networkProbe)) {
    result.add('routes');
    result.add('network_failure_tests');
  }
  if (policy.profiles.some((profile) => profile.backup)) result.add('backup_recovery');
  return [...result].sort();
}

const requirementText: Record<string, { en: string; pl: string }> = {
  verified_boot: {
    en: 'Verify the locked bootloader and verified boot state on the physical phone.',
    pl: 'Sprawdź zablokowany program rozruchowy oraz stan zweryfikowanego rozruchu telefonu.',
  },
  emulator_image_provenance: {
    en: 'Record the emulator image source, build identity and verified image digest.',
    pl: 'Zapisz źródło obrazu emulatora, identyfikator kompilacji i zweryfikowaną sumę obrazu.',
  },
  routes: {
    en: 'Verify expected application network routes in each selected profile.',
    pl: 'Sprawdź oczekiwane trasy sieciowe aplikacji w każdym wybranym profilu.',
  },
  network_failure_tests: {
    en: 'Verify network failure, lockdown and recovery without changing recipient secrets.',
    pl: 'Sprawdź awarię sieci, blokadę ruchu i przywrócenie działania bez zmieniania sekretów odbiorcy.',
  },
  backup_recovery: {
    en: 'Observe a representative restore and let the recipient retain recovery material privately.',
    pl: 'Obserwuj reprezentatywne odtworzenie kopii; materiały odzyskiwania pozostają wyłącznie u odbiorcy.',
  },
  recipient_acceptance: {
    en: 'The recipient privately completes credentials, accounts and MFA, then accepts custody.',
    pl: 'Odbiorca samodzielnie ustawia dane uwierzytelniające, konta i MFA, a następnie potwierdza odbiór.',
  },
  operator_signoff: {
    en: 'Review fresh measurements, recovery obligations, helper removal and debugging shutdown.',
    pl: 'Sprawdź aktualne pomiary, obowiązki odzyskiwania, usunięcie pomocników i wyłączenie debugowania.',
  },
  normal_credentials: {
    en: 'The recipient privately sets and verifies normal credentials, or verifies or replaces configured defaults, before language or duress setup.',
    pl: 'Odbiorca samodzielnie ustawia i sprawdza zwykłe dane uwierzytelniające lub sprawdza albo zmienia ustawione wartości domyślne przed językiem lub przymusem.',
  },
  duress: {
    en: 'The recipient privately completes optional duress setup after normal credentials and language, confirming both duress values differ from every actual normal credential. Never activate destructive duress.',
    pl: 'Odbiorca samodzielnie kończy opcjonalną konfigurację przymusu po zwykłych danych uwierzytelniających i języku oraz potwierdza, że obie wartości przymusu różnią się od wszystkich aktualnych zwykłych danych uwierzytelniających. Nigdy nie uruchamiaj destrukcyjnego przymusu.',
  },
};

export function buildReadinessRequirements(
  policy: PolicyPack,
  deviceKind: DeviceTarget['kind'] = 'pixel',
): ReadinessRequirement[] {
  return requiredAttestations(policy, deviceKind).map((id) => ({
    id,
    kind: 'operator',
    profileIds: [
      'verified_boot',
      'emulator_image_provenance',
      'recipient_acceptance',
      'operator_signoff',
    ].includes(id)
      ? []
      : policy.profiles
          .filter((profile) => id !== 'duress' || profile.kind === 'owner')
          .map((profile) => profile.id),
    instructions: requirementText[id] ?? {
      en: `Complete policy check: ${id}.`,
      pl: `Wykonaj kontrolę polityki: ${id}.`,
    },
  }));
}

/** Private normal credentials precede language setup; duress is always last and never activated. */
export function finalSetupActions(policy: PolicyPack): Action[] {
  const actions: Action[] = [];
  for (const profile of policy.profiles)
    if (profile.defaultCredential)
      actions.push({
        kind: 'default-credential',
        profileId: profile.id,
        credential: profile.defaultCredential,
      });
  if (normalCredentialsRequired(policy)) {
    actions.push({
      kind: 'manual',
      capability: 'normal_credentials',
      instructions: `Recipient privately sets and verifies normal credentials for every selected profile: ${policy.profiles.map((profile) => profile.id).join(', ')}. Privately verify or replace configured defaults. Confirm all profiles before proceeding to language setup. Do not record any value.`,
    });
  }
  for (const profile of policy.profiles) {
    const locale = profileLocale(profile);
    if (locale) actions.push({ kind: 'language', profileId: profile.id, language: locale });
  }
  const owner = policy.profiles.find((profile) => profile.kind === 'owner');
  if (owner?.defaultDuress)
    actions.push({ kind: 'default-duress', profileId: owner.id, duress: owner.defaultDuress });
  if (duressRequired(policy))
    actions.push({
      kind: 'manual',
      capability: 'duress',
      instructions:
        'Recipient privately completes optional duress configuration after normal credentials and language. Confirm both duress values differ from every actual normal profile credential. Never activate or test destructive duress.',
    });
  return actions;
}
