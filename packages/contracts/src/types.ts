/** Public, versioned contracts. These types contain no runtime or transport implementation. */
export interface Transport {
  kind: 'usb' | 'wifi' | 'emulator';
  serial: string;
}

export interface DeviceTarget {
  assetId: string;
  kind: 'pixel' | 'emulator';
  canonicalSerial: string;
  model: string;
  codename: string;
  transports: Transport[];
  groups: string[];
  inputs?: Record<string, { path: string; sha256: string }>;
}

export interface SelectedTarget {
  device: DeviceTarget;
  transport: Transport;
}

export interface Inventory {
  schemaVersion: 1;
  devices: DeviceTarget[];
}

/** Android IDs can be reused after deletion; serialNo must be checked before recovery. */
export interface AndroidUserIdentity {
  userId: number;
  serialNo: number;
  name: string;
}

export interface ArtifactPolicy {
  packageId: string;
  versionCode: number;
  sha256: string;
  signerSha256: string;
  path?: string;
  url?: string;
  repositoryId?: string;
  redirectHosts?: string[];
}

export interface SettingPolicy {
  namespace: 'system' | 'secure' | 'global';
  key: string;
  value: string;
}

export interface PermissionPolicy {
  packageId: string;
  permission: string;
  granted: boolean;
}

export interface VpnPolicy {
  packageId: string | null;
  alwaysOn: boolean;
  lockdown: boolean;
}

/** Only references are public; credential values remain in private device input. */
export interface DefaultCredentialPolicy {
  type: 'pin' | 'password';
  secretRef: string;
}

export interface DefaultDuressPolicy {
  ownerCredentialRef: string;
  pinRef: string;
  passwordRef: string;
}

export interface ProfilePolicy {
  id: string;
  name: string;
  kind: 'owner' | 'secondary';
  packages: ArtifactPolicy[];
  settings: SettingPolicy[];
  permissions: PermissionPolicy[];
  vpn: VpnPolicy;
  defaultCredential?: DefaultCredentialPolicy;
  defaultDuress?: DefaultDuressPolicy;
  defaultLocale?: string;
  /** Legacy alias for defaultLocale. */
  language?: string;
  recipes?: RecipePolicy[];
  networkProbe?: NetworkProbePolicy;
  backup?: { enabled: boolean; transportPackage: string };
}

export interface UiSelector {
  resourceId?: string;
  text?: string;
  description?: string;
  checked?: boolean;
}

export type RecipeStep =
  | { action: 'tap'; selector: UiSelector; timeoutMs?: number }
  | { action: 'wait'; selector: UiSelector; timeoutMs?: number }
  | { action: 'toggle'; selector: UiSelector; value: boolean; timeoutMs?: number }
  | { action: 'text'; selector: UiSelector; value: string; timeoutMs?: number }
  | { action: 'back' }
  | { action: 'stage-file'; file: string }
  | { action: 'select-staged-file'; file: string };

export interface RecipePolicy {
  schemaVersion: 1;
  id: string;
  packageId: string;
  versionCode: number;
  signerSha256: string;
  buildFingerprint: string;
  steps: RecipeStep[];
  postconditions: UiSelector[];
}

export interface NetworkProbePolicy {
  artifact: ArtifactPolicy;
  endpoint: string;
  expectedEgressCidrs: string[];
  requireVpn: boolean;
  failurePackages: string[];
}

export interface RepositoryPolicy {
  id: string;
  url: string;
  signerSha256: string;
  maxAgeDays: number;
  redirectHosts: string[];
}

export interface OsPolicy {
  codename: string;
  release: string;
  url: string;
  signatureUrl: string;
  signerPrincipal: string;
  namespace: string;
  publicKey: string;
}

/** Expanded policy used by planning and execution; authored input is PolicyDocument. */
export interface ExecutionPolicy {
  schemaVersion: 2;
  id: string;
  version: string;
  name: string;
  profiles: ProfilePolicy[];
  capabilities: string[];
  requiredAttestations: string[];
  repositories: RepositoryPolicy[];
  /** Exact image pins for each enrolled model. */
  osByCodename?: Record<string, OsPolicy>;
}

/** @deprecated Use ExecutionPolicy for engine data or PolicyDocument for authored input. */
export type PolicyPack = ExecutionPolicy;

export interface ProfileDocument extends Omit<ProfilePolicy, 'packages'> {
  apps: string[];
}

/** @deprecated Use ProfileDocument; only v2 authoring is supported. */
export type ProfileDocumentV2 = ProfileDocument;

/** Authoring format; normalized to ExecutionPolicy before planning or execution. */
export interface PolicyDocument extends Omit<ExecutionPolicy, 'profiles' | 'osByCodename'> {
  schemaVersion: 2;
  apps: Record<string, ArtifactPolicy>;
  profiles: ProfileDocument[];
  deviceSettings: SettingPolicy[];
  os?: Record<string, OsPolicy>;
}

