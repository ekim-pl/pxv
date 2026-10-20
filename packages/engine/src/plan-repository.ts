import { canonicalJson, validatePlan, validateObservation } from '@pxv/contracts';
import type { Action, SelectedTarget, DeviceObservation, SharedApkEffect } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import type { PreparedOperation, Operation, OsSnapshot, ReviewLineage } from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import { preparedDigest, summaryData, canonicalEffects } from './reviewed-plan.js';
import { planGeneration, assertPlanGeneration } from './plan-generation.js';
import { assertApprovedProject } from './policy-lock.js';
export interface PreparedDraft {
  id: string;
  target: SelectedTarget;
  operation: Operation;
  baseline: DeviceObservation;
  actions: Action[];
  sharedEffects: SharedApkEffect[];
  osSnapshot?: OsSnapshot;
  refreshedFrom?: ReviewLineage;
  lifecycleGeneration?: string;
  capabilities?: PreparedOperation['capabilities'];
}
export interface PlanReader {
  read(id: string, summary?: string, allowExpired?: boolean): Promise<PreparedOperation>;
}
export interface PlanWriter extends PlanReader {
  generation(assetId: string): Promise<string | undefined>;
  persist(input: PreparedDraft): Promise<PreparedOperation>;
}
export class PlanRepository implements PlanWriter {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly observations: ObservationReader,
    readonly clock: () => Date,
  ) {}
  generation(assetId: string): Promise<string | undefined> {
    return planGeneration(this.store, assetId);
  }
  async persist(input: PreparedDraft): Promise<PreparedOperation> {
    await assertApprovedProject(this.project);
    await assertPlanGeneration(this.store, input.target.device.assetId, input.lifecycleGeneration);
    const body = {
      schemaVersion: 1 as const,
      id: input.id,
      projectId: this.project.config.id,
      device: input.target.device,
      policyDigest: this.project.resolved.digest,
      createdAt: this.clock().toISOString(),
      actions: input.actions,
    };
    const draft = {
      schemaVersion: 1 as const,
      plan: { ...body, digest: '0'.repeat(64) },
      target: input.target,
      operation: input.operation,
      baseline: input.baseline,
      sharedEffects: input.sharedEffects,
      expiresAt: new Date(this.clock().getTime() + 900_000).toISOString(),
      ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
      ...(input.osSnapshot ? { osSnapshot: input.osSnapshot } : {}),
      ...(input.refreshedFrom ? { refreshedFrom: input.refreshedFrom } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    };
    const plan = validatePlan({ ...body, digest: preparedDigest(draft, this.project.config.extensions) });
    const prepared = {
      ...draft,
      plan,
      reviewSummary: canonicalJson({ ...summaryData(draft), planDigest: plan.digest }),
    };
    await this.store.set('plans', input.id, prepared);
    return prepared;
  }
  async read(id: string, summary?: string, allowExpired = false): Promise<PreparedOperation> {
    const value = await this.store.get<PreparedOperation>('plans', id);
    if (!value) throw new Error('Reviewed plan does not exist');
    this.validatePreparedEvidence(value);
    await assertPlanGeneration(this.store, value.target.device.assetId, value.lifecycleGeneration);
    if (
      value.plan.projectId !== this.project.config.id ||
      value.plan.policyDigest !== this.project.resolved.digest
    )
      throw new Error('Project policy or extensions changed; prepare a new plan');
    if (summary !== undefined && value.reviewSummary !== summary)
      throw new Error('Approval must match the exact reviewed summary');
    if (!allowExpired && Date.parse(value.expiresAt) < this.clock().getTime())
      throw new Error('Reviewed plan expired; prepare again');
    return value;
  }
  private validatePreparedEvidence(value: PreparedOperation): void {
    validatePlan(value.plan);
    validateObservation(value.baseline);
    this.observations.assertTarget(value.target);
    canonicalEffects(value.sharedEffects);
    if (
      value.schemaVersion !== 1 ||
      !['create-users', 'deploy-apps', 'provision', 'install-os', 'extension'].includes(value.operation) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new Error('Malformed reviewed plan retained for inspection');
    if (
      value.plan.digest !== preparedDigest(value, this.project.config.extensions) ||
      value.reviewSummary !== canonicalJson({ ...summaryData(value), planDigest: value.plan.digest })
    )
      throw new Error('Stored reviewed plan changed; preserve it for inspection');
  }
}
