import { digest } from '@pxv/contracts';
import type { DeviceObservation, OperatorAttestation } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { PlanReader } from './plan-repository.js';
import type { CapabilityEvidenceRef, PreparedOperation, RunRecord } from './workflow-types.js';
import { EvidenceValidationError, validateEvidence } from './evidence-validation.js';

export interface ProofContext {
  planId?: string;
  planDigest: string;
  policyDigest: string;
  observation: DeviceObservation;
}
interface ObservationEvent {
  type: string;
  data?: { kind?: string; observationDigest?: string };
}
/** One operation shares authenticated plan, run and paginated receipt lookups. */
export class ProofQuery {
  private readonly plans = new Map<string, Promise<PreparedOperation>>();
  private readonly runs = new Map<string, Promise<RunRecord>>();
  private receipts: Promise<Map<string, OperatorAttestation>> | undefined;
  private readonly observations = new Map<string, Promise<Set<string>>>();
  constructor(
    readonly verifier: { project: ProjectContext; store: Store; plans: PlanReader },
    readonly context: ProofContext,
  ) {}
  plan(id: string): Promise<PreparedOperation> {
    let value = this.plans.get(id);
    if (!value) {
      value = this.verifier.plans.read(id, undefined, true).then((plan) =>
        validateEvidence(() => {
          if (
            plan.plan.id !== id ||
            plan.plan.policyDigest !== this.context.policyDigest ||
            plan.target.device.assetId !== this.context.observation.device.assetId ||
            plan.target.device.canonicalSerial !== this.context.observation.device.canonicalSerial
          )
            throw new EvidenceValidationError('VPN source plan identity changed');
          return plan;
        }),
      );
      this.plans.set(id, value);
    }
    return value;
  }
  run(id: string): Promise<RunRecord> {
    let value = this.runs.get(id);
    if (!value) {
      value = this.verifier.store.get<RunRecord>('runs', id).then((run) => {
        if (!run || run.id !== id) throw new EvidenceValidationError('VPN source run is missing or changed');
        validateEvidence(() => {
          if (typeof run.planId !== 'string' || !run.planId)
            throw new EvidenceValidationError('Malformed capability source run');
          for (const references of [run.completedSetup, run.capabilityEvidence])
            if (
              references !== undefined &&
              (!Array.isArray(references) || references.some((value) => !value || typeof value !== 'object'))
            )
              throw new EvidenceValidationError('Malformed VPN source run evidence');
        });
        return run;
      });
      this.runs.set(id, value);
    }
    return value;
  }
  runId(plan: PreparedOperation): string {
    return digest({ project: this.verifier.project.config.id, plan: plan.plan.digest });
  }
  hasReference(values: CapabilityEvidenceRef[] | undefined, reference: CapabilityEvidenceRef): boolean {
    return validateEvidence(() => !!values?.some((value) => digest(value) === digest(reference)));
  }
  async lineage(
    proof: { planId: string; actionIndex: number },
    reference: CapabilityEvidenceRef,
  ): Promise<void> {
    if (!this.context.planId) throw new EvidenceValidationError('VPN current plan is missing');
    let current = await this.plan(this.context.planId);
    if (current.plan.digest !== this.context.planDigest)
      throw new EvidenceValidationError('VPN current plan changed');
    const run = await this.run(this.runId(current));
    if (
      run.planId !== current.plan.id ||
      !['pending', 'completed'].includes(run.status) ||
      !this.hasReference(run.capabilityEvidence, reference)
    )
      throw new EvidenceValidationError('VPN evidence is not part of the current execution');
    const visited = new Set<string>();
    while (current.plan.id !== proof.planId) {
      if (visited.has(current.plan.id))
        throw new EvidenceValidationError('VPN review lineage contains a cycle');
      visited.add(current.plan.id);
      current = await this.predecessor(current, proof, reference);
    }
  }
  private async predecessor(
    current: PreparedOperation,
    proof: { planId: string; actionIndex: number },
    reference: CapabilityEvidenceRef,
  ): Promise<PreparedOperation> {
    const edge = current.refreshedFrom;
    if (!edge || !this.hasReference(edge.capabilityEvidence, reference))
      throw new EvidenceValidationError('VPN evidence was not carried through this review');
    const run = await this.run(edge.runId);
    const previous = await this.plan(run.planId);
    this.checkEdge(current, previous, run);
    if (!this.hasReference(run.capabilityEvidence, reference))
      throw new EvidenceValidationError('VPN source reference changed');
    if (previous.plan.id === proof.planId && proof.actionIndex >= edge.completedActions)
      throw new EvidenceValidationError('VPN action is outside the carried completed prefix');
    return previous;
  }
  private checkEdge(current: PreparedOperation, previous: PreparedOperation, run: RunRecord): void {
    const edge = current.refreshedFrom!;
    if (
      run.id !== this.runId(previous) ||
      run.status !== 'superseded' ||
      run.supersededBy !== current.plan.id ||
      edge.planDigest !== previous.plan.digest ||
      !Number.isSafeInteger(edge.completedActions) ||
      edge.completedActions < 0 ||
      edge.completedActions > previous.plan.actions.length ||
      digest(previous.plan.actions.slice(edge.completedActions)) !== digest(current.plan.actions)
    )
      throw new EvidenceValidationError('VPN review lineage changed');
  }
  auditReceipts(): Promise<Map<string, OperatorAttestation>> {
    return (this.receipts ??= this.readAuditReceipts());
  }
  async requireObservation(runId: string, kind: string, observationDigest: string): Promise<void> {
    let observed = this.observations.get(runId);
    if (!observed) {
      observed = this.observationAudit(runId);
      this.observations.set(runId, observed);
    }
    if (!(await observed).has(`${kind}:${observationDigest}`))
      throw new EvidenceValidationError('Capability observation checkpoint is missing or changed');
  }
  private async observationAudit(runId: string): Promise<Set<string>> {
    const observed = new Set<string>();
    let after = 0;
    for (;;) {
      const page = await this.verifier.store.events<ObservationEvent>(runId, after, 100);
      if (!page.length) return observed;
      after = validateEvidence(() => {
        for (const { sequence, event } of page) {
          if (
            !Number.isSafeInteger(sequence) ||
            sequence <= after ||
            !event ||
            typeof event.type !== 'string'
          )
            throw new EvidenceValidationError('Malformed capability observation audit page');
          after = sequence;
          this.collectObservation(event, observed);
        }
        return after;
      });
    }
  }
  private collectObservation(event: ObservationEvent, observed: Set<string>): void {
    if (event.type !== 'observed') return;
    if (
      !event.data ||
      typeof event.data.kind !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(event.data.observationDigest ?? '')
    )
      throw new EvidenceValidationError('Malformed capability observation checkpoint');
    observed.add(`${event.data.kind}:${event.data.observationDigest}`);
  }
  private async readAuditReceipts(): Promise<Map<string, OperatorAttestation>> {
    const receipts = new Map<string, OperatorAttestation>();
    let after = 0;
    for (;;) {
      const page = await this.verifier.store.events<{ type: string; receipt?: OperatorAttestation }>(
        `asset:${this.context.observation.device.assetId}`,
        after,
        100,
      );
      if (!page.length) return receipts;
      after = this.collectAuditPage(page, receipts, after);
    }
  }
  private collectAuditPage(
    page: { sequence: number; event: { type: string; receipt?: OperatorAttestation } }[],
    receipts: Map<string, OperatorAttestation>,
    after: number,
  ): number {
    return validateEvidence(() => {
      for (const { sequence, event } of page) {
        if (!Number.isSafeInteger(sequence) || sequence <= after)
          throw new EvidenceValidationError('Malformed attestation audit page');
        after = sequence;
        if (event.type !== 'attestation' || !event.receipt) continue;
        const previous = receipts.get(event.receipt.id);
        if (previous && digest(previous) !== digest(event.receipt))
          throw new EvidenceValidationError('Conflicting attestation audit receipt');
        receipts.set(event.receipt.id, event.receipt);
      }
      return after;
    });
  }
}
