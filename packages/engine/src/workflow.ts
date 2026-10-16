import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  canonicalJson,
  digest,
  evaluateObservation,
  finalSetupActions,
  observationDigest,
  requiredAttestations,
  validateAction,
  validateArtifact,
  validateAttestation,
  validateHandoff,
  validateObservation,
  validatePlan,
  validateSharedEffect,
  validateAcceptedHandoffSnapshot,
  verifyResolvedPolicy,
  type Action,
  type AndroidUserIdentity,
  type ArtifactPolicy,
  type DeviceObservation,
  type HandoffRecord,
  type OperatorAttestation,
  type PolicyPack,
  type ProfilePolicy,
  type ReviewedPlan,
  type SelectedTarget,
  type SharedApkEffect,
  type ReviewedApkEffect,
  type RecipePolicy,
  type NetworkProbePolicy,
  type RecoveryObligation,
  type AcceptedHandoffSnapshot,
} from '@pxv/contracts';
import {
  deviceLeaseKeys,
  recoveryReservations,
  nativeReceipts,
  withDeviceLease,
  withRecoveryLease,
  type DeviceLease,
  type SqliteStore,
} from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { ResourceScope } from './recovery.js';

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
interface BoundEmulatorEvidence {
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
  obligations?: { record(obligation: RecoveryObligation): Promise<void>; resolve(id: string): Promise<void> };
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
interface CapabilityEvidenceRef {
  kind: 'recipe' | 'network-probe';
  profileId: string;
  configurationDigest: string;
  evidenceId: string;
  status: 'measured' | 'manual-completed';
}
export interface WorkflowPort {
  inspect(target: SelectedTarget, policy: PolicyPack, signal?: AbortSignal): Promise<DeviceObservation>;
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
  applyVpn(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    vpn: ProfilePolicy['vpn'],
    context: ExecutionContext,
  ): Promise<void>;
  language(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    language: 'en-US' | 'pl-PL',
    context: ExecutionContext,
  ): Promise<void | { status: 'manual-pending'; instructions: string } | { status: 'measured' }>;
  flash(target: SelectedTarget, policy: PolicyPack, context: ExecutionContext): Promise<void>;
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
  policy: NonNullable<PolicyPack['os']>;
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
  snapshotOs?(
    policy: NonNullable<PolicyPack['os']>,
    destination: string,
    signal?: AbortSignal,
  ): Promise<OsSnapshot>;
}
export type Operation = 'create-users' | 'deploy-apps' | 'provision' | 'install-os' | 'extension';
interface SetupReceiptRef {
  check: string;
  receiptId: string;
  planDigest: string;
}
interface ReviewLineage {
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
}
interface EngineOptions {
  project: ProjectContext;
  store: SqliteStore;
  port: WorkflowPort;
  artifacts: ArtifactPort;
  controlRoot: string;
  clock?: () => Date;
}

function sameUser(a: AndroidUserIdentity, b: AndroidUserIdentity): boolean {
  return a.userId === b.userId && a.serialNo === b.serialNo && a.name === b.name;
}

function summaryData(prepared: Omit<PreparedOperation, 'reviewSummary'>): Record<string, unknown> {
  const { plan, target, baseline, operation, expiresAt, osSnapshot } = prepared;
  return {
    planId: plan.id,
    operation,
    expiresAt,
    assetId: target.device.assetId,
    deviceKind: target.device.kind,
    transport: target.transport,
    policyDigest: plan.policyDigest,
    users: baseline.profiles.map((value) => ({ profileId: value.profileId, user: value.user })),
    sharedEffects: prepared.sharedEffects,
    refreshedFrom: prepared.refreshedFrom
      ? {
          runId: prepared.refreshedFrom.runId,
          planDigest: prepared.refreshedFrom.planDigest,
          completedActions: prepared.refreshedFrom.completedActions,
          completedSetup: prepared.refreshedFrom.completedSetup.map((value) => value.check),
          completedCapabilities: prepared.refreshedFrom.capabilityEvidence.map((value) => ({
            kind: value.kind,
            profileId: value.profileId,
            configurationDigest: value.configurationDigest,
          })),
        }
      : null,
    osSnapshot: osSnapshot
      ? { sha256: osSnapshot.sha256, signatureSha256: osSnapshot.signatureSha256, policy: osSnapshot.policy }
      : null,
    actions: plan.actions.map((action) =>
      action.kind === 'install-apk'
        ? {
            ...action,
            artifact: {
              packageId: action.artifact.packageId,
              versionCode: action.artifact.versionCode,
              sha256: action.artifact.sha256,
              signerSha256: action.artifact.signerSha256,
            },
            sharedWithProfiles: baseline.profiles
              .filter((value) =>
                value.packages.some((artifact) => artifact.packageId === action.artifact.packageId),
              )
              .map((value) => value.profileId),
          }
        : action.kind === 'network-probe'
          ? {
              ...action,
              probe: {
                ...action.probe,
                artifact: {
                  packageId: action.probe.artifact.packageId,
                  versionCode: action.probe.artifact.versionCode,
                  sha256: action.probe.artifact.sha256,
                  signerSha256: action.probe.artifact.signerSha256,
                },
              },
              scope: 'probe-app-uid-https-only',
            }
          : action,
    ),
    notes: [
      'APK versions are shared across Android users',
      'Manual checks are separate from automated observations',
    ],
  };
}

function preparedDigest(prepared: Omit<PreparedOperation, 'reviewSummary'>, extensions: unknown): string {
  const { digest: _digest, ...body } = prepared.plan;
  void _digest;
  return digest({
    plan: body,
    baseline: observationDigest(prepared.baseline),
    extensions,
    target: prepared.target,
    osSnapshot: prepared.osSnapshot ?? null,
    sharedEffects: prepared.sharedEffects,
    operation: prepared.operation,
    expiresAt: prepared.expiresAt,
    refreshedFrom: prepared.refreshedFrom ?? null,
    review: summaryData(prepared),
  });
}

function canonicalEffects(input: SharedApkEffect[]): SharedApkEffect[] {
  const effects = input
    .map(validateSharedEffect)
    .map((effect) => ({
      ...effect,
      users: [...effect.users].sort((a, b) => a.user.serialNo - b.user.serialNo),
    }))
    .sort((a, b) => a.packageId.localeCompare(b.packageId));
  if (new Set(effects.map((effect) => effect.packageId)).size !== effects.length)
    throw new Error('Duplicate shared APK effects');
  return effects;
}

export class WorkflowEngine {
  readonly project: ProjectContext;
  readonly store: SqliteStore;
  readonly port: WorkflowPort;
  readonly artifacts: ArtifactPort;
  readonly controlRoot: string;
  readonly clock: () => Date;
  constructor(options: EngineOptions) {
    this.project = options.project;
    this.store = options.store;
    this.port = options.port;
    this.artifacts = options.artifacts;
    this.controlRoot = options.controlRoot;
    this.clock = options.clock ?? (() => new Date());
  }

  private assertTarget(target: SelectedTarget): void {
    const enrolled = this.project.inventory.devices.find(
      (device) => device.assetId === target.device.assetId,
    );
    if (
      !enrolled ||
      digest(enrolled) !== digest(target.device) ||
      !enrolled.transports.some((transport) => digest(transport) === digest(target.transport))
    )
      throw new Error('Target differs from the enrolled device or approved transport');
  }

  private async sharedEffects(
    target: SelectedTarget,
    packageIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]> {
    if (!packageIds.length) return [];
    if (!this.port.sharedEffects)
      throw new Error('Device-wide APK review service is required before planning an install');
    const effects = canonicalEffects(await this.port.sharedEffects(target, packageIds, signal));
    if (digest(effects.map((effect) => effect.packageId)) !== digest([...packageIds].sort()))
      throw new Error('Shared APK effect inspection is incomplete');
    return effects;
  }

  private nextEffects(
    effects: SharedApkEffect[],
    artifact: ArtifactPolicy,
    user: AndroidUserIdentity,
  ): SharedApkEffect[] {
    return canonicalEffects(
      effects.map((effect) => {
        if (effect.packageId !== artifact.packageId) return effect;
        const users = effect.users.map((item) => ({
          ...item,
          versionCode: artifact.versionCode,
          signerSha256: artifact.signerSha256,
        }));
        if (!users.some((item) => sameUser(item.user, user)))
          users.push({ user, versionCode: artifact.versionCode, signerSha256: artifact.signerSha256 });
        return { ...effect, users };
      }),
    );
  }

