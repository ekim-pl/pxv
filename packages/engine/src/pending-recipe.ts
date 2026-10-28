import { digest, sameAndroidUser, validateAttestation, validateUserIdentity } from '@pxv/contracts';
import type { Action, AndroidUserIdentity, DeviceObservation } from '@pxv/contracts';
import type { ExpectedRecord, Store } from '@pxv/runtime';
import type { PlanReader } from './plan-repository.js';
import type { ProjectContext } from './project.js';
import type { CapabilityProof, PreparedOperation, RecipeProof, RunRecord } from './workflow-types.js';
import { validateRecipeResult } from './capability-results.js';
import { EvidenceValidationError, validateEvidence } from './evidence-validation.js';
import { ProofQuery } from './proof-query.js';

type RecipeAction = Extract<Action, { kind: 'recipe' }>;
interface PendingProof extends RecipeProof, CapabilityProof {
  kind: 'recipe';
  status: 'manual-pending';
  runId: string;
  policyDigest: string;
  app: { packageId: string; versionCode: number; signerSha256: string };
  previousReceiptId: string | null;
}
export interface PendingRecipeCheckpoint {
  evidenceId: string;
  actionIndex: number;
  proof: PendingProof;
  expected: ExpectedRecord[];
}
function requireCheckpoint(value: unknown): asserts value {
  if (!value)
    throw new EvidenceValidationError(
      'Paused recipe evidence changed or is missing; preserve it for inspection',
    );
}
function validatePendingProof(
  input: unknown,
  action: RecipeAction,
  user: AndroidUserIdentity | undefined,
  policyDigest: string,
): PendingProof {
  return validateEvidence(() => {
    const proof = input as PendingProof;
    requireCheckpoint(proof && user && proof.kind === 'recipe' && proof.status === 'manual-pending');
    requireCheckpoint(
      proof.policyDigest === policyDigest && proof.configurationDigest === digest(action.recipe),
    );
    requireCheckpoint(sameAndroidUser(validateUserIdentity(proof.user), user));
    const { packageId, versionCode, signerSha256 } = action.recipe;
    requireCheckpoint(digest(proof.app) === digest({ packageId, versionCode, signerSha256 }));
    requireCheckpoint(
      proof.previousReceiptId === null ||
        (typeof proof.previousReceiptId === 'string' && proof.previousReceiptId.length > 0),
    );
    validateRecipeResult(action.recipe, proof.result, 'manual-pending');
    return proof;
  });
}
/** A single query authenticates direct and carried checkpoints and retains raw CAS expectations. */
export class PendingRecipeQuery {
  private readonly expected = new Map<string, ExpectedRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly plans = new Map<string, PreparedOperation>();
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly reader: PlanReader,
    readonly currentRun: RunRecord,
  ) {}
  async read(
    prepared: PreparedOperation,
    observation: DeviceObservation,
  ): Promise<PendingRecipeCheckpoint | undefined> {
    const paused = this.pausedAction(prepared);
    if (!paused) return;
    const { index, action, evidenceId } = paused;
    const raw = await this.store.get('capability-evidence', evidenceId);
    const user = observation.profiles.find((value) => value.profileId === action.profileId)?.user;
    const proof = validatePendingProof(raw, action, user, prepared.plan.policyDigest);
    const match = /^([a-f0-9]{64}):recipe:(0|[1-9][0-9]*)$/u.exec(evidenceId);
    requireCheckpoint(match && proof.runId === match[1]);
    this.remember('capability-evidence', evidenceId, raw);
    this.rememberPlan(prepared);
    const source = await this.lineage(prepared, proof.runId, Number(match[2]), evidenceId, action);
    await this.priorReceipt(proof, source, observation);
    return { evidenceId, actionIndex: index, proof, expected: [...this.expected.values()] };
  }
  private pausedAction(prepared: PreparedOperation) {
    const index = this.currentRun.cursor ?? 0;
    const action = prepared.plan.actions[index];
    const carried = index === 0 ? prepared.refreshedFrom?.pendingRecipeEvidenceId : undefined;
    if (action?.kind !== 'recipe' || (!carried && this.currentRun.manualGate !== 'app_setup')) return;
    const evidenceId = carried ?? `${this.currentRun.id}:recipe:${index}`;
    return { index, action, evidenceId };
  }
  private runId(prepared: PreparedOperation): string {
    return digest({ project: this.project.config.id, plan: prepared.plan.digest });
  }
  private remember(collection: string, key: string, value: unknown): void {
    if (collection === 'runs' && key === this.currentRun.id) return;
    this.expected.set(`${collection}:${key}`, { collection, key, value: structuredClone(value) });
  }
  private rememberPlan(plan: PreparedOperation): PreparedOperation {
    this.plans.set(plan.plan.id, plan);
    this.remember('plans', plan.plan.id, plan);
    return plan;
  }
  private async plan(id: string): Promise<PreparedOperation> {
    const cached = this.plans.get(id);
    if (cached) return cached;
    return this.rememberPlan(await this.reader.read(id, undefined, true));
  }
  private async run(id: string): Promise<RunRecord> {
    const cached = this.runs.get(id);
    if (cached) return cached;
    const run = await this.store.get<RunRecord>('runs', id);
    requireCheckpoint(run && run.id === id);
    this.runs.set(id, run);
    this.remember('runs', id, run);
    return run;
  }
  private async lineage(
    current: PreparedOperation,
    sourceId: string,
    sourceIndex: number,
    evidenceId: string,
    action: RecipeAction,
  ): Promise<PreparedOperation> {
    const source = await this.run(sourceId);
    const sourcePlan = await this.plan(source.planId);
    const visited = new Set<string>();
    requireCheckpoint(
      this.currentRun.id === this.runId(current) && this.currentRun.planId === current.plan.id,
    );
    requireCheckpoint(
      sourcePlan.target.device.assetId === current.target.device.assetId &&
        sourcePlan.target.device.canonicalSerial === current.target.device.canonicalSerial,
    );
    while (current.plan.id !== sourcePlan.plan.id) {
      requireCheckpoint(!visited.has(current.plan.id));
      visited.add(current.plan.id);
      current = await this.predecessor(current, evidenceId);
    }
    validateEvidence(() => {
      const original = sourcePlan.plan.actions[sourceIndex];
      requireCheckpoint(
        source.id === this.runId(sourcePlan) &&
          source.cursor === sourceIndex &&
          source.manualGate === 'app_setup',
      );
      requireCheckpoint(source.status === (source.id === this.currentRun.id ? 'pending' : 'superseded'));
      requireCheckpoint(original?.kind === 'recipe' && digest(original) === digest(action));
    });
    return sourcePlan;
  }
  private async priorReceipt(
    proof: PendingProof,
    source: PreparedOperation,
    observation: DeviceObservation,
  ): Promise<void> {
    if (proof.previousReceiptId === null) return;
    const query = new ProofQuery(
      { project: this.project, store: this.store, plans: this.reader },
      {
        planId: source.plan.id,
        planDigest: source.plan.digest,
        policyDigest: source.plan.policyDigest,
        observation,
      },
    );
    const retained = (await query.auditReceipts()).get(proof.previousReceiptId);
    validateEvidence(() => {
      const receipt = validateAttestation(retained);
      requireCheckpoint(receipt.check === 'app_setup' && receipt.planDigest === source.plan.digest);
    });
  }
  private async predecessor(current: PreparedOperation, evidenceId: string): Promise<PreparedOperation> {
    const edge = current.refreshedFrom;
    requireCheckpoint(edge && edge.pendingRecipeEvidenceId === evidenceId);
    const parent = await this.run(edge.runId);
    const previous = await this.plan(parent.planId);
    validateEvidence(() => {
      requireCheckpoint(
        parent.id === this.runId(previous) &&
          parent.status === 'superseded' &&
          parent.supersededBy === current.plan.id &&
          edge.planDigest === previous.plan.digest,
      );
      requireCheckpoint(
        Number.isSafeInteger(edge.completedActions) &&
          edge.completedActions >= 0 &&
          edge.completedActions === parent.cursor &&
          edge.completedActions < previous.plan.actions.length,
      );
      requireCheckpoint(
        digest(previous.plan.actions.slice(edge.completedActions)) === digest(current.plan.actions),
      );
    });
    return previous;
  }
}
