import type {
  AndroidUserIdentity,
  ArtifactPolicy,
  DeviceObservation,
  OsPolicy,
  ExecutionPolicy,
  ProfilePolicy,
  ReviewedPlan,
  SelectedTarget,
  SharedApkEffect,
  ReviewedApkEffect,
  RecipePolicy,
  NetworkProbePolicy,
  RecoveryObligation,
  ObligationWriter,
  OperatorAttestation,
} from '@pxv/contracts';
import type { DeviceLease, Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { ResourceScope } from './recovery.js';
import type { ExecutionControl } from './execution-control.js';
import type { SeedvaultWorkflowPort } from './seedvault-types.js';
export interface EmulatorImagePin {
  path: string;
  sha256: string;
  fingerprint: string;
  source: string;
}

export interface EmulatorProvenance {
  schemaVersion: 1;
  acceptance: 'emulator-only';
  canonicalSerial: string;
  fingerprint: string;
  imageSha256: string;
  source: string;
  capabilities: string[];
  observedAt: string;
}

export interface BoundEmulatorEvidence {
  measurement: EmulatorProvenance;
  observationDigest: string;
  policyDigest: string;
  planDigest: string;
}

export interface ExecutionContext {
  lease: DeviceLease;
  signal?: AbortSignal;
  osSnapshot?: OsSnapshot;
  reviewedDeviceWideEffect?: ReviewedApkEffect;
  operationId?: string;
  obligations?: ObligationWriter;
}

export interface RecipeExecutionResult {
  status: 'measured' | 'manual-pending';
  recipeDigest: string;
  capability: 'app-setup';
  postconditions?: number;
  instructions?: string;
}

export interface ProbeObservation {
  uid: number;
  requestSucceeded: boolean;
  connectionObserved: boolean;
  vpnActive: boolean;
  egressIp: string | null;
  errorType: string | null;
}

export interface ProbeExecutionResult {
  scope: 'probe-app-uid-https-only';
  normal: ProbeObservation;
  failures: { stoppedPackage: string; stopped: ProbeObservation; recovered: ProbeObservation }[];
}

export interface CapabilityEvidenceRef {
  kind: 'recipe' | 'network-probe' | 'vpn-settings';
  profileId: string;
  configurationDigest: string;
  evidenceId: string;
  status: 'measured' | 'manual-completed';
}
export interface VpnSettingsProof {
  assetId: string;
  deviceSerial: string;
  kind: 'vpn-settings';
  scope: 'operator-witnessed-settings';
  status: 'manual-completed';
  runId: string;
  planId: string;
  planDigest: string;
  actionIndex: number;
  profileId: string;
  policyDigest: string;
  configurationDigest: string;
  user: AndroidUserIdentity;
  receipt: OperatorAttestation;
  observationDigest: string;
  proofDigest: string;
}

export interface WorkflowPort {
  readonly capabilities?: { uiAutomation: boolean };
  inspect(target: SelectedTarget, policy: ExecutionPolicy, signal?: AbortSignal): Promise<DeviceObservation>;
  createUser(
    target: SelectedTarget,
    profile: ProfilePolicy,
    context: ExecutionContext,
  ): Promise<AndroidUserIdentity>;
  install(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    artifact: ArtifactPolicy,
    context: ExecutionContext,
  ): Promise<void>;
  applySetting(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    setting: ProfilePolicy['settings'][number],
    context: ExecutionContext,
  ): Promise<void>;
  applyPermission(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    permission: ProfilePolicy['permissions'][number],
    context: ExecutionContext,
  ): Promise<void>;
  verifyVpnConfiguration(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    vpn: ProfilePolicy['vpn'],
    context: ExecutionContext,
  ): Promise<void>;
  language(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    language: string,
    context: ExecutionContext,
  ): Promise<void | { status: 'manual-pending'; instructions: string } | { status: 'measured' }>;
  credentialDefaultsPreflight?(target: SelectedTarget, signal?: AbortSignal): Promise<void>;
  setCredentialDefault?(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    context: ExecutionContext,
  ): Promise<void>;
  setDuressDefault?(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    context: ExecutionContext,
  ): Promise<void>;
  flash(target: SelectedTarget, policy: ExecutionPolicy, context: ExecutionContext): Promise<void>;
  finalize(target: SelectedTarget, context: ExecutionContext): Promise<void>;
  runRecipe?(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    context: ExecutionContext,
  ): Promise<RecipeExecutionResult>;
  runProbe?(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    probe: NetworkProbePolicy,
    context: ExecutionContext,
  ): Promise<ProbeExecutionResult>;
  cleanup?(
    target: SelectedTarget,
    obligation: RecoveryObligation,
    context: ExecutionContext & { operationId: string },
  ): Promise<void>;
  inspectUser?(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    signal?: AbortSignal,
  ): Promise<AndroidUserIdentity>;
  sharedEffects?(
    target: SelectedTarget,
    packageIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]>;
  verifyEmulatorEvidence?(
    target: SelectedTarget,
    input: EmulatorImagePin,
    signal?: AbortSignal,
  ): Promise<EmulatorProvenance>;
}

export interface OsSnapshot {
  path: string;
  signaturePath: string;
  sha256: string;
  signatureSha256: string;
  policy: OsPolicy;
}

export interface ArtifactPort {
  snapshot(
    artifact: ArtifactPolicy,
    destination: string,
    signal?: AbortSignal,
    target?: SelectedTarget,
  ): Promise<ArtifactPolicy>;
  validateBeforeExecution?(
    artifact: ArtifactPolicy,
    target: SelectedTarget,
    signal?: AbortSignal,
  ): Promise<void>;
  snapshotOs?(policy: OsPolicy, destination: string, signal?: AbortSignal): Promise<OsSnapshot>;
}

export type Operation = 'create-users' | 'deploy-apps' | 'provision' | 'install-os' | 'extension';

export interface SetupReceiptRef {
  check: string;
  receiptId: string;
  planDigest: string;
  actionIndex?: number;
}

export interface ReviewLineage {
  runId: string;
  planDigest: string;
  completedActions: number;
  completedSetup: SetupReceiptRef[];
  capabilityEvidence: CapabilityEvidenceRef[];
  pendingRecipeEvidenceId?: string;
}

export interface PreparedOperation {
  schemaVersion: 1;
  plan: ReviewedPlan;
  target: SelectedTarget;
  operation: Operation;
  baseline: DeviceObservation;
  expiresAt: string;
  reviewSummary: string;
  osSnapshot?: OsSnapshot;
  sharedEffects: SharedApkEffect[];
  refreshedFrom?: ReviewLineage;
  lifecycleGeneration?: string;
  capabilities?: { uiAutomation: boolean };
}

export interface WorkflowState {
  schemaVersion: 1;
  assetId: string;
  policyDigest: string;
  planDigest: string;
  observation: DeviceObservation;
  observedAt: string;
  status: 'pending' | 'failed' | 'verified' | 'shutdown-requested' | 'completed-custody';
  pending: string[];
  languageReady: boolean;
  completedSetup?: SetupReceiptRef[];
  planId?: string;
  capabilityEvidence?: CapabilityEvidenceRef[];
}

export type RunPauseReason =
  | { kind: 'manual-step'; gate: string; instructions?: string; profileId?: string; recipeId?: string }
  | { kind: 'reenrollment' | 'acceptance' | 'inspection'; instructions: string };

export interface RunRecord {
  id: string;
  planId: string;
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'pending'
    | 'failed'
    | 'cancelled'
    | 'needs-inspection'
    | 'superseded';
  createdAt: string;
  operator: string;
  error?: string;
  cursor?: number;
  manualGate?: string;
  completedSetup?: SetupReceiptRef[];
  capabilityEvidence?: CapabilityEvidenceRef[];
  supersededBy?: string;
  pauseReason?: RunPauseReason;
}

export interface EngineOptions {
  project: ProjectContext;
  store: Store;
  port: WorkflowPort;
  artifacts: ArtifactPort;
  seedvault?: SeedvaultWorkflowPort;
  controlRoot: string;
  clock?: () => Date;
}

export interface ActiveExecution {
  run: RunRecord;
  prepared: PreparedOperation;
  target: SelectedTarget;
  scope: ResourceScope;
  context: ExecutionContext;
  control: ExecutionControl;
  observation: DeviceObservation;
  effects: SharedApkEffect[];
  resume: boolean;
  workflowExpected: unknown;
}

export interface CapabilityRequirement {
  kind: CapabilityEvidenceRef['kind'];
  configurationDigest: string;
  label: string;
}

export interface CapabilityProof {
  policyDigest: string;
  configurationDigest: string;
  status: string;
  user: AndroidUserIdentity;
}

export interface RecipeProof {
  status: string;
  configurationDigest: string;
  user: AndroidUserIdentity;
  result: RecipeExecutionResult;
  previousReceiptId?: string | null;
}
