import { randomUUID } from 'node:crypto';
import {
  evaluateObservation,
  observationDigest,
  validateHandoff,
  validateAcceptedHandoffSnapshot,
  verifyResolvedPolicy,
  type HandoffRecord,
  type AcceptedHandoffSnapshot,
  type SelectedTarget,
} from '@pxv/contracts';
import type { Store, DeviceLease } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { ObservationReader } from './observation-service.js';
import type { EvidenceReader } from './evidence-service.js';
import type { DeviceOwnership, ProjectOwnership } from './ownership.js';
import type { WorkflowPort, WorkflowState } from './workflow-types.js';
import { custodyRun, custodyCompletionEvent } from './custody-completion.js';

export class HandoffService {
  constructor(
    private readonly project: ProjectContext,
    private readonly store: Store,
    private readonly port: WorkflowPort,
    private readonly observations: ObservationReader,
    private readonly evidence: EvidenceReader,
    private readonly ownership: DeviceOwnership,
    private readonly projects: ProjectOwnership,
    private readonly clock: () => Date,
  ) {}
  async finalize(
    target: SelectedTarget,
    operator: string,
    locale: 'en' | 'pl' = 'en',
  ): Promise<HandoffRecord> {
    return this.projects.run(() => this.finalizeAuthorized(target, operator, locale), {
      requirePolicyLock: true,
    });
  }
  private async finalizeAuthorized(
    target: SelectedTarget,
    operator: string,
    locale: 'en' | 'pl',
  ): Promise<HandoffRecord> {
    if (
      target.device.kind !== 'pixel' ||
      target.transport.kind !== 'usb' ||
      target.transport.serial !== target.device.canonicalSerial
    )
      throw new Error('Finalization requires the enrolled USB Pixel');
    return this.ownership.run(target, randomUUID(), (lease) =>
      this.finalizeOwned(target, operator, locale, lease),
    );
  }
  private async finalizeOwned(
    target: SelectedTarget,
    operator: string,
    locale: 'en' | 'pl',
    lease: DeviceLease,
  ): Promise<HandoffRecord> {
    const assetId = target.device.assetId;
    const attestations = await this.store.get('attestations', assetId);
    const handoff = await this.store.get('handoff', assetId);
    const { ready, missing, state } = await this.evidence.readiness(target, lease);
    this.evidence.requireFresh(state);
    if (!ready) throw new Error(`Handoff checks remain: ${missing.join(', ')}`);
    const live = await this.observations.observe(target);
    if (
      !evaluateObservation(this.project.resolved, live).passed ||
      observationDigest(live) !== observationDigest(state.observation)
    )
      throw new Error('Live requirements changed after signoff; finalization blocked');
    const record = validateHandoff({
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
    const intent = { ...state, status: 'pending', pending: ['debugging-shutdown'] };
    const committed = await this.store.transition({
      expected: [
        { collection: 'workflow', key: assetId, value: state },
        { collection: 'attestations', key: assetId, value: attestations },
        { collection: 'handoff', key: assetId, value: handoff },
      ],
      changes: [{ kind: 'set', collection: 'workflow', key: assetId, value: intent }],
      events: [
        { runId: `asset:${assetId}`, value: { type: 'debugging-shutdown-intent', recordId: record.id } },
      ],
    });
    if (!committed) throw new Error('Asset evidence changed before finalization; inspect before retrying');
    await this.port.finalize(target, { lease });
    await this.commitHandoff(assetId, record, state, intent, handoff);
    return record;
  }
  private async commitHandoff(
    assetId: string,
    record: HandoffRecord,
    state: WorkflowState,
    intent: unknown,
    previousHandoff: unknown,
  ): Promise<void> {
    const snapshot: AcceptedHandoffSnapshot = {
      schemaVersion: 1,
      recordId: record.id,
      assetId,
      resolvedPolicy: verifyResolvedPolicy(this.project.resolved),
    };
    const committed = await this.store.transition({
      expected: [
        { collection: 'workflow', key: assetId, value: intent },
        { collection: 'handoff', key: assetId, value: previousHandoff },
        { collection: 'handoff-snapshots', key: record.id, value: undefined },
      ],
      changes: [
        { kind: 'set', collection: 'handoff-snapshots', key: record.id, value: snapshot },
        { kind: 'set', collection: 'handoff', key: assetId, value: record },
        {
          kind: 'set',
          collection: 'workflow',
          key: assetId,
          value: {
            ...state,
            status: 'shutdown-requested',
            pending: ['physical-debugging-toggle-and-custody-confirmation'],
          },
        },
      ],
      events: [{ runId: `asset:${assetId}`, value: { type: 'ready-for-handoff', record } }],
    });
    if (!committed) throw new Error('Asset evidence changed during finalization; inspect before retrying');
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
    return this.projects.run(() => this.acceptCustodyAuthorized(assetId, recipient, togglesOff));
  }
  private async acceptCustodyAuthorized(
    assetId: string,
    recipient: string,
    togglesOff: boolean,
  ): Promise<HandoffRecord> {
    const device = this.project.inventory.devices.find((value) => value.assetId === assetId);
    if (!device) throw new Error('Custody requires an enrolled device');
    if ((await this.ownership.reservations(device)).length)
      throw new Error('Native recovery or active ownership remains; inspect and recover before custody');
    const transport = device.transports.find((value) => value.kind === 'usb') ?? device.transports[0];
    if (!transport) throw new Error('Custody requires an enrolled transport');
    return this.ownership.run({ device, transport }, `custody-${randomUUID()}`, (lease) =>
      this.acceptCustodyOwned(assetId, recipient, togglesOff, device, lease),
    );
  }

  private async acceptCustodyOwned(
    assetId: string,
    recipient: string,
    togglesOff: boolean,
    device: SelectedTarget['device'],
    lease: DeviceLease,
  ): Promise<HandoffRecord> {
    const record = await this.store.get<HandoffRecord>('handoff', assetId);
    const state = await this.evidence.state(assetId);
    if (!record || state.status !== 'shutdown-requested' || !recipient.trim() || !togglesOff)
      throw new Error('Confirm physical debugging shutdown and recipient custody after finalization');
    if (record.deviceSerial !== device.canonicalSerial)
      throw new Error('Accepted handoff identity differs from the enrolled device; inspect before custody');
    if (
      (await this.ownership.reservations(device)).some(
        (value) => value.operation_id !== lease.operationId || value.status !== 'reserved',
      )
    )
      throw new Error('Native recovery or active ownership remains; inspect and recover before custody');
    const accepted = validateHandoff({
      ...record,
      outcome: 'completed-custody',
      acceptedBy: recipient,
      acceptedAt: this.clock().toISOString(),
    });
    const run = await custodyRun(this.store, state, record);
    if (
      !(await this.store.transition({
        expected: [
          { collection: 'handoff', key: assetId, value: record },
          { collection: 'workflow', key: assetId, value: state },
          { collection: 'runs', key: run.previous.id, value: run.previous },
        ],
        changes: [
          { kind: 'set', collection: 'handoff', key: assetId, value: accepted },
          { kind: 'set', collection: 'runs', key: run.previous.id, value: run.next },
          {
            kind: 'set',
            collection: 'workflow',
            key: assetId,
            value: { ...state, status: 'completed-custody', pending: [] },
          },
        ],
        events: [
          { runId: `asset:${assetId}`, value: { type: 'custody-accepted', record: accepted } },
          {
            runId: run.previous.id,
            value: custodyCompletionEvent(run.previous.id, accepted),
          },
        ],
      }))
    )
      throw new Error('Asset evidence changed before custody; inspect before retrying');
    return accepted;
  }
}
