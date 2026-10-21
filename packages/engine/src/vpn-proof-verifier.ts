import { digest } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { PlanReader } from './plan-repository.js';
import type { CapabilityEvidenceRef, PreparedOperation, RunRecord } from './workflow-types.js';
import { EvidenceValidationError } from './evidence-validation.js';

import type { VpnSettingsProof } from './workflow-types.js';
import { validVpnProof } from './vpn-evidence.js';
import { ProofQuery, type ProofContext } from './proof-query.js';

export class VpnProofVerifier {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly plans: PlanReader,
  ) {}
  session(context: ProofContext, query = new ProofQuery(this, context)): VpnProofSession {
    return new VpnProofSession(this, context, query);
  }
}
/** VPN-specific validation shares its operation's provenance query. */
export class VpnProofSession {
  constructor(
    readonly verifier: VpnProofVerifier,
    readonly context: ProofContext,
    readonly query = new ProofQuery(verifier, context),
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
      await this.query.lineage(proof, reference);
      const receipts = await this.query.auditReceipts();
      return digest(receipts.get(proof.receipt.id) ?? null) === digest(proof.receipt);
    } catch (error) {
      if (error instanceof EvidenceValidationError) return false;
      throw error;
    }
  }
  async assert(reference: CapabilityEvidenceRef): Promise<void> {
    if (!(await this.valid(reference)))
      throw new EvidenceValidationError(
        'Completed VPN Settings evidence changed or its execution provenance is missing; preserve it for inspection and prepare a newly reviewed provisioning run',
      );
  }
  private async source(proof: VpnSettingsProof, reference: CapabilityEvidenceRef): Promise<void> {
    const plan = await this.query.plan(proof.planId);
    const run = await this.query.run(proof.runId);
    if (!this.sourceActionMatches(plan, proof) || !this.sourceRunMatches(plan, run, proof, reference))
      throw new EvidenceValidationError('VPN source action was not completed by this run');
    if (
      !run.completedSetup?.some(
        (receipt) =>
          receipt.check === 'vpn_settings' &&
          receipt.receiptId === proof.receipt.id &&
          receipt.planDigest === proof.planDigest &&
          (receipt.actionIndex === undefined || receipt.actionIndex === proof.actionIndex),
      )
    )
      throw new EvidenceValidationError('VPN witness receipt was not consumed');
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
      proof.runId === this.query.runId(plan) &&
      run.planId === proof.planId &&
      Number.isSafeInteger(cursor) &&
      cursor > proof.actionIndex &&
      cursor <= plan.plan.actions.length &&
      this.query.hasReference(run.capabilityEvidence, reference)
    );
  }
}
