import { randomUUID } from 'node:crypto';
import {
  digest,
  evaluateObservation,
  observationDigest,
  requiredAttestations,
  validateAttestation,
  type DeviceObservation,
  type OperatorAttestation,
  type SelectedTarget,
} from '@pxv/contracts';
import type { Store, RecordChange } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { ObservationReader } from './observation-service.js';
import type { EvidenceReader } from './evidence-service.js';
import type { PlanReader } from './plan-repository.js';
import type { DeviceOwnership, ProjectOwnership } from './ownership.js';
import type {
  BoundEmulatorEvidence,
  EmulatorImagePin,
  EmulatorProvenance,
  WorkflowPort,
  WorkflowState,
} from './workflow-types.js';
import { normalReceiptMatches } from './setup-evidence.js';

export class AttestationService {
  constructor(
    private readonly project: ProjectContext,
    private readonly store: Store,
    private readonly port: WorkflowPort,
    private readonly observations: ObservationReader,
    private readonly evidence: EvidenceReader,
    private readonly plans: PlanReader,
    private readonly ownership: DeviceOwnership,
    private readonly projects: ProjectOwnership,
    private readonly clock: () => Date,
  ) {}
  async attest(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<OperatorAttestation> {
    return this.projects.run(() =>
      this.ownership.run(target, randomUUID(), () =>
        this.attestOwned(target, check, operator, note, evidence),
      ),
    );
  }

  private async attestOwned(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<OperatorAttestation> {
    const state = await this.evidence.state(target.device.assetId);
    this.evidence.requireFresh(state);
    const live = await this.observations.observe(target);
    if (observationDigest(live) !== observationDigest(state.observation))
      throw new Error('Live state changed; refresh provisioning before recording checks');
    await this.assertAttestationAllowed(target, state, live, check);
    const provenance =
      check === 'emulator_image_provenance'
        ? await this.measureEmulatorEvidence(target, state, live, evidence)
        : undefined;
    const receipt = this.createAttestation(state, live, check, operator, note);
    await this.commitAttestation(target.device.assetId, state, receipt, provenance);
    return receipt;
  }
  private async assertAttestationAllowed(
    target: SelectedTarget,
    state: WorkflowState,
    live: DeviceObservation,
    check: string,
  ): Promise<void> {
    const prepared = state.planId ? await this.plans.read(state.planId) : undefined;
    const manual =
      prepared?.plan.actions
        .filter((action) => action.kind === 'manual')
        .map((action) => action.capability) ?? [];
    if (![...requiredAttestations(this.project.policy, target.device.kind), ...manual].includes(check))
      throw new Error('Check does not belong to this workflow');
    const failures = evaluateObservation(this.project.resolved, live).checks.filter((value) => !value.passed);
    if (
      failures.some(
        (value) => !['normal_credentials', 'app_setup'].includes(check) || !value.key.endsWith('.language'),
      )
    )
      throw new Error('Contradictory measurements cannot be replaced by manual receipts');
    if (check !== 'duress') return;
    const receipts = await this.evidence.receipts(target.device.assetId);
    if (
      !state.languageReady ||
      !receipts.some((value) => normalReceiptMatches(value, state.planDigest, live, state.completedSetup))
    )
      throw new Error('Normal credentials and final language must be complete before duress setup');
  }
  private validateEmulatorPin(evidence: EmulatorImagePin): void {
    const keys = Object.keys(evidence);
    const validText = (value: unknown): boolean =>
      typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/u.test(value);
    if (
      keys.length !== 4 ||
      keys.some((key) => !['path', 'sha256', 'fingerprint', 'source'].includes(key)) ||
      ![evidence.path, evidence.fingerprint, evidence.source].every(validText) ||
      !/^[a-f0-9]{64}$/u.test(evidence.sha256)
    )
      throw new Error('Invalid emulator image pin');
  }
  private sameEmulatorSource(
    target: SelectedTarget,
    pin: EmulatorImagePin,
    value: EmulatorProvenance,
  ): boolean {
    return (
      value.schemaVersion === 1 &&
      value.acceptance === 'emulator-only' &&
      value.canonicalSerial === target.device.canonicalSerial &&
      value.fingerprint === pin.fingerprint &&
      value.imageSha256 === pin.sha256 &&
      value.source === pin.source
    );
  }
  private validEmulatorMeasurement(
    target: SelectedTarget,
    pin: EmulatorImagePin,
    value: EmulatorProvenance,
  ): boolean {
    const age = this.clock().getTime() - Date.parse(value.observedAt);
    return (
      this.sameEmulatorSource(target, pin, value) &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= 60_000 &&
      digest([...value.capabilities].sort()) === digest([...this.project.policy.capabilities].sort())
    );
  }
  private async measureEmulatorEvidence(
    target: SelectedTarget,
    state: WorkflowState,
    live: DeviceObservation,
    pin?: EmulatorImagePin,
  ): Promise<BoundEmulatorEvidence> {
    if (target.device.kind !== 'emulator' || !pin || !this.port.verifyEmulatorEvidence)
      throw new Error('Measured emulator image evidence is required; notes cannot substitute');
    this.validateEmulatorPin(pin);
    const measurement = await this.port.verifyEmulatorEvidence(target, pin);
    if (!this.validEmulatorMeasurement(target, pin, measurement))
      throw new Error('Emulator provenance does not match this device, image and workflow');
    return {
      measurement,
      observationDigest: observationDigest(live),
      policyDigest: state.policyDigest,
      planDigest: state.planDigest,
    };
  }
  private createAttestation(
    state: WorkflowState,
    live: DeviceObservation,
    check: string,
    operator: string,
    note?: string,
  ): OperatorAttestation {
    return validateAttestation({
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
  }
  private async commitAttestation(
    assetId: string,
    state: WorkflowState,
    receipt: OperatorAttestation,
    provenance?: BoundEmulatorEvidence,
  ): Promise<void> {
    const original = await this.store.get<unknown>('attestations', assetId);
    const values = this.evidence.parseReceipts(original).filter((value) => value.check !== receipt.check);
    const changes: RecordChange[] = [
      { kind: 'set', collection: 'attestations', key: assetId, value: [...values, receipt] },
    ];
    if (provenance)
      changes.push({ kind: 'set', collection: 'emulator-provenance', key: assetId, value: provenance });
    const committed = await this.store.transition({
      expected: [
        { collection: 'workflow', key: assetId, value: state },
        { collection: 'attestations', key: assetId, value: original },
      ],
      changes,
      events: [{ runId: `asset:${assetId}`, value: { type: 'attestation', receipt } }],
    });
    if (!committed) throw new Error('Asset evidence changed before attestation; refresh measurements');
  }
}
