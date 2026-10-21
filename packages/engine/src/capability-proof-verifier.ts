import { type Action, type NetworkProbePolicy, digest, validateAttestation } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { PlanReader } from './plan-repository.js';
import type { CapabilityEvidenceRef, PreparedOperation, RunRecord } from './workflow-types.js';
import { ProofQuery, type ProofContext } from './proof-query.js';
import { VpnProofVerifier, type VpnProofSession } from './vpn-proof-verifier.js';
import { EvidenceValidationError, validateEvidence } from './evidence-validation.js';
import {
  validateCapabilityProof,
  validateRecipeResult,
  validateProbeResult,
  type RetainedCapabilityProof,
} from './capability-results.js';
import { sameArtifact } from './reviewed-plan.js';

export class CapabilityProofVerifier {
  private readonly vpn: VpnProofVerifier;
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly plans: PlanReader,
  ) {
    this.vpn = new VpnProofVerifier(project, store, plans);
  }
  session(context: ProofContext): CapabilityProofSession {
    const query = new ProofQuery(this, context);
    return new CapabilityProofSession(this, query, this.vpn.session(context, query));
  }
}
export class CapabilityProofSession {
  constructor(
    readonly verifier: CapabilityProofVerifier,
    readonly query: ProofQuery,
    readonly vpn: VpnProofSession,
  ) {}
  async valid(reference: CapabilityEvidenceRef): Promise<boolean> {
    if (reference.kind === 'vpn-settings') return this.vpn.valid(reference);
    try {
      const raw = await this.verifier.store.get('capability-evidence', reference.evidenceId);
      const proof = validateCapabilityProof(
        raw,
        reference,
        this.query.context.observation.profiles.find((p) => p.profileId === reference.profileId)?.user,
        this.query.context.policyDigest,
      );
      const run = await this.query.run(proof.runId);
      const plan = await this.query.plan(run.planId);
      const index = validateEvidence(() => this.source(proof, reference, run, plan));
      await this.query.requireObservation(
        proof.runId,
        proof.kind === 'recipe' ? 'recipe' : 'network-probe',
        proof.observationDigest,
      );
      await this.query.lineage({ planId: plan.plan.id, actionIndex: index }, reference);
      if (proof.status === 'manual-completed') await this.witness(proof, reference, run, plan, index);
      return true;
    } catch (error) {
      if (error instanceof EvidenceValidationError) return false;
      throw error;
    }
  }
  async assert(reference: CapabilityEvidenceRef): Promise<void> {
    if (reference.kind === 'vpn-settings') return this.vpn.assert(reference);
    if (!(await this.valid(reference)))
      throw new EvidenceValidationError(
        'Completed capability evidence changed or its execution provenance is missing; preserve it for inspection',
      );
  }
  private source(
    proof: RetainedCapabilityProof,
    reference: CapabilityEvidenceRef,
    run: RunRecord,
    plan: PreparedOperation,
  ): number {
    const index = this.sourceIndex(proof, reference.evidenceId);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !this.sourceRun(run, plan, index) ||
      !this.query.hasReference(run.capabilityEvidence, reference)
    )
      throw new EvidenceValidationError('Capability source action was not completed by this run');
    const action = plan.plan.actions[index];
    const profile = this.verifier.project.policy.profiles.find((p) => p.id === reference.profileId);
    if (!action || !('profileId' in action) || action.profileId !== reference.profileId || !profile)
      throw new EvidenceValidationError('Capability source profile changed');
    this.configuration(proof, action, profile.networkProbe);
    return index;
  }
  private sourceIndex(proof: RetainedCapabilityProof, evidenceId: string): number {
    const tag = proof.kind === 'recipe' ? 'recipe' : 'probe';
    const match = new RegExp(`^${proof.runId}:${tag}:(0|[1-9][0-9]*)$`, 'u').exec(evidenceId);
    return match ? Number(match[1]) : -1;
  }
  private sourceRun(run: RunRecord, plan: PreparedOperation, index: number): boolean {
    return (
      run.id === this.query.runId(plan) &&
      run.planId === plan.plan.id &&
      ['pending', 'completed', 'superseded'].includes(run.status) &&
      Number.isSafeInteger(run.cursor) &&
      run.cursor! > index &&
      run.cursor! <= plan.plan.actions.length
    );
  }
  private configuration(
    proof: RetainedCapabilityProof,
    action: Action,
    probe: NetworkProbePolicy | undefined,
  ): void {
    if (proof.kind === 'recipe' && action.kind === 'recipe') this.recipe(proof, action);
    else if (proof.kind === 'network-probe' && action.kind === 'network-probe' && probe)
      this.probe(proof, action, probe);
    else throw new EvidenceValidationError('Capability source action changed');
  }
  private recipe(proof: RetainedCapabilityProof, action: Extract<Action, { kind: 'recipe' }>): void {
    if (
      digest(action.recipe) !== proof.configurationDigest ||
      digest(proof.app) !==
        digest({
          packageId: action.recipe.packageId,
          versionCode: action.recipe.versionCode,
          signerSha256: action.recipe.signerSha256,
        })
    )
      throw new EvidenceValidationError('Recipe source configuration changed');
    validateRecipeResult(action.recipe, proof.result, proof.status);
  }
  private probe(
    proof: RetainedCapabilityProof,
    action: Extract<Action, { kind: 'network-probe' }>,
    probe: NetworkProbePolicy,
  ): void {
    const { artifact, ...settings } = action.probe;
    const { artifact: configured, ...expected } = probe;
    if (
      proof.status !== 'measured' ||
      digest(probe) !== proof.configurationDigest ||
      digest(settings) !== digest(expected) ||
      !sameArtifact(artifact, configured)
    )
      throw new EvidenceValidationError('Probe source configuration changed');
    validateProbeResult(action.probe, proof.result, proof.user);
  }
  private async witness(
    proof: RetainedCapabilityProof,
    reference: CapabilityEvidenceRef,
    run: RunRecord,
    plan: PreparedOperation,
    index: number,
  ): Promise<void> {
    const consumed = validateEvidence(() => {
      const singleSetup =
        plan.plan.actions
          .slice(0, run.cursor)
          .filter((a) => a.kind === 'recipe' || (a.kind === 'manual' && a.capability === 'app_setup'))
          .length === 1;
      const matches = (run.completedSetup ?? []).filter(
        (r) =>
          r.check === 'app_setup' &&
          r.planDigest === plan.plan.digest &&
          (r.actionIndex === index || (r.actionIndex === undefined && singleSetup)),
      );
      if (matches.length !== 1)
        throw new EvidenceValidationError('Recipe witness receipt was not consumed unambiguously');
      return matches[0]!;
    });
    const receipts = await this.query.auditReceipts();
    validateEvidence(() => {
      const receipt = validateAttestation(receipts.get(consumed.receiptId));
      if (
        receipt.check !== 'app_setup' ||
        receipt.planDigest !== plan.plan.digest ||
        receipt.observationDigest !== proof.observationDigest ||
        !receipt.profileIds.includes(reference.profileId)
      )
        throw new EvidenceValidationError('Recipe witness audit evidence changed');
    });
  }
}
