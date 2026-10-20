import { digest } from '@pxv/contracts';
import type { DeviceObservation, OperatorAttestation } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { PlanReader } from './plan-repository.js';
import type {
  CapabilityEvidenceRef,
  PreparedOperation,
  RunRecord,
  VpnSettingsProof,
} from './workflow-types.js';
import { validVpnProof } from './vpn-evidence.js';

interface ProofContext {
  planId?: string;
  planDigest: string;
  policyDigest: string;
  observation: DeviceObservation;
}
export class VpnProofVerifier {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly plans: PlanReader,
  ) {}
  session(context: ProofContext): VpnProofSession {
    return new VpnProofSession(this, context);
  }
}
/** Caches belong to one readiness/refresh operation, never to the lifetime of a service. */
export class VpnProofSession {
  private readonly plans = new Map<string, Promise<PreparedOperation>>();
  private readonly runs = new Map<string, Promise<RunRecord>>();
  private receipts: Promise<Map<string, OperatorAttestation>> | undefined;
  constructor(
    readonly verifier: VpnProofVerifier,
    readonly context: ProofContext,
  ) {}
  async valid(reference: CapabilityEvidenceRef): Promise<boolean> {
    try {
      const proof = await this.verifier.store.get<unknown>('capability-evidence', reference.evidenceId);
      if (
        !validVpnProof(proof, reference.evidenceId, {
          ...reference,
          user: this.context.observation.profiles.find((value) => value.profileId === reference.profileId)
            ?.user,
          policyDigest: this.context.policyDigest,
          assetId: this.context.observation.device.assetId,
          deviceSerial: this.context.observation.device.canonicalSerial,
        })
      )
        return false;
      await this.source(proof, reference);
      await this.lineage(proof, reference);
      const receipts = await (this.receipts ??= this.auditReceipts());
      return digest(receipts.get(proof.receipt.id) ?? null) === digest(proof.receipt);
    } catch {
      return false;
    }
  }
  async assert(reference: CapabilityEvidenceRef): Promise<void> {
    if (!(await this.valid(reference)))
      throw new Error(
        'Completed VPN Settings evidence changed or its execution provenance is missing; preserve it for inspection and prepare a newly reviewed provisioning run',
      );
  }
  private plan(id: string): Promise<PreparedOperation> {
    let value = this.plans.get(id);
    if (!value) {
      value = this.verifier.plans.read(id, undefined, true).then((plan) => {
        if (
          plan.plan.id !== id ||
          plan.plan.policyDigest !== this.context.policyDigest ||
          plan.target.device.assetId !== this.context.observation.device.assetId ||
          plan.target.device.canonicalSerial !== this.context.observation.device.canonicalSerial
        )
          throw new Error('VPN source plan identity changed');
        return plan;
      });
      this.plans.set(id, value);
    }
    return value;
  }
  private run(id: string): Promise<RunRecord> {
    let value = this.runs.get(id);
    if (!value) {
      value = this.verifier.store.get<RunRecord>('runs', id).then((run) => {
        if (!run || run.id !== id) throw new Error('VPN source run is missing or changed');
        return run;
      });
      this.runs.set(id, value);
    }
    return value;
  }
  private runId(plan: PreparedOperation): string {
    return digest({ project: this.verifier.project.config.id, plan: plan.plan.digest });
  }
  private hasReference(
    values: CapabilityEvidenceRef[] | undefined,
    reference: CapabilityEvidenceRef,
  ): boolean {
    return !!values?.some((value) => digest(value) === digest(reference));
  }
  private async source(proof: VpnSettingsProof, reference: CapabilityEvidenceRef): Promise<void> {
    const plan = await this.plan(proof.planId);
    const run = await this.run(proof.runId);
    if (!this.sourceActionMatches(plan, proof) || !this.sourceRunMatches(plan, run, proof, reference))
      throw new Error('VPN source action was not completed by this run');
    if (
      !run.completedSetup?.some(
        (receipt) =>
          receipt.check === 'vpn_settings' &&
          receipt.receiptId === proof.receipt.id &&
          receipt.planDigest === proof.planDigest &&
          (receipt.actionIndex === undefined || receipt.actionIndex === proof.actionIndex),
      )
    )
      throw new Error('VPN witness receipt was not consumed');
  }
  private sourceActionMatches(plan: PreparedOperation, proof: VpnSettingsProof): boolean {
    const action = plan.plan.actions[proof.actionIndex];
    return (
      plan.plan.digest === proof.planDigest &&
      action?.kind === 'vpn' &&
      action.profileId === proof.profileId &&
      digest(action.vpn) === proof.configurationDigest
    );
  }
  private sourceRunMatches(
    plan: PreparedOperation,
    run: RunRecord,
    proof: VpnSettingsProof,
    reference: CapabilityEvidenceRef,
  ): boolean {
    const cursor = run.cursor ?? -1;
    return (
      proof.runId === this.runId(plan) &&
      run.planId === proof.planId &&
      Number.isSafeInteger(cursor) &&
      cursor > proof.actionIndex &&
      cursor <= plan.plan.actions.length &&
      this.hasReference(run.capabilityEvidence, reference)
    );
  }
  private async lineage(proof: VpnSettingsProof, reference: CapabilityEvidenceRef): Promise<void> {
    if (!this.context.planId) throw new Error('VPN current plan is missing');
    let current = await this.plan(this.context.planId);
    if (current.plan.digest !== this.context.planDigest) throw new Error('VPN current plan changed');
    const run = await this.run(this.runId(current));
    if (run.planId !== current.plan.id || !this.hasReference(run.capabilityEvidence, reference))
      throw new Error('VPN evidence is not part of the current execution');
    const visited = new Set<string>();
    while (current.plan.id !== proof.planId) {
      if (visited.has(current.plan.id)) throw new Error('VPN review lineage contains a cycle');
      visited.add(current.plan.id);
      current = await this.predecessor(current, proof, reference);
    }
  }
  private async predecessor(
    current: PreparedOperation,
    proof: VpnSettingsProof,
    reference: CapabilityEvidenceRef,
  ): Promise<PreparedOperation> {
    const edge = current.refreshedFrom;
    if (!edge || !this.hasReference(edge.capabilityEvidence, reference))
      throw new Error('VPN evidence was not carried through this review');
    const run = await this.run(edge.runId);
    const previous = await this.plan(run.planId);
    this.checkEdge(current, previous, run);
    if (!this.hasReference(run.capabilityEvidence, reference))
      throw new Error('VPN source reference changed');
    if (previous.plan.id === proof.planId && proof.actionIndex >= edge.completedActions)
      throw new Error('VPN action is outside the carried completed prefix');
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
      throw new Error('VPN review lineage changed');
  }
  private async auditReceipts(): Promise<Map<string, OperatorAttestation>> {
    const receipts = new Map<string, OperatorAttestation>();
    let after = 0;
    for (;;) {
      const page = await this.verifier.store.events<{ type: string; receipt?: OperatorAttestation }>(
        `asset:${this.context.observation.device.assetId}`,
        after,
        100,
      );
      if (!page.length) return receipts;
      for (const { sequence, event } of page) {
        if (!Number.isSafeInteger(sequence) || sequence <= after)
          throw new Error('Malformed attestation audit page');
        after = sequence;
        if (event.type !== 'attestation' || !event.receipt) continue;
        const previous = receipts.get(event.receipt.id);
        if (previous && digest(previous) !== digest(event.receipt))
          throw new Error('Conflicting attestation audit receipt');
        receipts.set(event.receipt.id, event.receipt);
      }
    }
  }
}
