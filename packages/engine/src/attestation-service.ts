import { randomUUID } from 'node:crypto';
import {
  digest,
  evaluateObservation,
  observationDigest,
  requiredAttestations,
  validateAttestation,
  type Action,
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
  PreparedOperation,
  RunRecord,
} from './workflow-types.js';
import { normalReceiptMatches } from './setup-evidence.js';
import { pausedVpnAction, checkVpnDelta } from './vpn-evidence.js';
import { assertFinalizationResolved } from './finalization-guard.js';

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
    return this.projects.run(
      () =>
        this.ownership.run(target, randomUUID(), () =>
          this.attestOwned(target, check, operator, note, evidence),
        ),
      { requirePolicyLock: true },
    );
  }

  private async attestOwned(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<OperatorAttestation> {
    await assertFinalizationResolved(this.store, target.device.assetId);
    const state = await this.evidence.state(target.device.assetId);
    this.evidence.requireFresh(state);
    const live = await this.observations.observe(target);
    const vpn = check === 'vpn_settings' ? await this.vpnCheckpoint(state) : undefined;
    if (vpn) {
      checkVpnDelta(state.observation, live, vpn);
      if (digest(live.profiles.find((value) => value.profileId === vpn.profileId)?.vpn) !== digest(vpn.vpn))
        throw new Error('Configure the reviewed VPN Settings before confirming this profile');
    } else if (observationDigest(live) !== observationDigest(state.observation))
      throw new Error('Live state changed; refresh provisioning before recording checks');
    await this.assertAttestationAllowed(target, state, live, check, vpn);
    const provenance =
      check === 'emulator_image_provenance'
        ? await this.measureEmulatorEvidence(target, state, live, evidence)
        : undefined;
    const receipt = this.createAttestation(state, live, check, operator, note, vpn?.profileId);
    await this.commitAttestation(target.device.assetId, state, receipt, provenance);
    return receipt;
  }
  private async vpnCheckpoint(state: WorkflowState): Promise<Extract<Action, { kind: 'vpn' }> | undefined> {
    if (!state.planId) return undefined;
    const prepared = await this.plans.read(state.planId, undefined, true);
    const run = await this.store.get<RunRecord>(
      'runs',
      digest({ project: this.project.config.id, plan: prepared.plan.digest }),
    );
    return pausedVpnAction(prepared, run);
  }
  private async assertAttestationAllowed(
    target: SelectedTarget,
    state: WorkflowState,
    live: DeviceObservation,
    check: string,
    vpn?: Extract<Action, { kind: 'vpn' }>,
  ): Promise<void> {
    const prepared = state.planId ? await this.plans.read(state.planId, undefined, true) : undefined;
    const manual =
      prepared?.plan.actions
        .filter((action) => action.kind === 'manual')
        .map((action) => action.capability) ?? [];
    if (
      check === 'vpn_settings'
        ? !vpn
        : ![...requiredAttestations(this.project.policy, target.device.kind), ...manual].includes(check)
    )
      throw new Error('Check does not belong to this workflow');
    await this.assertSetupMeasurements(check, state, live, prepared);
    if (check !== 'duress') return;
    const receipts = await this.evidence.receipts(target.device.assetId);
    if (
      !state.languageReady ||
      !receipts.some((value) => normalReceiptMatches(value, state.planDigest, live, state.completedSetup))
    )
      throw new Error('Normal credentials and final language must be complete before duress setup');
  }
  private async assertSetupMeasurements(
    check: string,
    state: WorkflowState,
    live: DeviceObservation,
    prepared: PreparedOperation | undefined,
  ): Promise<void> {
    const failures = evaluateObservation(this.project.resolved, live).checks.filter((value) => !value.passed);
    const deferredVpn = await this.deferredVpnChecks(check, state, prepared);
    if (failures.some((value) => !this.pendingSetupCheck(check, value.key, deferredVpn)))
      throw new Error('Contradictory measurements cannot be replaced by manual receipts');
  }
  private async deferredVpnChecks(
    check: string,
    state: WorkflowState,
    prepared: PreparedOperation | undefined,
  ): Promise<string[]> {
    if (
      !['app_setup', 'vpn_settings'].includes(check) ||
      !state.pending.includes(`manual:${check}`) ||
      !prepared
    )
      return [];
    const runId = digest({ project: this.project.config.id, plan: prepared.plan.digest });
    const run = await this.store.get<RunRecord>('runs', runId);
    const cursor =
      check === 'vpn_settings' && pausedVpnAction(prepared, run)
        ? run?.cursor
        : this.appSetupCursor(run, prepared);
    if (cursor === undefined) return [];
    return prepared.plan.actions
      .slice(cursor + 1)
      .filter((action) => action.kind === 'vpn')
      .map((action) => `${action.profileId}.vpn`);
  }
  private appSetupCursor(run: RunRecord | undefined, prepared: PreparedOperation): number | undefined {
    if (run?.status !== 'pending' || run.manualGate !== 'app_setup' || !Number.isSafeInteger(run.cursor))
      return undefined;
    const action = prepared.plan.actions[run.cursor ?? -1];
    return this.isAppSetupAction(action) ? run.cursor : undefined;
  }
  private isAppSetupAction(action: Action | undefined): boolean {
    return action?.kind === 'recipe' || (action?.kind === 'manual' && action.capability === 'app_setup');
  }
  private pendingSetupCheck(check: string, key: string, deferredVpn: string[]): boolean {
    return (
      (['normal_credentials', 'app_setup', 'vpn_settings'].includes(check) && key.endsWith('.language')) ||
      deferredVpn.includes(key)
    );
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
    profileId?: string,
  ): OperatorAttestation {
    return validateAttestation({
      schemaVersion: 1,
      id: randomUUID(),
      planDigest: state.planDigest,
      observationDigest: observationDigest(live),
      check,
      operator,
      recordedAt: this.clock().toISOString(),
      profileIds: profileId ? [profileId] : this.project.policy.profiles.map((value) => value.id),
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