  async observe(target: SelectedTarget, signal?: AbortSignal): Promise<DeviceObservation> {
    this.assertTarget(target);
    const value = validateObservation(await this.port.inspect(target, this.project.policy, signal));
    if (digest(value.device) !== digest(target.device))
      throw new Error('Observed identity differs from enrollment');
    return value;
  }

  /** Artifact acquisition is allowed; preparation never changes the phone. */
  async prepare(
    target: SelectedTarget,
    operation: Operation = 'provision',
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    if (operation === 'extension') throw new Error('Use prepareExtension for explicit contributed actions');
    return this.prepareActions(target, operation, signal);
  }

  async prepareExtension(
    target: SelectedTarget,
    contributions: Action[],
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    if (!Array.isArray(contributions) || contributions.length === 0 || contributions.length > 1000)
      throw new Error('An extension must contribute a bounded nonempty list of core actions');
    const actions = contributions.map(validateAction);
    const osActions = actions.filter((action) => action.kind === 'install-os');
    if (osActions.length) {
      if (actions.length !== 1 || digest(osActions[0]?.os) !== digest(this.project.policy.os ?? null))
        throw new Error('OS extension actions must be a separate operation using the selected policy');
      return this.prepare(target, 'install-os', signal);
    }
    for (const action of actions) {
      if (action.kind === 'install-os') throw new Error('OS actions require separate preparation');
      if (action.kind === 'manual') {
        if (
          ![
            ...this.project.policy.capabilities,
            ...requiredAttestations(this.project.policy, target.device.kind),
          ].includes(action.capability)
        )
          throw new Error('Extension manual action is outside selected policy capabilities');
        continue;
      }
      const profile = this.project.policy.profiles.find((value) => value.id === action.profileId);
      if (!profile) throw new Error('Extension references a profile outside selected policy');
      const declared =
        action.kind === 'install-apk'
          ? profile.packages.some(
              (artifact) =>
                artifact.packageId === action.artifact.packageId &&
                artifact.versionCode === action.artifact.versionCode &&
                artifact.sha256 === action.artifact.sha256 &&
                artifact.signerSha256 === action.artifact.signerSha256,
            )
          : action.kind === 'setting'
            ? profile.settings.some((setting) => digest(setting) === digest(action.setting))
            : action.kind === 'permission'
              ? profile.permissions.some((permission) => digest(permission) === digest(action.permission))
              : action.kind === 'vpn'
                ? digest(profile.vpn) === digest(action.vpn)
                : action.kind === 'language'
                  ? profile.language === action.language
                  : action.kind === 'recipe'
                    ? (profile.recipes ?? []).some((recipe) => digest(recipe) === digest(action.recipe))
                    : action.kind === 'network-probe'
                      ? profile.networkProbe !== undefined &&
                        digest(profile.networkProbe) === digest(action.probe)
                      : profile.kind === 'secondary' && profile.name === action.name;
      if (!declared) throw new Error('Extension action contradicts selected policy');
    }
    return this.prepareActions(target, 'extension', signal, actions);
  }

  private async prepareActions(
    target: SelectedTarget,
    operation: Operation,
    signal?: AbortSignal,
    contributions?: Action[],
  ): Promise<PreparedOperation> {
    this.assertTarget(target);
    if (
      operation === 'install-os' &&
      (target.device.kind !== 'pixel' || target.transport.kind !== 'usb' || !this.project.policy.os)
    )
      throw new Error('OS installation requires an enrolled USB Pixel and pinned OS policy');
    const baseline =
      operation === 'install-os'
        ? {
            schemaVersion: 1 as const,
            device: target.device,
            observedAt: this.clock().toISOString(),
            os: { codename: target.device.codename, release: 'unobserved', bootVerified: false },
            profiles: [],
            helpers: [],
            debuggingEnabled: false,
          }
        : await this.observe(target, signal);
    if (operation !== 'install-os') {
      const owner = this.project.policy.profiles.find((profile) => profile.kind === 'owner');
      const observedOwner = baseline.profiles.find((profile) => profile.profileId === owner?.id);
      if (owner && observedOwner && observedOwner.user.name !== owner.name)
        throw new Error('Owner display name differs; update policy or rename on device and prepare again');
    }
    const id = randomUUID();
    const actions: Action[] = [];
    let osSnapshot: OsSnapshot | undefined;
    if (operation === 'install-os') {
      if (!this.project.policy.os) throw new Error('OS policy is missing');
      if (!this.artifacts.snapshotOs) throw new Error('Verified OS snapshot service is required');
      osSnapshot = await this.artifacts.snapshotOs(
        this.project.policy.os,
        join(this.project.root, 'state/plans', id, 'os'),
        signal,
      );
      actions.push({ kind: 'install-os', os: this.project.policy.os });
    } else if (contributions) {
      for (const action of contributions) {
        if (action.kind === 'install-apk') {
          const snapshot = validateArtifact(
            await this.artifacts.snapshot(
              action.artifact,
              join(
                this.project.root,
                'state/plans',
                id,
                `${actions.length}-${action.profileId}-${action.artifact.packageId}.apk`,
              ),
              signal,
              target,
            ),
          );
          if (
            snapshot.packageId !== action.artifact.packageId ||
            snapshot.versionCode !== action.artifact.versionCode ||
            snapshot.sha256 !== action.artifact.sha256 ||
            snapshot.signerSha256 !== action.artifact.signerSha256
          )
            throw new Error('Artifact service returned a different identity than reviewed policy');
          actions.push({ ...action, artifact: snapshot });
        } else if (action.kind === 'network-probe') {
          if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
          const artifact = validateArtifact(
            await this.artifacts.snapshot(
              action.probe.artifact,
              join(this.project.root, 'state/plans', id, `probe-${actions.length}-${action.profileId}.apk`),
              signal,
              target,
            ),
          );
          if (
            artifact.packageId !== action.probe.artifact.packageId ||
            artifact.versionCode !== action.probe.artifact.versionCode ||
            artifact.sha256 !== action.probe.artifact.sha256 ||
            artifact.signerSha256 !== action.probe.artifact.signerSha256
          )
            throw new Error('Probe helper snapshot identity differs from selected policy');
          actions.push({ ...action, probe: { ...action.probe, artifact } });
        } else {
          if (action.kind === 'recipe' && !this.port.runRecipe)
            throw new Error('Configured recipe adapter is unavailable');
          actions.push(action);
        }
      }
    } else {
      for (const profile of this.project.policy.profiles) {
        const observed = baseline.profiles.find((value) => value.profileId === profile.id);
        if (!observed && profile.kind === 'owner') throw new Error('The owner user must already exist');
        if (!observed) {
          if (operation === 'deploy-apps')
            throw new Error('Deploy requires existing Android users; review user creation separately');
          actions.push({ kind: 'create-user', profileId: profile.id, name: profile.name });
        }
        if (operation === 'create-users') continue;
        for (const artifact of profile.packages) {
          const current = observed?.packages.find((value) => value.packageId === artifact.packageId);
          if (current && current.versionCode > artifact.versionCode)
            throw new Error('Package downgrade refused');
          if (current?.versionCode === artifact.versionCode && current.signerSha256 === artifact.signerSha256)
            continue;
          const snapshot = validateArtifact(
            await this.artifacts.snapshot(
              artifact,
              join(this.project.root, 'state/plans', id, `${profile.id}-${artifact.packageId}.apk`),
              signal,
              target,
            ),
          );
          if (
            snapshot.packageId !== artifact.packageId ||
            snapshot.versionCode !== artifact.versionCode ||
            snapshot.sha256 !== artifact.sha256 ||
            snapshot.signerSha256 !== artifact.signerSha256
          )
            throw new Error('Artifact service returned a different identity than reviewed policy');
          actions.push({ kind: 'install-apk', profileId: profile.id, artifact: snapshot });
        }
        if (operation === 'provision') {
          for (const setting of profile.settings) {
            if (!observed?.settings.some((actual) => digest(actual) === digest(setting)))
              actions.push({ kind: 'setting', profileId: profile.id, setting });
          }
          for (const permission of profile.permissions) {
            if (!observed?.permissions.some((actual) => digest(actual) === digest(permission)))
              actions.push({ kind: 'permission', profileId: profile.id, permission });
          }
          if (!observed || digest(observed.vpn) !== digest(profile.vpn))
            actions.push({ kind: 'vpn', profileId: profile.id, vpn: profile.vpn });
          for (const recipe of profile.recipes ?? []) {
            if (!this.port.runRecipe) throw new Error('Configured recipe adapter is unavailable');
            actions.push({ kind: 'recipe', profileId: profile.id, recipe });
          }
          if (profile.networkProbe) {
            if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
            const artifact = validateArtifact(
              await this.artifacts.snapshot(
                profile.networkProbe.artifact,
                join(this.project.root, 'state/plans', id, `probe-${profile.id}.apk`),
                signal,
                target,
              ),
            );
            if (
              artifact.packageId !== profile.networkProbe.artifact.packageId ||
              artifact.versionCode !== profile.networkProbe.artifact.versionCode ||
              artifact.sha256 !== profile.networkProbe.artifact.sha256 ||
              artifact.signerSha256 !== profile.networkProbe.artifact.signerSha256
            )
              throw new Error('Probe helper snapshot identity differs from selected policy');
            actions.push({
              kind: 'network-probe',
              profileId: profile.id,
              probe: { ...profile.networkProbe, artifact },
            });
          }
        }
      }
      if (operation === 'provision')
        actions.push(
          ...finalSetupActions(this.project.policy).filter(
            (action) =>
              action.kind !== 'language' ||
              baseline.profiles.find((value) => value.profileId === action.profileId)?.language !==
                action.language,
          ),
        );
    }
    const body = {
      schemaVersion: 1 as const,
      id,
      projectId: this.project.config.id,
      device: target.device,
      policyDigest: this.project.resolved.digest,
      createdAt: this.clock().toISOString(),
      actions,
    };
    const packages = [
      ...new Set(
        actions.flatMap((action) =>
          action.kind === 'install-apk'
            ? [action.artifact.packageId]
            : action.kind === 'network-probe'
              ? [action.probe.artifact.packageId]
              : [],
        ),
      ),
    ];
    const sharedEffects = await this.sharedEffects(target, packages, signal);
    for (const effect of sharedEffects) {
      if (
        actions.some(
          (action) => action.kind === 'network-probe' && action.probe.artifact.packageId === effect.packageId,
        ) &&
        effect.users.length
      )
        throw new Error('A probe helper is already installed; inspect its owner before continuing');
      const action = actions.find(
        (value) => value.kind === 'install-apk' && value.artifact.packageId === effect.packageId,
      );
      if (
        action?.kind === 'install-apk' &&
        effect.users.some(
          (item) =>
            item.versionCode > action.artifact.versionCode ||
            item.signerSha256 !== action.artifact.signerSha256,
        )
      )
        throw new Error('A shared APK would downgrade or replace another Android user signer');
    }
    const draft = {
      schemaVersion: 1 as const,
      plan: { ...body, digest: '0'.repeat(64) },
      target,
      operation,
      baseline,
      sharedEffects,
      expiresAt: new Date(this.clock().getTime() + 900_000).toISOString(),
      ...(osSnapshot ? { osSnapshot } : {}),
    };
    const plan = validatePlan({ ...body, digest: preparedDigest(draft, this.project.config.extensions) });
    const prepared: PreparedOperation = {
      ...draft,
      plan,
      reviewSummary: canonicalJson({ ...summaryData(draft), planDigest: plan.digest }),
    };
    await this.store.set('plans', id, prepared);
    return prepared;
  }

