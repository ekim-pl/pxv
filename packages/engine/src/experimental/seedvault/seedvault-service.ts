import { randomUUID } from 'node:crypto';
import { digest, type SeedvaultRequest, type SelectedTarget } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { Journal } from '../../journal.js';
import type { DeviceOwnership, ProjectOwnership } from '../../ownership.js';
import { assertProjectFresh, type ProjectContext } from '../../project.js';
import { ResourceScope } from '../../recovery.js';
import type { SeedvaultExecution } from './seedvault-execution.js';
import { type SeedvaultPlans, seedvaultIdentity } from './seedvault-plans.js';
import { validateSeedvaultReport } from './seedvault-reports.js';
import type { PreparedSeedvaultOperation, SeedvaultReport } from './seedvault-types.js';
import type { RunRecord } from '../../workflow-types.js';

/** Independent backup evidence must never replace provisioning evidence or attestations. */
export class SeedvaultService {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly plans: SeedvaultPlans,
    readonly execution: SeedvaultExecution,
    readonly projects: ProjectOwnership,
    readonly devices: DeviceOwnership,
    readonly journal: Journal,
    readonly clock: () => Date,
  ) {}
  private assertEnabled(): void {
    if (this.project.product.features?.seedvault === false)
      throw new Error(
        'Seedvault is an optional experimental recovery module; use a recovery-enabled product',
      );
  }
  async inspect(target: SelectedTarget, signal?: AbortSignal) {
    this.assertEnabled();
    await assertProjectFresh(this.project);
    return this.plans.inspect(target, signal);
  }
  prepare(target: SelectedTarget, request: SeedvaultRequest, signal?: AbortSignal) {
    this.assertEnabled();
    return this.projects.run(() => this.plans.prepare(target, request, signal));
  }
  submit(planId: string, summary: string, operator: string): Promise<RunRecord> {
    this.assertEnabled();
    return this.projects.run(async () => {
      const prepared = await this.plans.read(planId, summary);
      if (!operator.trim() || operator.length > 200) throw new Error('Operator identity is required');
      await this.validateLineage(prepared);
      const id = digest({ project: this.project.config.id, seedvaultPlan: prepared.plan.digest });
      const existing = await this.store.get<RunRecord>('runs', id);
      if (existing) return existing;
      const run: RunRecord = {
        id,
        planId,
        operator,
        status: 'queued',
        createdAt: this.clock().toISOString(),
        cursor: prepared.refreshedFrom?.progress.cursor ?? 0,
      };
      return (await this.store.submitAndSet(`seedvault-plan:${planId}`, run, 'runs', id)).value;
    });
  }
  private async validateLineage(prepared: PreparedSeedvaultOperation): Promise<void> {
    if (!prepared.refreshedFrom) return;
    const previous = await this.store.get<RunRecord>('runs', prepared.refreshedFrom.runId);
    if (previous?.status !== 'superseded' || previous.supersededBy !== prepared.plan.id)
      throw new Error('Seedvault refreshed review was not committed; preserve the previous checkpoint');
  }
  execute(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    this.assertEnabled();
    return this.projects.run(() => this.execution.execute(runId, signal));
  }
  async report(runId: string): Promise<SeedvaultReport> {
    const run = await this.store.get<RunRecord>('runs', runId);
    const report = await this.store.get<SeedvaultReport>('seedvault-progress', runId);
    if (!run || !report) throw new Error('Seedvault run has no durable profile report yet');
    validateSeedvaultReport(report, run, await this.plans.readHistorical(run.planId));
    return report;
  }
  refresh(runId: string, signal?: AbortSignal): Promise<PreparedSeedvaultOperation> {
    this.assertEnabled();
    return this.projects.run(async () => {
      const run = await this.store.get<RunRecord>('runs', runId);
      if (run?.status !== 'pending' || !run.manualGate?.startsWith('seedvault:'))
        throw new Error('Only an intentional Seedvault manual checkpoint can receive a fresh review');
      const previous = await this.plans.read(run.planId, undefined, true);
      return this.devices.run(previous.target, `${randomUUID()}-seedvault-refresh`, () =>
        this.refreshLeased(run, previous, signal),
      );
    });
  }
  private async refreshLeased(
    run: RunRecord,
    previous: PreparedSeedvaultOperation,
    signal?: AbortSignal,
  ): Promise<PreparedSeedvaultOperation> {
    const scope = new ResourceScope(this.store, previous.target.device.canonicalSerial, run.id);
    if ((await scope.list()).some((entry) => entry.status !== 'resolved'))
      throw new Error('Recover unresolved remote jobs before refreshing a Seedvault review');
    const report = await this.report(run.id);
    if (
      report.cursor >= report.profiles.length ||
      run.manualGate !== `seedvault:${report.profiles[report.cursor]?.profileId}`
    )
      throw new Error('Seedvault manual checkpoint is inconsistent');
    const live = await this.plans.inspect(previous.target, signal);
    if (seedvaultIdentity(live) !== seedvaultIdentity(previous.baseline))
      throw new Error('Seedvault profile identity or exact build changed at the checkpoint');
    const progress = structuredClone(report);
    for (const profile of progress.profiles.slice(progress.cursor)) {
      profile.status = 'queued';
      delete profile.progress;
      delete profile.instructions;
    }
    const prepared = await this.plans.prepare(previous.target, previous.request, signal, {
      runId: run.id,
      planDigest: previous.plan.digest,
      completedActions: report.cursor,
      completedSetup: [],
      capabilityEvidence: [],
      progress,
    });
    const committed = await this.store.transition({
      expected: [
        { collection: 'runs', key: run.id, value: run },
        { collection: 'seedvault-progress', key: run.id, value: report },
      ],
      changes: [
        {
          kind: 'set',
          collection: 'runs',
          key: run.id,
          value: { ...run, status: 'superseded', supersededBy: prepared.plan.id },
        },
      ],
      events: [
        {
          runId: run.id,
          value: this.journal.entry(run.id, 'seedvault-review-refreshed', { planId: prepared.plan.id }),
        },
      ],
    });
    if (!committed) throw new Error('Seedvault checkpoint changed while refreshing review');
    return prepared;
  }
}
