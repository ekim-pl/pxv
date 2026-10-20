import {
  digest,
  validatePlan,
  validateSeedvaultRequest,
  type ReviewedPlan,
  type SelectedTarget,
} from '@pxv/contracts';
import type { EntryPage, EntryPageOptions, Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { withRunPauseReason } from './run-state.js';
import type { Operation, RunRecord } from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import { CustodyCompletionSession } from './custody-completion.js';

export type RunListOptions = EntryPageOptions;
interface RunNextStep {
  kind:
    | 'status'
    | 'refresh-review'
    | 'resume'
    | 'inspect'
    | 'reenroll'
    | 'acceptance'
    | 'follow-superseding-run'
    | 'review-refreshed-plan';
  description: string;
  command: string[];
  requiresConfirmation: boolean;
}
export interface RunStatus extends RunRecord {
  evidenceSource: 'stored';
  operation?: string;
  assetId?: string;
  reviewExpiresAt?: string;
  reviewStatus: 'current' | 'expired' | 'stale' | 'unavailable';
  nextSteps: RunNextStep[];
}
interface RetainedPlan {
  schemaVersion: 1;
  plan: ReviewedPlan;
  target: SelectedTarget;
  operation?: Operation;
  request?: { operation: string };
  expiresAt: string;
  lifecycleGeneration?: string;
  reviewSummary: string;
}

function reviewMetadataValid(plan: RetainedPlan, planId: string): boolean {
  try {
    validatePlan(plan.plan);
    if (digest(plan.plan.device) !== digest(plan.target.device)) return false;
    if (
      plan.schemaVersion !== 1 ||
      plan.plan.id !== planId ||
      !Number.isFinite(Date.parse(plan.expiresAt)) ||
      typeof plan.reviewSummary !== 'string'
    )
      return false;
    if (plan.operation !== undefined)
      return ['create-users', 'deploy-apps', 'provision', 'install-os', 'extension'].includes(plan.operation);
    validateSeedvaultRequest(plan.request);
    return true;
  } catch {
    return false;
  }
}

function step(
  kind: RunNextStep['kind'],
  description: string,
  command: string[],
  requiresConfirmation = false,
): RunNextStep[] {
  return [{ kind, description, command, requiresConfirmation }];
}
function manualNextStep(run: RunStatus): RunNextStep[] {
  if (run.reviewStatus === 'current')
    return step(
      'resume',
      'Complete the explicit manual checkpoint, then confirm resumption.',
      ['agent', 'resume', '--run', run.id],
      true,
    );
  if (run.reviewStatus === 'expired')
    return step(
      'refresh-review',
      'Prepare a fresh exact review for the manual checkpoint before execution.',
      ['agent', 'refresh', '--run', run.id],
      true,
    );
  return [];
}
function pausedNextSteps(run: RunStatus): RunNextStep[] {
  const pause = run.pauseReason;
  if (!pause) return [];
  switch (pause.kind) {
    case 'inspection':
      return step('inspect', pause.instructions, ['agent', 'status', '--run', run.id]);
    case 'manual-step':
      return manualNextStep(run);
    case 'reenrollment':
      return run.assetId
        ? step(
            'reenroll',
            'Finish phone setup and authorize debugging, then reconfirm the existing enrollment before preparing a new provisioning review.',
            ['device', 'inspect', '--asset', run.assetId],
          )
        : [];
    case 'acceptance':
      return run.assetId
        ? step('acceptance', pause.instructions, ['device', 'report', '--asset', run.assetId])
        : [];
  }
}
function nextSteps(run: RunStatus): RunNextStep[] {
  if (run.pauseReason) return pausedNextSteps(run);
  if (run.status === 'queued' || run.status === 'running')
    return step('status', 'Read retained progress; this does not prove a worker is currently active.', [
      'agent',
      'status',
      '--run',
      run.id,
    ]);
  return [];
}
function planDetails(plan: RetainedPlan | undefined) {
  if (!plan) return {};
  const operation = plan.operation ?? plan.request?.operation;
  const assetId = plan.target?.device?.assetId;
  return {
    ...(operation ? { operation } : {}),
    ...(assetId ? { assetId } : {}),
    ...(plan.expiresAt ? { reviewExpiresAt: plan.expiresAt } : {}),
  };
}

/** Read-only projections of retained evidence; execution still validates every approval. */
export class RunQueryService {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly clock: () => Date,
    readonly observations: Pick<ObservationReader, 'assertTarget'>,
  ) {}
  private async retainedPlan(planId: string): Promise<RetainedPlan | undefined> {
    return (
      (await this.store.get<RetainedPlan>('plans', planId)) ??
      (await this.store.get<RetainedPlan>('seedvault-plans', planId))
    );
  }
  describe(run: RunRecord): Promise<RunStatus> {
    return this.describeRecord(run);
  }
  private async describeRecord(
    run: RunRecord,
    replacements?: Map<string, RunRecord>,
    completion = new CustodyCompletionSession(this.store, this.project.config.id),
  ): Promise<RunStatus> {
    const plan = await this.retainedPlan(run.planId);
    const effective = await completion.complete(run, plan);
    const details = planDetails(plan);
    const reviewStatus = await this.reviewStatus(plan, details.assetId, run.planId);
    const status: RunStatus = {
      ...withRunPauseReason(effective, plan?.operation),
      evidenceSource: 'stored',
      ...details,
      reviewStatus,
      nextSteps: [],
    };
    status.nextSteps =
      status.status === 'superseded' && status.supersededBy
        ? await this.supersedingStep(status.supersededBy, replacements)
        : nextSteps(status);
    return status;
  }
  private async supersedingStep(
    planId: string,
    replacements?: Map<string, RunRecord>,
  ): Promise<RunNextStep[]> {
    const replacement = (replacements ?? (await this.replacementRuns(new Set([planId])))).get(planId);
    if (replacement)
      return step('follow-superseding-run', 'Inspect the submitted replacement run.', [
        'agent',
        'status',
        '--run',
        replacement.id,
      ]);
    return step(
      'review-refreshed-plan',
      `This run was superseded by review plan ${planId}. Review its exact saved summary, then submit that plan with your review file and operator identity. See the execution command requirements.`,
      ['agent', 'execute', '--plan', planId, '--help'],
      true,
    );
  }
  private async replacementRuns(planIds: Set<string>): Promise<Map<string, RunRecord>> {
    const matches = new Map<string, RunRecord>();
    if (!planIds.size) return matches;
    let cursor: string | undefined;
    do {
      const page = await this.store.entriesPage<RunRecord>('runs', {
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      });
      for (const { value } of page.items)
        if (planIds.has(value.planId) && !matches.has(value.planId)) matches.set(value.planId, value);
      if (matches.size === planIds.size) return matches;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return matches;
  }
  private async reviewStatus(
    plan: RetainedPlan | undefined,
    assetId: string | undefined,
    planId: string,
  ): Promise<RunStatus['reviewStatus']> {
    if (!plan || !assetId || !reviewMetadataValid(plan, planId)) return 'unavailable';
    if (!this.targetCurrent(plan.target)) return 'stale';
    if (
      plan.plan.projectId !== this.project.config.id ||
      plan.plan.policyDigest !== this.project.resolved.digest ||
      (await this.store.get('plan-generations', assetId)) !== plan.lifecycleGeneration
    )
      return 'stale';
    return Date.parse(plan.expiresAt) < this.clock().getTime() ? 'expired' : 'current';
  }
  private targetCurrent(target: SelectedTarget): boolean {
    try {
      this.observations.assertTarget(target);
      return true;
    } catch {
      return false;
    }
  }
  async status(runId: string, after = 0) {
    const run = await this.store.get<RunRecord>('runs', runId);
    return {
      run: run ? await this.describe(run) : undefined,
      events: await this.store.events(runId, after, 100),
    };
  }
  async list(options: EntryPageOptions = {}): Promise<EntryPage<RunStatus>> {
    const page = await this.store.entriesPage<RunRecord>('runs', options);
    const supersededPlans = new Set(
      page.items.flatMap(({ value }) =>
        value.status === 'superseded' && value.supersededBy ? [value.supersededBy] : [],
      ),
    );
    const replacements = await this.replacementRuns(supersededPlans);
    const completion = new CustodyCompletionSession(this.store, this.project.config.id);
    return {
      items: await Promise.all(
        page.items.map(async ({ key, value }) => ({
          key,
          value: await this.describeRecord(value, replacements, completion),
        })),
      ),
      nextCursor: page.nextCursor,
    };
  }
  async latest(assetId: string): Promise<RunStatus | undefined> {
    let cursor: string | undefined;
    let latest: RunRecord | undefined;
    do {
      const page = await this.store.entriesPage<RunRecord>('runs', {
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      });
      const candidates = await Promise.all(
        page.items.map(async ({ value }) => ({
          run: value,
          assetId: (await this.retainedPlan(value.planId))?.target?.device?.assetId,
        })),
      );
      for (const candidate of candidates)
        if (candidate.assetId === assetId && (!latest || candidate.run.createdAt >= latest.createdAt))
          latest = candidate.run;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return latest ? this.describe(latest) : undefined;
  }
}
