import {
  digest,
  evaluateObservation,
  observationDigest,
  requiredAttestations,
  validateAttestation,
  vpnSettingsRequirement,
} from '@pxv/contracts';
import type { SelectedTarget, OperatorAttestation, ProfilePolicy } from '@pxv/contracts';
import type { Store, DeviceLease } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { ResourceScope } from './recovery.js';
import type { ObservationReader } from './observation-service.js';
import type { DeviceOwnership } from './ownership.js';
import type { WorkflowState, CapabilityRequirement, BoundEmulatorEvidence } from './workflow-types.js';
import { normalReceiptMatches } from './setup-evidence.js';
import { validateStoredWorkflow } from './stored-workflow.js';
import { hasFinalizationIntent } from './finalization-guard.js';
import { policyLockStatus } from './policy-lock.js';
import type { CapabilityProofVerifier, CapabilityProofSession } from './capability-proof-verifier.js';
interface Readiness {
  ready: boolean;
  missing: string[];
  state: WorkflowState;
}
type UnavailableReason = 'missing-workflow' | 'baseline-changed' | 'invalid-workflow';
export type ReadinessAssessment =
  | (Readiness & { readinessStatus: 'available' })
  | {
      readinessStatus: 'unavailable';
      readinessUnavailableReason: UnavailableReason;
      ready: false;
      missing: string[];
      state?: never;
    };
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
    readonly proofs: CapabilityProofVerifier,
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
    const state = validateStoredWorkflow(await this.store.get('workflow', assetId), assetId);
    if (state.policyDigest !== this.project.resolved.digest)
      throw new Error('Fresh provisioning evidence is required');
    return state;
  }
  private measurementFresh(state: WorkflowState): boolean {
    const age = this.clock().getTime() - Date.parse(state.observedAt);
    return Number.isFinite(age) && age >= 0 && age <= 900_000;
  }
  requireFresh(state: WorkflowState): void {
    if (!this.measurementFresh(state)) throw new Error('Refresh provisioning observations within 15 minutes');
  }
  async readiness(
    target: SelectedTarget,
    ownLease?: DeviceLease,
  ): Promise<{ ready: boolean; missing: string[]; state: WorkflowState }> {
    this.observations.assertTarget(target);
    const state = await this.state(target.device.assetId);
    return this.evaluateReadiness(target, state, ownLease);
  }
  async reportReadiness(target: SelectedTarget): Promise<ReadinessAssessment> {
    this.observations.assertTarget(target);
    const stored = await this.store.get('workflow', target.device.assetId);
    if (stored === undefined) return this.unavailableReadiness('missing-workflow');
    let state: WorkflowState;
    try {
      state = validateStoredWorkflow(stored, target.device.assetId);
    } catch {
      return this.unavailableReadiness('invalid-workflow');
    }
    if (state.policyDigest !== this.project.resolved.digest)
      return this.unavailableReadiness('baseline-changed', hasFinalizationIntent(state));
    return { ...(await this.evaluateReadiness(target, state)), readinessStatus: 'available' };
  }
  private async unavailableReadiness(
    reason: UnavailableReason,
    finalization = false,
  ): Promise<ReadinessAssessment> {
    const missing = ['readiness-unavailable'];
    if (finalization) missing.push('finalization-inspection');
    if ((await policyLockStatus(this.project)) !== 'current') missing.push('policy-lock');
    return { readinessStatus: 'unavailable', readinessUnavailableReason: reason, ready: false, missing };
  }
  private async evaluateReadiness(
    target: SelectedTarget,
    state: WorkflowState,
    ownLease?: DeviceLease,
  ): Promise<Readiness> {
    const receipts = await this.receipts(target.device.assetId);
    const missing = requiredAttestations(this.project.policy, target.device.kind).filter(
      (check) => !receipts.some((receipt) => this.receiptReady(check, receipt, state)),
    );
    if (!this.measurementFresh(state)) missing.push('measurement-freshness');
    if ((await policyLockStatus(this.project)) !== 'current') missing.push('policy-lock');
    if (state.status === 'failed') missing.push('execution-inspection');
    if (state.pending.includes('debugging-shutdown')) missing.push('finalization-inspection');
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
    const required: CapabilityRequirement[] = [
      {
        kind: 'vpn-settings',
        configurationDigest: digest(profile.vpn),
        label: vpnSettingsRequirement(profile).id,
      },
      ...(profile.recipes ?? []).map((recipe) => ({
        kind: 'recipe' as const,
        configurationDigest: digest(recipe),
        label: `recipe:${profile.id}:${recipe.id}`,
      })),
    ];
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
    const vpn = this.proofs.session(state);
    for (const profile of this.project.policy.profiles)
      for (const requirement of this.capabilityRequirements(profile)) {
        if (!(await this.capabilityReady(profile, requirement, state, vpn))) missing.push(requirement.label);
      }
    return missing;
  }
  private async capabilityReady(
    profile: ProfilePolicy,
    requirement: CapabilityRequirement,
    state: WorkflowState,
    vpn: CapabilityProofSession,
  ): Promise<boolean> {
    const reference = state.capabilityEvidence?.find(
      (value) =>
        value.kind === requirement.kind &&
        value.profileId === profile.id &&
        value.configurationDigest === requirement.configurationDigest,
    );
    if (!reference) return false;
    return vpn.valid(reference);
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
