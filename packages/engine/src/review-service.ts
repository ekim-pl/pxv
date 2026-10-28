import { randomUUID } from 'node:crypto';
import { digest, observationDigest } from '@pxv/contracts';
import type { SelectedTarget, DeviceObservation } from '@pxv/contracts';
import type { Store, ExpectedRecord } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { ResourceScope } from './recovery.js';
import type {
  RunRecord,
  PreparedOperation,
  SetupReceiptRef,
  CapabilityEvidenceRef,
  ReviewLineage,
} from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import type { PlanWriter } from './plan-repository.js';
import type { Preparation } from './preparation-service.js';
import type { EvidenceReader } from './evidence-service.js';
import type { ProjectOwnership, DeviceOwnership } from './ownership.js';
import type { Journal } from './journal.js';
import { checkLanguageDelta } from './setup-evidence.js';
import type { CapabilityProofVerifier } from './capability-proof-verifier.js';
import { pausedVpnAction, checkVpnDelta } from './vpn-evidence.js';
import { assertFinalizationResolved } from './finalization-guard.js';
import { PendingRecipeQuery } from './pending-recipe.js';
export class ReviewService {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly observations: ObservationReader,
    readonly plans: PlanWriter,
    readonly preparation: Preparation,
    readonly evidence: EvidenceReader,
    readonly projects: ProjectOwnership,
    readonly devices: DeviceOwnership,
    readonly journal: Journal,
    readonly clock: () => Date,
    readonly proofs: CapabilityProofVerifier,
  ) {}
  submit(planId: string, reviewSummary: string, operator: string): Promise<RunRecord> {
    return this.projects.run(() => this.submitOwned(planId, reviewSummary, operator), {
      requirePolicyLock: true,
    });
  }
  async refreshReview(runId: string, signal?: AbortSignal): Promise<PreparedOperation> {
    return this.projects.run(
      async () => {
        const run = await this.manualRun(runId);
        const previous = await this.plans.read(run.planId, undefined, true);
        await assertFinalizationResolved(this.store, previous.target.device.assetId);
        if (previous.operation === 'install-os' || run.cursor >= previous.plan.actions.length)
          throw new Error('Manual checkpoint action is invalid; preserve it for inspection');
        return this.devices.run(previous.target, randomUUID() + '-refresh-device', () =>
          this.refreshLeased(run, previous, signal),
        );
      },
      { requirePolicyLock: true },
    );
  }
  private async submitOwned(planId: string, reviewSummary: string, operator: string): Promise<RunRecord> {
    const prepared = await this.plans.read(planId, reviewSummary);
    await assertFinalizationResolved(this.store, prepared.target.device.assetId);
    if (prepared.refreshedFrom) {
      const previous = await this.store.get<RunRecord>('runs', prepared.refreshedFrom.runId);
      if (previous?.status !== 'superseded' || previous.supersededBy !== planId)
        throw new Error('Refreshed review was not committed; preserve the prior checkpoint');
    }
    if (!operator.trim() || operator.length > 200) throw new Error('Operator identity is required');
    const id = digest({ project: this.project.config.id, plan: prepared.plan.digest });
    const run: RunRecord = {
      id,
      planId,
      status: 'queued',
      operator,
      createdAt: this.clock().toISOString(),
      ...(prepared.refreshedFrom
        ? {
            cursor: 0,
            completedSetup: prepared.refreshedFrom.completedSetup,
            capabilityEvidence: prepared.refreshedFrom.capabilityEvidence,
          }
        : {}),
    };
    const existing = await this.store.get<RunRecord>('runs', id);
    if (existing) return existing;
    const submitted = await this.store.submitAndSet(`plan:${planId}`, run, 'runs', id);
    return submitted.value;
  }
  private async manualRun(runId: string): Promise<RunRecord & { cursor: number; manualGate: string }> {
    const run = await this.store.get<RunRecord>('runs', runId);
    if (
      run?.status !== 'pending' ||
      !run.manualGate ||
      !Number.isSafeInteger(run.cursor) ||
      (run.cursor ?? -1) < 0
    )
      throw new Error('Only an intentional manual checkpoint can receive a fresh review');
    return run as RunRecord & { cursor: number; manualGate: string };
  }
  private async refreshLeased(
    run: RunRecord & { cursor: number; manualGate: string },
    previous: PreparedOperation,
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    signal?.throwIfAborted();
    const target = previous.target;
    const scope = new ResourceScope(this.store, target.device.canonicalSerial, run.id);
    if ((await scope.list()).some((value) => value.status !== 'resolved'))
      throw new Error('Recover unresolved obligations before refreshing a review');
    const state = await this.evidence.state(target.device.assetId);
    if (state.planDigest !== previous.plan.digest)
      throw new Error('Manual checkpoint belongs to a different reviewed plan');
    const baseline = await this.observations.observe(target, signal);
    const cursor = this.refreshedCursor(run, previous, state.observation, baseline);
    const completedSetup = await this.checkedSetupHistory(run, target);
    const capabilityEvidence = await this.checkedCapabilityHistory(run, previous, baseline);
    const checkpoint = await new PendingRecipeQuery(this.project, this.store, this.plans, run).read(
      previous,
      baseline,
    );
    const pendingRecipeEvidenceId = checkpoint?.evidenceId;
    const refreshedFrom: ReviewLineage = {
      runId: run.id,
      planDigest: previous.plan.digest,
      completedActions: cursor,
      completedSetup,
      capabilityEvidence,
      ...(pendingRecipeEvidenceId ? { pendingRecipeEvidenceId } : {}),
    };
    const actions = previous.plan.actions.slice(cursor);
    const sharedEffects = await this.preparation.reviewEffects(target, actions, signal);
    const prepared = await this.plans.persist({
      id: randomUUID(),
      target,
      operation: previous.operation,
      baseline,
      actions,
      sharedEffects,
      refreshedFrom,
      ...(previous.lifecycleGeneration ? { lifecycleGeneration: previous.lifecycleGeneration } : {}),
      ...(previous.capabilities ? { capabilities: previous.capabilities } : {}),
    });
    await this.commitRefreshedReview(run, prepared, cursor, checkpoint?.expected);
    return prepared;
  }
  private refreshedCursor(
    run: RunRecord & { cursor: number; manualGate: string },
    previous: PreparedOperation,
    expected: DeviceObservation,
    baseline: DeviceObservation,
  ): number {
    const paused = previous.plan.actions[run.cursor];
    const vpn = pausedVpnAction(previous, run);
    if (vpn) {
      checkVpnDelta(expected, baseline, vpn);
      return run.cursor;
    }
    if (run.manualGate.startsWith('language:') && paused?.kind === 'language') {
      if (run.manualGate !== `language:${paused.profileId}`)
        throw new Error('Manual language checkpoint is malformed');
      const actual = checkLanguageDelta(expected, baseline, paused.profileId);
      return actual === paused.language ? run.cursor + 1 : run.cursor;
    }
    if (observationDigest(baseline) !== observationDigest(expected))
      throw new Error('Live state changed at the manual checkpoint; inspect before replanning');
    return run.cursor;
  }
  private async checkedSetupHistory(run: RunRecord, target: SelectedTarget): Promise<SetupReceiptRef[]> {
    const receipts = await this.evidence.receipts(target.device.assetId);
    const completed = (run.completedSetup ?? []).filter((value) => value.check === 'normal_credentials');
    for (const item of completed)
      if (
        !receipts.some(
          (value) =>
            value.id === item.receiptId && value.check === item.check && value.planDigest === item.planDigest,
        )
      )
        throw new Error('Consumed setup receipt is missing or changed');
    return completed;
  }
  private async checkedCapabilityHistory(
    run: RunRecord,
    previous: PreparedOperation,
    baseline: DeviceObservation,
  ): Promise<CapabilityEvidenceRef[]> {
    const references = run.capabilityEvidence ?? [];
    const session = this.proofs.session({
      planId: previous.plan.id,
      planDigest: previous.plan.digest,
      policyDigest: previous.plan.policyDigest,
      observation: baseline,
    });
    for (const reference of references) await session.assert(reference);
    return references;
  }
  private async commitRefreshedReview(
    run: RunRecord,
    prepared: PreparedOperation,
    cursor: number,
    expected: ExpectedRecord[] = [],
  ): Promise<void> {
    const event = this.journal.entry(run.id, 'review-refreshed', {
      planId: prepared.plan.id,
      completedActions: cursor,
    });
    const committed = await this.store.transition({
      expected: [{ collection: 'runs', key: run.id, value: run }, ...expected],
      changes: [
        {
          kind: 'set',
          collection: 'runs',
          key: run.id,
          value: { ...run, status: 'superseded', supersededBy: prepared.plan.id },
        },
      ],
      events: [{ runId: run.id, value: event }],
    });
    if (!committed) throw new Error('Manual checkpoint changed while preparing its fresh review');
  }
}
