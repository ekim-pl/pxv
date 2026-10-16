import {
  digest,
  evaluateObservation,
  observationDigest,
  requiredAttestations,
  validateAttestation,
  validateObservation,
  sameAndroidUser as sameUser,
} from '@pxv/contracts';
import type { SelectedTarget, OperatorAttestation, ProfilePolicy, AndroidUserIdentity } from '@pxv/contracts';
import type { Store, DeviceLease } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { ResourceScope } from './recovery.js';
import type { ObservationReader } from './observation-service.js';
import type { DeviceOwnership } from './ownership.js';
import type { WorkflowState, CapabilityRequirement, BoundEmulatorEvidence } from './workflow-types.js';
import { normalReceiptMatches } from './setup-evidence.js';
export interface EvidenceReader {
  state(assetId: string): Promise<WorkflowState>;
  requireFresh(state: WorkflowState): void;
  receipts(assetId: string): Promise<OperatorAttestation[]>;
  parseReceipts(value: unknown): OperatorAttestation[];
  readiness(
    target: SelectedTarget,
    ownLease?: DeviceLease,
  ): Promise<{ ready: boolean; missing: string[]; state: WorkflowState }>;
}
export class EvidenceService implements EvidenceReader {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly observations: ObservationReader,
    readonly ownership: DeviceOwnership,
    readonly clock: () => Date,
  ) {}
  async receipts(assetId: string): Promise<OperatorAttestation[]> {
    return this.parseReceipts(await this.store.get<unknown>('attestations', assetId));
  }
  parseReceipts(value: unknown): OperatorAttestation[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Malformed attestations retained for inspection');
    return value.map(validateAttestation);
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
  requireFresh(state: WorkflowState): void {
    const age = this.clock().getTime() - Date.parse(state.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 900_000)
      throw new Error('Refresh provisioning observations within 15 minutes');
  }
  async readiness(
    target: SelectedTarget,
    ownLease?: DeviceLease,
  ): Promise<{ ready: boolean; missing: string[]; state: WorkflowState }> {
    this.observations.assertTarget(target);
    const state = await this.state(target.device.assetId);
    const receipts = await this.receipts(target.device.assetId);
    const missing = requiredAttestations(this.project.policy, target.device.kind).filter(
      (check) => !receipts.some((receipt) => this.receiptReady(check, receipt, state)),
    );
    if (state.status === 'failed') missing.push('execution-inspection');
    missing.push(
      ...(await this.missingResources(target, ownLease)),
      ...(await this.missingCapabilities(state)),
    );
    if (state.observation.helpers.length) missing.push('helper-removal');
    if (target.device.kind === 'emulator' && !(await this.emulatorReady(target, state)))
      missing.push('measured-emulator-provenance');
    missing.push(...state.pending.filter((value) => value.startsWith('manual:')));
    missing.push(
      ...evaluateObservation(this.project.resolved, state.observation)
        .checks.filter((value) => !value.passed)
        .map((value) => value.key),
    );
    return { ready: missing.length === 0, missing, state };
  }
  private receiptReady(check: string, receipt: OperatorAttestation, state: WorkflowState): boolean {
    if (receipt.check !== check) return false;
    if (check === 'normal_credentials')
      return normalReceiptMatches(receipt, state.planDigest, state.observation, state.completedSetup);
    return (
      receipt.planDigest === state.planDigest &&
      receipt.observationDigest === observationDigest(state.observation)
    );
  }
  private async missingResources(target: SelectedTarget, ownLease?: DeviceLease): Promise<string[]> {
    const missing: string[] = [];
    const scope = new ResourceScope(this.store, target.device.canonicalSerial, 'readiness');
    if ((await scope.list()).some((value) => value.status !== 'resolved')) missing.push('cleanup');
    if (
      (await this.ownership.reservations(target.device)).some(
        (value) => value.operation_id !== ownLease?.operationId || value.status !== 'reserved',
      )
    )
      missing.push('native-recovery');
    return missing;
  }
  private capabilityRequirements(profile: ProfilePolicy): CapabilityRequirement[] {
    const required: CapabilityRequirement[] = (profile.recipes ?? []).map((recipe) => ({
      kind: 'recipe',
      configurationDigest: digest(recipe),
      label: `recipe:${profile.id}:${recipe.id}`,
    }));
    if (profile.networkProbe)
      required.push({
        kind: 'network-probe',
        configurationDigest: digest(profile.networkProbe),
        label: `probe:${profile.id}`,
      });
    return required;
  }
  private async missingCapabilities(state: WorkflowState): Promise<string[]> {
    const missing: string[] = [];
    for (const profile of this.project.policy.profiles)
      for (const requirement of this.capabilityRequirements(profile)) {
        if (!(await this.capabilityReady(profile, requirement, state))) missing.push(requirement.label);
      }
    return missing;
  }
  private async capabilityReady(
    profile: ProfilePolicy,
    requirement: CapabilityRequirement,
    state: WorkflowState,
  ): Promise<boolean> {
    const reference = state.capabilityEvidence?.find(
      (value) =>
        value.kind === requirement.kind &&
        value.profileId === profile.id &&
        value.configurationDigest === requirement.configurationDigest,
    );
    if (!reference) return false;
    const proof = await this.store.get<{
      policyDigest: string;
      configurationDigest: string;
      user: AndroidUserIdentity;
      status: string;
    }>('capability-evidence', reference.evidenceId);
    const user = state.observation.profiles.find((value) => value.profileId === profile.id)?.user;
    return (
      !!proof &&
      !!user &&
      proof.policyDigest === state.policyDigest &&
      proof.configurationDigest === requirement.configurationDigest &&
      ['measured', 'manual-completed'].includes(proof.status) &&
      sameUser(proof.user, user)
    );
  }
  private async emulatorReady(target: SelectedTarget, state: WorkflowState): Promise<boolean> {
    const proof = await this.store.get<BoundEmulatorEvidence>('emulator-provenance', target.device.assetId);
    return (
      !!proof &&
      proof.observationDigest === observationDigest(state.observation) &&
      proof.policyDigest === state.policyDigest &&
      proof.planDigest === state.planDigest
    );
  }
}