/** @deprecated Use PolicyDocument; only v2 authoring is supported. */
export type PolicyDocumentV2 = PolicyDocument;

export interface ExtensionLock {
  id: string;
  version: string;
  integrity: string;
  apiVersion: 1;
  entry: string;
  installPath: string;
}

export interface ProjectConfig {
  format: 'pxv-ts';
  schemaVersion: 1;
  id: string;
  productId: string;
  policyFile: string;
  inventoryFile: string;
  extensions: ExtensionLock[];
}

export interface ProductDescriptor {
  schemaVersion: 1;
  id: string;
  name: string;
  command: string;
  packageName: string;
  debName: string;
  image: string;
  upstreamVersion: '0.1.0';
  engineApi: 1;
  assets: Record<string, string>;
  defaultPolicy: string;
  /** Omitted by legacy products, which retain their existing capabilities. */
  features?: { extensions: boolean; seedvault: boolean };
  support: { name: string; email: string; url: string };
}

export interface ResolvedPolicy {
  schemaVersion: 1;
  engineVersion: '0.1.0';
  engineDigest: string;
  project: ProjectConfig;
  product: ProductDescriptor;
  policy: ExecutionPolicy;
  digest: string;
}

export interface AcceptedHandoffSnapshot {
  schemaVersion: 1;
  assetId: string;
  recordId: string;
  resolvedPolicy: ResolvedPolicy;
}

export interface DesiredState {
  policyDigest: string;
  profiles: ProfilePolicy[];
}

export interface SharedApkEffect {
  packageId: string;
  users: { user: AndroidUserIdentity; versionCode: number; signerSha256: string }[];
}

export interface ReviewedApkEffect extends SharedApkEffect {
  toVersionCode: number;
}

export interface ProfileObservation {
  profileId: string;
  user: AndroidUserIdentity;
  packages: { packageId: string; versionCode: number; signerSha256: string }[];
  settings: SettingPolicy[];
  permissions: PermissionPolicy[];
  vpn: VpnPolicy;
  language?: string;
  backup?: { enabled: boolean; transportPackage: string | null };
}

export interface DeviceObservation {
  schemaVersion: 1;
  device: DeviceTarget;
  observedAt: string;
  os: { codename: string; release: string; bootVerified: boolean };
  profiles: ProfileObservation[];
  helpers: string[];
  debuggingEnabled: boolean;
}

export interface ObservationCheck {
  key: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ObservationReport {
  schemaVersion: 1;
  policyDigest: string;
  observationDigest: string;
  checks: ObservationCheck[];
  passed: boolean;
}

export type Action =
  | { kind: 'create-user'; profileId: string; name: string }
  | { kind: 'install-apk'; profileId: string; artifact: ArtifactPolicy }
  | { kind: 'setting'; profileId: string; setting: SettingPolicy }
  | { kind: 'permission'; profileId: string; permission: PermissionPolicy }
  | { kind: 'vpn'; profileId: string; vpn: VpnPolicy }
  | { kind: 'install-os'; os: OsPolicy }
  | { kind: 'language'; profileId: string; language: string }
  | { kind: 'default-credential'; profileId: string; credential: DefaultCredentialPolicy }
  | { kind: 'default-duress'; profileId: string; duress: DefaultDuressPolicy }
  | { kind: 'recipe'; profileId: string; recipe: RecipePolicy }
  | { kind: 'network-probe'; profileId: string; probe: NetworkProbePolicy }
  | { kind: 'manual'; capability: string; instructions: string };

export interface ReviewedPlan {
  schemaVersion: 1;
  id: string;
  projectId: string;
  device: DeviceTarget;
  policyDigest: string;
  createdAt: string;
  actions: Action[];
  digest: string;
}

export interface OperatorAttestation {
  schemaVersion: 1;
  id: string;
  planDigest: string;
  observationDigest: string;
  check: string;
  operator: string;
  recordedAt: string;
  profileIds: string[];
  note?: string;
}

export interface RecoveryObligation {
  schemaVersion: 1;
  id: string;
  operationId: string;
  ownerOperationId: string;
  deviceSerial: string;
  user?: AndroidUserIdentity;
  kind: string;
  resource: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'resolved' | 'blocked';
}

export interface RunEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  sequence: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

export type WorkflowOutcome = 'subset' | 'emulator' | 'ready-for-handoff' | 'completed-custody';

export interface HandoffRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  deviceSerial: string;
  policyDigest: string;
  observationDigest: string;
  locale: 'en' | 'pl';
  outcome: WorkflowOutcome;
  operator: string;
  createdAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
}

export type TargetSelector =
  { kind: 'asset'; assetId: string } | { kind: 'fleet' } | { kind: 'group'; group: string };

export interface ReadinessRequirement {
  id: string;
  kind: 'measured' | 'operator';
  profileIds: string[];
  instructions: { en: string; pl: string };
}