  async submit(planId: string, reviewSummary: string, operator: string): Promise<RunRecord> {
    const prepared = await this.plan(planId, reviewSummary);
    if (prepared.refreshedFrom) {
      const previous = await this.store.get<RunRecord>('runs', prepared.refreshedFrom.runId);
      if (previous?.status !== 'superseded' || previous.supersededBy !== planId)
        throw new Error('Refreshed review was not committed; preserve the prior checkpoint');
    }
    if (!operator.trim() || operator.length > 200) throw new Error('Operator identity is required');
    const id = digest({ project: this.project.config.id, plan: prepared.plan.digest });
    const run: RunRecord = {
      id,
      planId,
      status: 'queued',
      operator,
      createdAt: this.clock().toISOString(),
      ...(prepared.refreshedFrom
        ? {
            cursor: 0,
            completedSetup: prepared.refreshedFrom.completedSetup,
            capabilityEvidence: prepared.refreshedFrom.capabilityEvidence,
          }
        : {}),
    };
    const existing = await this.store.get<RunRecord>('runs', id);
    if (existing) return existing;
    const submitted = await this.store.submitAndSet(`plan:${planId}`, run, 'runs', id);
    return submitted.value;
  }

  async plan(id: string, summary?: string): Promise<PreparedOperation> {
    return this.readPlan(id, summary);
  }

  private async readPlan(id: string, summary?: string, allowExpired = false): Promise<PreparedOperation> {
    const value = await this.store.get<PreparedOperation>('plans', id);
    if (!value) throw new Error('Reviewed plan does not exist');
    validatePlan(value.plan);
    validateObservation(value.baseline);
    this.assertTarget(value.target);
    canonicalEffects(value.sharedEffects);
    if (
      value.schemaVersion !== 1 ||
      !['create-users', 'deploy-apps', 'provision', 'install-os', 'extension'].includes(value.operation) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new Error('Malformed reviewed plan retained for inspection');
    if (
      value.plan.digest !== preparedDigest(value, this.project.config.extensions) ||
      value.reviewSummary !== canonicalJson({ ...summaryData(value), planDigest: value.plan.digest })
    )
      throw new Error('Stored reviewed plan changed; preserve it for inspection');
    if (
      value.plan.projectId !== this.project.config.id ||
      value.plan.policyDigest !== this.project.resolved.digest
    )
      throw new Error('Project policy or extensions changed; prepare a new plan');
    if (summary !== undefined && value.reviewSummary !== summary)
      throw new Error('Approval must match the exact reviewed summary');
    if (!allowExpired && Date.parse(value.expiresAt) < this.clock().getTime())
      throw new Error('Reviewed plan expired; prepare again');
    return value;
  }

  /** Re-review only an intentional manual pause; completed mutations are never replayed. */
  async refreshReview(runId: string, signal?: AbortSignal): Promise<PreparedOperation> {
    return withDeviceLease(
      this.controlRoot,
      `project-${this.project.config.id}`,
      `project-${this.project.config.id}`,
      `${randomUUID()}-refresh-project`,
      async () => {
        const run = await this.store.get<RunRecord>('runs', runId);
        if (
          run?.status !== 'pending' ||
          !run.manualGate ||
          !Number.isSafeInteger(run.cursor) ||
          (run.cursor ?? -1) < 0
        )
          throw new Error('Only an intentional manual checkpoint can receive a fresh review');
        const manualGate = run.manualGate;
        const previous = await this.readPlan(run.planId, undefined, true);
        if (previous.operation === 'install-os' || (run.cursor ?? 0) >= previous.plan.actions.length)
          throw new Error('Manual checkpoint action is invalid; preserve it for inspection');
        const target = previous.target;
        return withDeviceLease(
          this.controlRoot,
          digest({ kind: target.device.kind, serial: target.device.canonicalSerial }),
          digest(target.transport.serial),
          `${randomUUID()}-refresh-device`,
          async () => {
            signal?.throwIfAborted();
            const scope = new ResourceScope(this.store, target.device.canonicalSerial, runId);
            if ((await scope.list()).some((value) => value.status !== 'resolved'))
              throw new Error('Recover unresolved obligations before refreshing a review');
            const state = await this.state(target.device.assetId);
            if (state.planDigest !== previous.plan.digest)
              throw new Error('Manual checkpoint belongs to a different reviewed plan');
            const baseline = await this.observe(target, signal);
            let cursor = run.cursor ?? 0;
            const pausedAction = previous.plan.actions[cursor];
            if (manualGate.startsWith('language:') && pausedAction?.kind === 'language') {
              if (manualGate !== `language:${pausedAction.profileId}`)
                throw new Error('Manual language checkpoint is malformed');
              const actual = baseline.profiles.find((value) => value.profileId === pausedAction.profileId);
              const prior = state.observation.profiles.find(
                (value) => value.profileId === pausedAction.profileId,
              );
              const normalized = structuredClone(baseline);
              const profile = normalized.profiles.find((value) => value.profileId === pausedAction.profileId);
              if (!actual || !prior || !profile) throw new Error('Manual language identity changed');
              if (prior.language) profile.language = prior.language;
              else delete profile.language;
              if (observationDigest(normalized) !== observationDigest(state.observation))
                throw new Error('Other live requirements changed during manual language setup');
              if (actual.language === pausedAction.language) cursor++;
            } else if (observationDigest(baseline) !== observationDigest(state.observation))
              throw new Error('Live state changed at the manual checkpoint; inspect before replanning');
            const receipts = await this.receipts(target.device.assetId);
            const completedSetup = (run.completedSetup ?? []).filter(
              (value) => value.check === 'normal_credentials',
            );
            for (const consumed of completedSetup)
              if (
                !receipts.some(
                  (receipt) =>
                    receipt.id === consumed.receiptId &&
                    receipt.check === consumed.check &&
                    receipt.planDigest === consumed.planDigest,
                )
              )
                throw new Error('Consumed setup receipt is missing or changed');
            const capabilityEvidence = run.capabilityEvidence ?? [];
            for (const reference of capabilityEvidence) {
              const proof = await this.store.get<{
                policyDigest: string;
                configurationDigest: string;
                status: string;
                user: AndroidUserIdentity;
              }>('capability-evidence', reference.evidenceId);
              const user = baseline.profiles.find((value) => value.profileId === reference.profileId)?.user;
              if (
                !proof ||
                !user ||
                proof.policyDigest !== previous.plan.policyDigest ||
                proof.configurationDigest !== reference.configurationDigest ||
                proof.status !== reference.status ||
                !sameUser(proof.user, user)
              )
                throw new Error('Completed capability evidence changed at the manual checkpoint');
            }
            let pendingRecipeEvidenceId: string | undefined;
            if (manualGate === 'app_setup' && pausedAction?.kind === 'recipe') {
              pendingRecipeEvidenceId =
                previous.refreshedFrom?.pendingRecipeEvidenceId ?? `${runId}:recipe:${run.cursor ?? 0}`;
              const pending = await this.store.get<{
                status: string;
                policyDigest: string;
                configurationDigest: string;
                user: AndroidUserIdentity;
              }>('capability-evidence', pendingRecipeEvidenceId);
              const user = baseline.profiles.find(
                (value) => value.profileId === pausedAction.profileId,
              )?.user;
              if (
                !pending ||
                !user ||
                pending.status !== 'manual-pending' ||
                pending.policyDigest !== previous.plan.policyDigest ||
                pending.configurationDigest !== digest(pausedAction.recipe) ||
                !sameUser(pending.user, user)
              )
                throw new Error('Paused recipe evidence changed; preserve it for inspection');
            }
            const actions = previous.plan.actions.slice(cursor);
            const packageIds = [
              ...new Set(
                actions.flatMap((action) =>
                  action.kind === 'install-apk'
                    ? [action.artifact.packageId]
                    : action.kind === 'network-probe'
                      ? [action.probe.artifact.packageId]
                      : [],
                ),
              ),
            ];
            const sharedEffects = await this.sharedEffects(target, packageIds, signal);
            // The checkpoint already incorporates completed installs; remaining effects still need review.
            for (const effect of sharedEffects) {
              const install = actions.find(
                (action) => action.kind === 'install-apk' && action.artifact.packageId === effect.packageId,
              );
              if (
                actions.some(
                  (action) =>
                    action.kind === 'network-probe' && action.probe.artifact.packageId === effect.packageId,
                ) &&
                effect.users.length
              )
                throw new Error('Probe helper must be removed before review refresh');
              if (
                install?.kind === 'install-apk' &&
                effect.users.some(
                  (value) =>
                    value.versionCode > install.artifact.versionCode ||
                    value.signerSha256 !== install.artifact.signerSha256,
                )
              )
                throw new Error('Shared APK effects conflict with the remaining reviewed actions');
            }
            const id = randomUUID();
            const body = {
              schemaVersion: 1 as const,
              id,
              projectId: this.project.config.id,
              device: target.device,
              policyDigest: this.project.resolved.digest,
              createdAt: this.clock().toISOString(),
              actions,
            };
            const draft = {
              schemaVersion: 1 as const,
              plan: { ...body, digest: '0'.repeat(64) },
              target,
              operation: previous.operation,
              baseline,
              sharedEffects,
              expiresAt: new Date(this.clock().getTime() + 900_000).toISOString(),
              refreshedFrom: {
                runId,
                planDigest: previous.plan.digest,
                completedActions: cursor,
                completedSetup,
                capabilityEvidence,
                ...(pendingRecipeEvidenceId ? { pendingRecipeEvidenceId } : {}),
              },
            };
            const plan = validatePlan({
              ...body,
              digest: preparedDigest(draft, this.project.config.extensions),
            });
            const refreshed: PreparedOperation = {
              ...draft,
              plan,
              reviewSummary: canonicalJson({ ...summaryData(draft), planDigest: plan.digest }),
            };
            await this.store.set('plans', id, refreshed);
            if (
              !(await this.store.compareAndSet('runs', runId, run, {
                ...run,
                status: 'superseded',
                supersededBy: id,
              }))
            )
              throw new Error('Manual checkpoint changed while preparing its fresh review');
            await this.event(runId, 'review-refreshed', { planId: id, completedActions: cursor });
            return refreshed;
          },
        );
      },
    );
  }

  async cancel(runId: string): Promise<void> {
    if (!(await this.store.get<RunRecord>('runs', runId))) throw new Error('Unknown run');
    await this.store.set('cancellation', runId, { requested: true });
  }

  /** Explicit recovery keeps the native fence held until every owned cleanup is measured. */
  async recover(
    target: SelectedTarget,
    previousOperationId: string,
    signal?: AbortSignal,
  ): Promise<{ operationId: string; resolved: number }> {
    this.assertTarget(target);
    const rootScope = new ResourceScope(this.store, target.device.canonicalSerial, previousOperationId);
    const pending = (await rootScope.list()).filter(
      (obligation) => obligation.operationId === previousOperationId && obligation.status !== 'resolved',
    );
    if (pending.length && !this.port.cleanup)
      throw new Error('Typed device cleanup adapter is required for pending recovery obligations');
    const deviceKey = digest({ kind: target.device.kind, serial: target.device.canonicalSerial });
    const transportKey = digest(target.transport.serial);
    const keys = deviceLeaseKeys(deviceKey, transportKey);
    const reservations = await recoveryReservations(this.controlRoot);
    const attempt = await this.store.get<{ operationId: string; deviceSerial: string }>(
      'recovery-attempts',
      previousOperationId,
    );
    await this.ingestNative(previousOperationId);
    if (attempt?.deviceSerial === target.device.canonicalSerial)
      await this.ingestNative(previousOperationId, attempt.operationId);
    const fenced = reservations.find(
      (reservation) =>
        (reservation.operation_id === previousOperationId ||
          reservation.previous_operation_id === previousOperationId ||
          (attempt?.deviceSerial === target.device.canonicalSerial &&
            (reservation.operation_id === attempt.operationId ||
              reservation.previous_operation_id === attempt.operationId))) &&
        reservation.device_key === keys.device &&
        reservation.transport_key === keys.transport,
    );
    const recoverOwned = async (lease: DeviceLease): Promise<{ operationId: string; resolved: number }> => {
      await this.store.set('recovery-attempts', previousOperationId, {
        operationId: lease.operationId,
        deviceSerial: target.device.canonicalSerial,
      });
      try {
        const owners = [...new Set(pending.map((obligation) => obligation.ownerOperationId))];
        for (const owner of owners) {
          const scope = new ResourceScope(
            this.store,
            target.device.canonicalSerial,
            owner,
            previousOperationId,
          );
          await scope.cleanup(
            async (user) => {
              signal?.throwIfAborted();
              if (this.port.inspectUser) return this.port.inspectUser(target, user, signal);
              const actual = (await this.observe(target, signal)).profiles.find(
                (profile) => profile.user.userId === user.userId,
              )?.user;
              if (!actual) throw new Error('Recovery user is absent; preserve the obligation');
              return actual;
            },
            async (obligation) => {
              signal?.throwIfAborted();
              if (obligation.operationId !== previousOperationId || !this.port.cleanup)
                throw new Error('Cleanup owner changed during recovery');
              await this.port.cleanup(target, obligation, {
                lease,
                operationId: obligation.ownerOperationId,
                obligations: {
                  record: (value) => rootScope.record(value),
                  resolve: (id) => rootScope.resolve(id),
                },
                ...(signal ? { signal } : {}),
              });
            },
          );
        }
        if (
          (await rootScope.list()).some(
            (obligation) =>
              obligation.operationId === previousOperationId && obligation.status !== 'resolved',
          )
        )
          throw new Error('Recovery obligations remain unresolved');
        await this.event(previousOperationId, 'recovered', {
          resolved: pending.length,
          recoveryOperationId: lease.operationId,
        });
        return { operationId: previousOperationId, resolved: pending.length };
      } finally {
        await this.ingestNative(previousOperationId, lease.operationId);
      }
    };
    return fenced
      ? withRecoveryLease(this.controlRoot, deviceKey, transportKey, fenced.operation_id, recoverOwned)
      : withDeviceLease(this.controlRoot, deviceKey, transportKey, `recovery-${randomUUID()}`, recoverOwned);
  }

  async execute(runId: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    return withDeviceLease(
      this.controlRoot,
      `project-${this.project.config.id}`,
      `project-${this.project.config.id}`,
      `${randomUUID()}-project`,
      () => this.executeOwned(runId, externalSignal),
    );
  }

  /** One project lease covers a bounded fleet batch; each phone keeps an independent lease. */
  async executeFleet(runIds: string[], jobs = 2, signal?: AbortSignal): Promise<RunRecord[]> {
    if (
      !Number.isInteger(jobs) ||
      jobs < 1 ||
      jobs > 8 ||
      runIds.length > 1000 ||
      new Set(runIds).size !== runIds.length
    )
      throw new Error('Fleet execution requires unique runs and 1 to 8 workers');
    if (!runIds.length) return [];
    const groups = new Map<string, string[]>();
    for (const runId of runIds) {
      const run = await this.store.get<RunRecord>('runs', runId);
      if (!run) throw new Error('Unknown approved run');
      const prepared = await this.plan(run.planId);
      const key = prepared.target.device.canonicalSerial;
      groups.set(key, [...(groups.get(key) ?? []), runId]);
    }
    return withDeviceLease(
      this.controlRoot,
      `project-${this.project.config.id}`,
      `project-${this.project.config.id}`,
      `${randomUUID()}-fleet`,
      async () => {
        const queue = [...groups.values()];
        const results = new Map<string, RunRecord>();
        await Promise.all(
          Array.from({ length: Math.min(jobs, queue.length) }, async () => {
            while (queue.length) {
              const group = queue.shift();
              if (!group) break;
              for (const runId of group) results.set(runId, await this.executeOwned(runId, signal));
            }
          }),
        );
        return runIds.map((id) => {
          const result = results.get(id);
          if (!result) throw new Error('Fleet result missing');
          return result;
        });
      },
    );
  }

  private async saveWorkflow(
    target: SelectedTarget,
    prepared: PreparedOperation,
    observation: DeviceObservation,
    run: RunRecord,
    manualGate?: string,
  ): Promise<WorkflowState> {
    const report = evaluateObservation(this.project.resolved, observation);
    const pending = report.checks.filter((value) => !value.passed).map((value) => value.key);
    if (manualGate) pending.push(`manual:${manualGate}`);
    const state: WorkflowState = {
      schemaVersion: 1,
      assetId: target.device.assetId,
      policyDigest: this.project.resolved.digest,
      planDigest: prepared.plan.digest,
      observation,
      observedAt: this.clock().toISOString(),
      status: pending.length ? 'pending' : 'verified',
      pending,
      languageReady: this.project.policy.profiles.every(
        (profile) =>
          !profile.language ||
          observation.profiles.some(
            (value) => value.profileId === profile.id && value.language === profile.language,
          ),
      ),
      completedSetup: run.completedSetup ?? [],
      planId: prepared.plan.id,
      capabilityEvidence: run.capabilityEvidence ?? [],
    };
    await this.store.set('workflow', target.device.assetId, state);
    return state;
  }

  private async executeOwned(runId: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    const run = await this.store.get<RunRecord>('runs', runId);
    if (!run) throw new Error('Unknown approved run');
    await this.ingestNative(runId);
    const resume =
      run.status === 'pending' && run.manualGate !== undefined && Number.isSafeInteger(run.cursor);
    if (run.status !== 'queued' && !resume) return run; // Interrupted mutations are never replayed.
    const prepared = await this.plan(run.planId);
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error('Execution cancelled'));
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.store
        .get('cancellation', runId)
        .then((value) => {
          if (value) abort();
        })
        .catch(abort)
        .finally(() => {
          polling = false;
        });
    }, 100);
    const target = prepared.target;
    try {
      if (await this.store.get('cancellation', runId)) abort();
      controller.signal.throwIfAborted();
      await withDeviceLease(
        this.controlRoot,
        digest({ kind: target.device.kind, serial: target.device.canonicalSerial }),
        digest(target.transport.serial),
        runId,
        async (lease) => {
          const scope = new ResourceScope(this.store, target.device.canonicalSerial, runId);
          if ((await scope.list()).some((obligation) => obligation.status !== 'resolved'))
            throw new Error(
              'Device has unresolved recovery obligations; recover before executing another operation',
            );
          const context: ExecutionContext = {
            lease,
            signal: controller.signal,
            operationId: runId,
            obligations: {
              record: (obligation) => scope.record(obligation),
              resolve: (id) => scope.resolve(id),
            },
            ...(prepared.osSnapshot ? { osSnapshot: prepared.osSnapshot } : {}),
          };
          let observation =
            prepared.operation === 'install-os'
              ? prepared.baseline
              : await this.observe(target, controller.signal);
          const expected = resume ? (await this.state(target.device.assetId)).observation : prepared.baseline;
          if (resume && (await this.state(target.device.assetId)).planDigest !== prepared.plan.digest)
            throw new Error('Manual checkpoint belongs to a different reviewed plan');
          const pausedAction = resume ? prepared.plan.actions[run.cursor ?? 0] : undefined;
          if (
            run.manualGate?.startsWith('language:') &&
            pausedAction?.kind === 'language' &&
            run.manualGate === `language:${pausedAction.profileId}`
          ) {
            const actual = observation.profiles.find(
              (profile) => profile.profileId === pausedAction.profileId,
            );
            const prior = expected.profiles.find((profile) => profile.profileId === pausedAction.profileId);
            if (!actual || !prior) throw new Error('Manual language profile identity changed');
            const normalized = structuredClone(observation);
            const normalizedProfile = normalized.profiles.find(
              (profile) => profile.profileId === pausedAction.profileId,
            );
            if (!normalizedProfile) throw new Error('Manual language observation is absent');
            if (prior.language) normalizedProfile.language = prior.language;
            else delete normalizedProfile.language;
            if (observationDigest(normalized) !== observationDigest(expected))
              throw new Error('Other live requirements changed during manual language setup');
            if (actual.language !== pausedAction.language) return;
            run.cursor = (run.cursor ?? 0) + 1;
            await this.event(runId, 'language-observed', {
              profileId: pausedAction.profileId,
              source: 'recipient-private-entry',
              observationDigest: observationDigest(observation),
            });
          } else if (observationDigest(observation) !== observationDigest(expected))
            throw new Error('Live state changed since review; prepare again');
          let effects = canonicalEffects(prepared.sharedEffects);
          if (resume) {
            // Completed APK actions have already been observed at the durable manual checkpoint.
            for (const action of prepared.plan.actions.slice(0, run.cursor ?? 0))
              if (action.kind === 'install-apk') {
                const user = observation.profiles.find((value) => value.profileId === action.profileId)?.user;
                if (!user) throw new Error('Installed APK profile identity is missing at checkpoint');
                effects = this.nextEffects(effects, action.artifact, user);
              }
          }
          if (
            digest(
              await this.sharedEffects(
                target,
                effects.map((effect) => effect.packageId),
                controller.signal,
              ),
            ) !== digest(effects)
          )
            throw new Error('Device-wide APK effects changed since review');
          run.status = 'running';
          delete run.manualGate;
          await this.saveRun(run, resume ? 'resumed' : 'started');
          for (let index = run.cursor ?? 0; index < prepared.plan.actions.length; index++) {
            const action = prepared.plan.actions[index];
            if (!action) throw new Error('Plan action cursor is invalid');
            controller.signal.throwIfAborted();
            if (await this.store.get('cancellation', runId)) {
              abort();
              controller.signal.throwIfAborted();
            }
            await this.event(runId, 'intent', {
              kind: action.kind,
              profileId: 'profileId' in action ? action.profileId : '',
            });
            if (action.kind === 'manual') {
              const consumed = run.completedSetup?.some((value) => value.check === action.capability);
              const receipt = (await this.receipts(target.device.assetId)).find(
                (value) =>
                  value.check === action.capability &&
                  value.planDigest === prepared.plan.digest &&
                  value.observationDigest === observationDigest(observation),
              );
              if (!consumed && !receipt) {
                run.status = 'pending';
                run.cursor = index;
                run.manualGate = action.capability;
                await this.saveWorkflow(target, prepared, observation, run, action.capability);
                await this.saveRun(run, 'manual-pending');
                return;
              }
              if (receipt && !consumed)
                run.completedSetup = [
                  ...(run.completedSetup ?? []),
                  { check: action.capability, receiptId: receipt.id, planDigest: receipt.planDigest },
                ];
              run.cursor = index + 1;
              await this.store.set('runs', run.id, run);
              continue;
            }
            if (action.kind === 'install-os') {
              await this.port.flash(target, this.project.policy, context);
              continue;
            }
            const profile = this.project.policy.profiles.find((value) => value.id === action.profileId);
            if (!profile) throw new Error('Plan references an unknown profile');
            const live = await this.observe(target, controller.signal);
            for (const established of observation.profiles) {
              const actual = live.profiles.find((value) => value.profileId === established.profileId);
              if (!actual || !sameUser(actual.user, established.user))
                throw new Error('Android user identity changed during execution');
            }
            if (action.kind === 'create-user') {
              await this.port.createUser(target, profile, context);
            } else {
              const user = live.profiles.find((value) => value.profileId === profile.id)?.user;
              if (!user) throw new Error('Selected Android user is absent');
              switch (action.kind) {
                case 'install-apk': {
                  const effect = effects.find((value) => value.packageId === action.artifact.packageId);
                  if (!effect) throw new Error('APK is absent from reviewed device-wide effects');
                  await this.artifacts.validateBeforeExecution?.(action.artifact, target, controller.signal);
                  await this.port.install(target, user, action.artifact, {
                    ...context,
                    reviewedDeviceWideEffect: { ...effect, toVersionCode: action.artifact.versionCode },
                  });
                  effects = this.nextEffects(effects, action.artifact, user);
                  if (
                    digest(
                      await this.sharedEffects(
                        target,
                        effects.map((value) => value.packageId),
                        controller.signal,
                      ),
                    ) !== digest(effects)
                  )
                    throw new Error('Installed APK effects differ from the reviewed transition');
                  break;
                }
                case 'setting':
                  await this.port.applySetting(target, user, action.setting, context);
                  break;
                case 'permission':
                  await this.port.applyPermission(target, user, action.permission, context);
                  break;
                case 'vpn':
                  await this.port.applyVpn(target, user, action.vpn, context);
                  break;
                case 'recipe': {
                  if (!this.port.runRecipe) throw new Error('Configured recipe adapter is unavailable');
                  const configurationDigest = digest(action.recipe);
                  const evidenceId = `${runId}:recipe:${index}`;
                  const previous = await this.store.get<{
                    status: string;
                    configurationDigest: string;
                    user: AndroidUserIdentity;
                    result: RecipeExecutionResult;
                  }>(
                    'capability-evidence',
                    index === 0 && prepared.refreshedFrom?.pendingRecipeEvidenceId
                      ? prepared.refreshedFrom.pendingRecipeEvidenceId
                      : evidenceId,
                  );
                  let result: RecipeExecutionResult;
                  let status: 'measured' | 'manual-completed';
                  if (previous?.status === 'manual-pending') {
                    if (
                      previous.configurationDigest !== configurationDigest ||
                      !sameUser(previous.user, user)
                    )
                      throw new Error('Recipe checkpoint identity changed');
                    const receipt = (await this.receipts(target.device.assetId)).find(
                      (value) =>
                        value.check === 'app_setup' &&
                        value.planDigest === prepared.plan.digest &&
                        value.observationDigest === observationDigest(live),
                    );
                    if (!receipt) {
                      run.status = 'pending';
                      run.cursor = index;
                      run.manualGate = 'app_setup';
                      await this.saveWorkflow(target, prepared, live, run, 'app_setup');
                      await this.saveRun(run, 'manual-pending');
                      return;
                    }
                    result = previous.result;
                    status = 'manual-completed';
                  } else {
                    result = await this.port.runRecipe(target, user, action.recipe, context);
                    if (
                      result.capability !== 'app-setup' ||
                      result.recipeDigest !== configurationDigest ||
                      !['measured', 'manual-pending'].includes(result.status)
                    )
                      throw new Error('Recipe adapter returned evidence for a different configuration');
                    if (result.status === 'manual-pending') {
                      await this.store.set('capability-evidence', evidenceId, {
                        kind: 'recipe',
                        status: 'manual-pending',
                        runId,
                        policyDigest: prepared.plan.policyDigest,
                        configurationDigest,
                        user,
                        result,
                      });
                      run.status = 'pending';
                      run.cursor = index;
                      run.manualGate = 'app_setup';
                      observation = await this.observe(target, controller.signal);
                      await this.saveWorkflow(target, prepared, observation, run, 'app_setup');
                      await this.saveRun(run, 'manual-pending');
                      return;
                    }
                    if (result.postconditions !== action.recipe.postconditions.length)
                      throw new Error('Recipe postcondition evidence is incomplete');
                    status = 'measured';
                  }
                  await this.store.set('capability-evidence', evidenceId, {
                    kind: 'recipe',
                    status,
                    runId,
                    policyDigest: prepared.plan.policyDigest,
                    configurationDigest,
                    user,
                    app: {
                      packageId: action.recipe.packageId,
                      versionCode: action.recipe.versionCode,
                      signerSha256: action.recipe.signerSha256,
                    },
                    observationDigest: observationDigest(await this.observe(target, controller.signal)),
                    result,
                  });
                  run.capabilityEvidence = [
                    ...(run.capabilityEvidence ?? []).filter((value) => value.evidenceId !== evidenceId),
                    { kind: 'recipe', profileId: profile.id, configurationDigest, evidenceId, status },
                  ];
                  break;
                }
                case 'network-probe': {
                  if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
                  const effect = effects.find((value) => value.packageId === action.probe.artifact.packageId);
                  if (!effect || effect.users.length)
                    throw new Error('Probe helper state differs from its reviewed empty baseline');
                  const priorObligations = new Set((await scope.list()).map((obligation) => obligation.id));
                  await this.artifacts.validateBeforeExecution?.(
                    action.probe.artifact,
                    target,
                    controller.signal,
                  );
                  const result = await this.port.runProbe(target, user, action.probe, {
                    ...context,
                    reviewedDeviceWideEffect: { ...effect, toVersionCode: action.probe.artifact.versionCode },
                  });
                  const route = (value: ProbeObservation): boolean =>
                    Number.isSafeInteger(value.uid) &&
                    value.uid > 0 &&
                    value.requestSucceeded &&
                    value.connectionObserved &&
                    (!action.probe.requireVpn || value.vpnActive) &&
                    typeof value.egressIp === 'string' &&
                    value.egressIp.length > 0;
                  if (
                    result.scope !== 'probe-app-uid-https-only' ||
                    !route(result.normal) ||
                    result.failures.length !== action.probe.failurePackages.length ||
                    result.failures.some(
                      (failure, at) =>
                        failure.stoppedPackage !== action.probe.failurePackages[at] ||
                        failure.stopped.uid !== result.normal.uid ||
                        failure.recovered.uid !== result.normal.uid ||
                        failure.stopped.requestSucceeded ||
                        failure.stopped.connectionObserved ||
                        !failure.stopped.errorType ||
                        !route(failure.recovered),
                    )
                  )
                    throw new Error(
                      'Network probe evidence is incomplete or outside the requested helper UID scope',
                    );
                  if (
                    digest(
                      await this.sharedEffects(
                        target,
                        effects.map((value) => value.packageId),
                        controller.signal,
                      ),
                    ) !== digest(effects) ||
                    (await scope.list()).some(
                      (value) => !priorObligations.has(value.id) && value.status !== 'resolved',
                    )
                  )
                    throw new Error('Network probe cleanup is incomplete');
                  const configurationDigest = digest(profile.networkProbe ?? action.probe);
                  const evidenceId = `${runId}:probe:${index}`;
                  await this.store.set('capability-evidence', evidenceId, {
                    kind: 'network-probe',
                    status: 'measured',
                    runId,
                    policyDigest: prepared.plan.policyDigest,
                    configurationDigest,
                    user,
                    observationDigest: observationDigest(await this.observe(target, controller.signal)),
                    result,
                  });
                  run.capabilityEvidence = [
                    ...(run.capabilityEvidence ?? []),
                    {
                      kind: 'network-probe',
                      profileId: profile.id,
                      configurationDigest,
                      evidenceId,
                      status: 'measured',
                    },
                  ];
                  break;
                }
                case 'language': {
                  const receipts = await this.receipts(target.device.assetId);
                  if (
                    !receipts.some(
                      (value) =>
                        value.check === 'normal_credentials' &&
                        ((value.planDigest === prepared.plan.digest &&
                          value.observationDigest === observationDigest(live)) ||
                          run.completedSetup?.some(
                            (completed) =>
                              completed.check === value.check &&
                              completed.receiptId === value.id &&
                              completed.planDigest === value.planDigest,
                          )),
                    )
                  ) {
                    run.status = 'pending';
                    run.cursor = index;
                    run.manualGate = 'normal_credentials';
                    await this.saveWorkflow(target, prepared, live, run, 'normal_credentials');
                    await this.saveRun(run, 'manual-pending');
                    return;
                  }
                  const result = await this.port.language(target, user, action.language, context);
                  if (result?.status === 'manual-pending') {
                    run.status = 'pending';
                    run.cursor = index;
                    run.manualGate = `language:${profile.id}`;
                    await this.saveWorkflow(target, prepared, live, run, run.manualGate);
                    await this.saveRun(run, 'manual-pending');
                    return;
                  }
                  break;
                }
              }
            }
            observation = await this.observe(target, controller.signal);
            run.cursor = index + 1;
            await this.store.set('runs', run.id, run);
            await this.event(runId, 'observed', {
              kind: action.kind,
              observationDigest: observationDigest(observation),
            });
          }
          if (prepared.operation !== 'install-os') {
            observation = await this.observe(target, controller.signal);
            const state = await this.saveWorkflow(target, prepared, observation, run);
            run.status =
              state.status === 'verified' && prepared.operation !== 'provision' ? 'completed' : 'pending';
          } else run.status = 'pending';
        },
      );
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'needs-inspection';
      run.error = error instanceof Error ? error.message : 'Execution failed; inspect device';
    } finally {
      clearInterval(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
    try {
      await this.ingestNative(runId);
    } catch {
      run.status = 'needs-inspection';
      run.error = 'Native completion receipts are malformed or unavailable; preserve them for inspection';
    }
    await this.saveRun(run, run.status);
    return run;
  }

  async receipts(assetId: string): Promise<OperatorAttestation[]> {
    return ((await this.store.get<OperatorAttestation[]>('attestations', assetId)) ?? []).map(
      validateAttestation,
    );
  }

  async attest(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<OperatorAttestation> {
    return withDeviceLease(
      this.controlRoot,
      digest({ kind: target.device.kind, serial: target.device.canonicalSerial }),
      digest(target.transport.serial),
      randomUUID(),
      () => this.attestOwned(target, check, operator, note, evidence),
    );
  }

  private async attestOwned(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<OperatorAttestation> {
    const state = await this.state(target.device.assetId);
    this.requireFresh(state);
    const live = await this.observe(target);
    if (observationDigest(live) !== observationDigest(state.observation))
      throw new Error('Live state changed; refresh provisioning before recording checks');
    const prepared = state.planId ? await this.plan(state.planId) : undefined;
    const manual =
      prepared?.plan.actions
        .filter((action) => action.kind === 'manual')
        .map((action) => action.capability) ?? [];
    const allowed = [...requiredAttestations(this.project.policy, target.device.kind), ...manual];
    if (!allowed.includes(check)) throw new Error('Check does not belong to this workflow');
    const failures = evaluateObservation(this.project.resolved, live).checks.filter((value) => !value.passed);
    if (
      failures.some(
        (value) => !['normal_credentials', 'app_setup'].includes(check) || !value.key.endsWith('.language'),
      )
    )
      throw new Error('Contradictory measurements cannot be replaced by manual receipts');
    if (check === 'duress') {
      const normal = await this.receipts(target.device.assetId);
      if (
        !state.languageReady ||
        !normal.some(
          (value) =>
            value.check === 'normal_credentials' &&
            ((value.planDigest === state.planDigest && value.observationDigest === observationDigest(live)) ||
              state.completedSetup?.some(
                (consumed) =>
                  consumed.check === value.check &&
                  consumed.receiptId === value.id &&
                  consumed.planDigest === value.planDigest,
              )),
        )
      )
        throw new Error('Normal credentials and final language must be complete before duress setup');
    }
    if (check === 'emulator_image_provenance') {
      if (target.device.kind !== 'emulator' || !evidence || !this.port.verifyEmulatorEvidence)
        throw new Error('Measured emulator image evidence is required; notes cannot substitute');
      const keys = Object.keys(evidence);
      if (
        keys.length !== 4 ||
        keys.some((key) => !['path', 'sha256', 'fingerprint', 'source'].includes(key)) ||
        ![evidence.path, evidence.fingerprint, evidence.source].every(
          (value) => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/u.test(value),
        ) ||
        !/^[a-f0-9]{64}$/u.test(evidence.sha256)
      )
        throw new Error('Invalid emulator image pin');
      const measured = await this.port.verifyEmulatorEvidence(target, evidence);
      const measuredAge = this.clock().getTime() - Date.parse(measured.observedAt);
      if (
        measured.schemaVersion !== 1 ||
        measured.acceptance !== 'emulator-only' ||
        measured.canonicalSerial !== target.device.canonicalSerial ||
        measured.fingerprint !== evidence.fingerprint ||
        measured.imageSha256 !== evidence.sha256 ||
        measured.source !== evidence.source ||
        !Number.isFinite(measuredAge) ||
        measuredAge < 0 ||
        measuredAge > 60_000 ||
        digest([...measured.capabilities].sort()) !== digest([...this.project.policy.capabilities].sort())
      )
        throw new Error('Emulator provenance does not match this device, image and workflow');
      const bound: BoundEmulatorEvidence = {
        measurement: measured,
        observationDigest: observationDigest(live),
        policyDigest: state.policyDigest,
        planDigest: state.planDigest,
      };
      await this.store.set('emulator-provenance', target.device.assetId, bound);
    }
    const receipt = validateAttestation({
      schemaVersion: 1,
      id: randomUUID(),
      planDigest: state.planDigest,
      observationDigest: observationDigest(live),
      check,
      operator,
      recordedAt: this.clock().toISOString(),
      profileIds: this.project.policy.profiles.map((value) => value.id),
      ...(note ? { note } : {}),
    });
    const receipts = (await this.receipts(target.device.assetId)).filter((value) => value.check !== check);
    await this.store.set('attestations', target.device.assetId, [...receipts, receipt]);
    return receipt;
  }

  async state(assetId: string): Promise<WorkflowState> {
    const state = await this.store.get<WorkflowState>('workflow', assetId);
    if (
      !state ||
      state.schemaVersion !== 1 ||
      state.assetId !== assetId ||
      state.policyDigest !== this.project.resolved.digest ||
      !/^[a-f0-9]{64}$/u.test(state.planDigest) ||
      !Array.isArray(state.pending) ||
      state.pending.some((value) => typeof value !== 'string') ||
      typeof state.languageReady !== 'boolean' ||
      !['pending', 'failed', 'verified', 'shutdown-requested', 'completed-custody'].includes(state.status)
    )
      throw new Error('Fresh provisioning evidence is required');
    validateObservation(state.observation);
    return state;
  }

  private requireFresh(state: WorkflowState): void {
    const age = this.clock().getTime() - Date.parse(state.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 900_000)
      throw new Error('Refresh provisioning observations within 15 minutes');
  }

  async readiness(
    target: SelectedTarget,
  ): Promise<{ ready: boolean; missing: string[]; state: WorkflowState }> {
    return this.readinessOwned(target);
  }

  private async nativeReservationsFor(device: SelectedTarget['device']) {
    const keys = device.transports.map((transport) =>
      deviceLeaseKeys(
        digest({ kind: device.kind, serial: device.canonicalSerial }),
        digest(transport.serial),
      ),
    );
    return (await recoveryReservations(this.controlRoot)).filter((reservation) =>
      keys.some(
        (key) => key.device === reservation.device_key || key.transport === reservation.transport_key,
      ),
    );
  }

  private async readinessOwned(
    target: SelectedTarget,
    ownLease?: DeviceLease,
  ): Promise<{ ready: boolean; missing: string[]; state: WorkflowState }> {
    const state = await this.state(target.device.assetId);
    const expected = observationDigest(state.observation);
    const receipts = await this.receipts(target.device.assetId);
    const missing = requiredAttestations(this.project.policy, target.device.kind).filter(
      (check) =>
        !receipts.some(
          (receipt) =>
            receipt.check === check &&
            ((receipt.planDigest === state.planDigest && receipt.observationDigest === expected) ||
              (check === 'normal_credentials' &&
                state.completedSetup?.some(
                  (consumed) =>
                    consumed.check === check &&
                    consumed.receiptId === receipt.id &&
                    consumed.planDigest === receipt.planDigest,
                ))),
        ),
    );
    const scope = new ResourceScope(this.store, target.device.canonicalSerial, 'readiness');
    if ((await scope.list()).some((value) => value.status !== 'resolved')) missing.push('cleanup');
    if (
      (await this.nativeReservationsFor(target.device)).some(
        (reservation) =>
          reservation.operation_id !== ownLease?.operationId || reservation.status !== 'reserved',
      )
    )
      missing.push('native-recovery');
    if (state.observation.helpers.length) missing.push('helper-removal');
    for (const profile of this.project.policy.profiles) {
      const required = [
        ...(profile.recipes ?? []).map((recipe) => ({
          kind: 'recipe' as const,
          configurationDigest: digest(recipe),
          label: `recipe:${profile.id}:${recipe.id}`,
        })),
        ...(profile.networkProbe
          ? [
              {
                kind: 'network-probe' as const,
                configurationDigest: digest(profile.networkProbe),
                label: `probe:${profile.id}`,
              },
            ]
          : []),
      ];
      for (const requirement of required) {
        const reference = state.capabilityEvidence?.find(
          (value) =>
            value.kind === requirement.kind &&
            value.profileId === profile.id &&
            value.configurationDigest === requirement.configurationDigest,
        );
        const proof = reference
          ? await this.store.get<{
              policyDigest: string;
              configurationDigest: string;
              user: AndroidUserIdentity;
              status: string;
            }>('capability-evidence', reference.evidenceId)
          : undefined;
        const user = state.observation.profiles.find((value) => value.profileId === profile.id)?.user;
        if (
          !reference ||
          !proof ||
          !user ||
          proof.policyDigest !== state.policyDigest ||
          proof.configurationDigest !== requirement.configurationDigest ||
          !['measured', 'manual-completed'].includes(proof.status) ||
          !sameUser(proof.user, user)
        )
          missing.push(requirement.label);
      }
    }
    if (target.device.kind === 'emulator') {
      const provenance = await this.store.get<BoundEmulatorEvidence>(
        'emulator-provenance',
        target.device.assetId,
      );
      if (
        !provenance ||
        provenance.observationDigest !== expected ||
        provenance.policyDigest !== state.policyDigest ||
        provenance.planDigest !== state.planDigest
      )
        missing.push('measured-emulator-provenance');
    }
    if (state.status === 'failed' || state.pending.some((value) => value.startsWith('manual:')))
      missing.push(...state.pending.filter((value) => value.startsWith('manual:')));
    missing.push(
      ...evaluateObservation(this.project.resolved, state.observation)
        .checks.filter((value) => !value.passed)
        .map((value) => value.key),
    );
    return { ready: missing.length === 0, missing, state };
  }

  async finalize(
    target: SelectedTarget,
    operator: string,
    locale: 'en' | 'pl' = 'en',
  ): Promise<HandoffRecord> {
    if (
      target.device.kind !== 'pixel' ||
      target.transport.kind !== 'usb' ||
      target.transport.serial !== target.device.canonicalSerial
    )
      throw new Error('Finalization requires the enrolled USB Pixel');
    let record: HandoffRecord | undefined;
    await withDeviceLease(
      this.controlRoot,
      digest({ kind: target.device.kind, serial: target.device.canonicalSerial }),
      digest(target.transport.serial),
      randomUUID(),
      async (lease) => {
        const { ready, missing, state } = await this.readinessOwned(target, lease);
        if (!ready) throw new Error(`Handoff checks remain: ${missing.join(', ')}`);
        this.requireFresh(state);
        const live = await this.observe(target);
        if (
          !evaluateObservation(this.project.resolved, live).passed ||
          observationDigest(live) !== observationDigest(state.observation)
        )
          throw new Error('Live requirements changed after signoff; finalization blocked');
        await this.store.set('workflow', target.device.assetId, {
          ...state,
          status: 'pending',
          pending: ['debugging-shutdown'],
        });
        await this.port.finalize(target, { lease });
        record = validateHandoff({
          schemaVersion: 1,
          id: randomUUID(),
          projectId: this.project.config.id,
          deviceSerial: target.device.canonicalSerial,
          policyDigest: state.policyDigest,
          observationDigest: observationDigest(live),
          locale,
          outcome: 'ready-for-handoff',
          operator,
          createdAt: this.clock().toISOString(),
        });
        const acceptedSnapshot: AcceptedHandoffSnapshot = {
          schemaVersion: 1,
          recordId: record.id,
          assetId: target.device.assetId,
          resolvedPolicy: verifyResolvedPolicy(this.project.resolved),
        };
        await this.store.set('handoff-snapshots', record.id, acceptedSnapshot);
        await this.store.set('handoff', target.device.assetId, record);
        await this.store.set('workflow', target.device.assetId, {
          ...state,
          status: 'shutdown-requested',
          pending: ['physical-debugging-toggle-and-custody-confirmation'],
        });
      },
    );
    if (!record) throw new Error('Finalization did not complete');
    return record;
  }

  async acceptedHandoff(
    assetId: string,
  ): Promise<{ record: HandoffRecord; snapshot: AcceptedHandoffSnapshot }> {
    const stored = await this.store.get<unknown>('handoff', assetId);
    if (!stored) throw new Error('Finalize the device before exporting a handoff packet');
    const record = validateHandoff(stored);
    const snapshot = validateAcceptedHandoffSnapshot(await this.store.get('handoff-snapshots', record.id));
    const resolved = verifyResolvedPolicy(snapshot.resolvedPolicy);
    if (
      snapshot.assetId !== assetId ||
      snapshot.recordId !== record.id ||
      resolved.digest !== record.policyDigest ||
      resolved.project.id !== record.projectId
    )
      throw new Error('Accepted handoff snapshot does not match its receipt');
    return { record, snapshot };
  }

  async acceptCustody(assetId: string, recipient: string, togglesOff: boolean): Promise<HandoffRecord> {
    const record = await this.store.get<HandoffRecord>('handoff', assetId);
    const state = await this.state(assetId);
    if (!record || state.status !== 'shutdown-requested' || !recipient.trim() || !togglesOff)
      throw new Error('Confirm physical debugging shutdown and recipient custody after finalization');
    const device = this.project.inventory.devices.find((value) => value.assetId === assetId);
    if (!device) throw new Error('Custody requires an enrolled device');
    if (record.deviceSerial !== device.canonicalSerial)
      throw new Error('Accepted handoff identity differs from the enrolled device; inspect before custody');
    if ((await this.nativeReservationsFor(device)).length)
      throw new Error('Native recovery or active ownership remains; inspect and recover before custody');
    const accepted = validateHandoff({
      ...record,
      outcome: 'completed-custody',
      acceptedBy: recipient,
      acceptedAt: this.clock().toISOString(),
    });
    await this.store.set('handoff', assetId, accepted);
    await this.store.set('workflow', assetId, { ...state, status: 'completed-custody', pending: [] });
    return accepted;
  }

  async event(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.store.appendEvent(runId, {
      schemaVersion: 1,
      id: randomUUID(),
      runId,
      at: this.clock().toISOString(),
      type,
      data,
    });
  }
  private async ingestNative(runId: string, operationId = runId): Promise<void> {
    for (const receipt of await nativeReceipts(this.controlRoot, operationId)) {
      if (receipt.status !== 'completed') continue;
      await this.store.ingestReceipt(receipt.id, runId, {
        schemaVersion: 1,
        id: receipt.id,
        runId,
        at: this.clock().toISOString(),
        type: 'native-completed',
        data: receipt,
      });
    }
  }

  private async saveRun(run: RunRecord, type: string): Promise<void> {
    await this.store.set('runs', run.id, run);
    await this.event(run.id, type, { status: run.status });
  }
}
