import { digest, validateSeedvaultProgress, type SeedvaultProfileResult } from '@pxv/contracts';
import type { DeviceLease, Store } from '@pxv/runtime';
import { ExecutionControl } from '../../execution-control.js';
import type { Journal } from '../../journal.js';
import type { DeviceOwnership } from '../../ownership.js';
import { ResourceScope } from '../../recovery.js';
import { type SeedvaultPlans, seedvaultIdentity } from './seedvault-plans.js';
import {
  initialSeedvaultReport,
  validateSeedvaultReport,
  validateSeedvaultResult,
} from './seedvault-reports.js';
import type { PreparedSeedvaultOperation, SeedvaultReport } from './seedvault-types.js';
import type { RunRecord } from '../../workflow-types.js';

interface ActiveSeedvault {
  run: RunRecord;
  prepared: PreparedSeedvaultOperation;
  report: SeedvaultReport;
  expected: SeedvaultReport | undefined;
  scope: ResourceScope;
  lease: DeviceLease;
  control: ExecutionControl;
}
class PendingSeedvaultFence extends Error {}

export class SeedvaultExecution {
  constructor(
    readonly store: Store,
    readonly plans: SeedvaultPlans,
    readonly devices: DeviceOwnership,
    readonly journal: Journal,
  ) {}
  async execute(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    const run = await this.store.get<RunRecord>('runs', runId);
    if (!run) throw new Error('Unknown approved Seedvault run');
    const resume = run.status === 'pending' && run.manualGate?.startsWith('seedvault:');
    if (run.status !== 'queued' && !resume) return run;
    const prepared = await this.plans.read(run.planId);
    const control = new ExecutionControl(this.store, runId, signal);
    this.journal.track(run);
    try {
      await control.check();
      await this.withLease(run, prepared, control);
    } catch (error) {
      if (!(error instanceof PendingSeedvaultFence)) {
        run.status = control.signal.aborted ? 'cancelled' : 'needs-inspection';
        run.error = error instanceof Error ? error.message : 'Seedvault execution failed';
        await this.saveFailure(run);
      }
    } finally {
      control.dispose();
    }
    return run;
  }
  private async withLease(
    run: RunRecord,
    prepared: PreparedSeedvaultOperation,
    control: ExecutionControl,
  ): Promise<void> {
    const reservations = await this.devices.reservations(prepared.target.device);
    const attempt = await this.store.get<{ operationId: string }>('recovery-attempts', run.id);
    const own = reservations.find(
      (entry) =>
        entry.operation_id === run.id ||
        entry.previous_operation_id === run.id ||
        entry.operation_id === attempt?.operationId,
    );
    const action = (lease: DeviceLease) => this.leased(run, prepared, control, lease);
    if (own) await this.devices.recover(prepared.target, own.operation_id, action);
    else await this.devices.run(prepared.target, run.id, action);
  }
  private async leased(
    run: RunRecord,
    prepared: PreparedSeedvaultOperation,
    control: ExecutionControl,
    lease: DeviceLease,
  ): Promise<void> {
    if (lease.operationId !== run.id)
      await this.store.set('recovery-attempts', run.id, {
        operationId: lease.operationId,
        deviceSerial: prepared.target.device.canonicalSerial,
      });
    try {
      const active = await this.start(run, prepared, control, lease);
      await this.profiles(active);
      if (
        (await active.scope.list()).some(
          (entry) => entry.operationId === run.id && entry.status !== 'resolved',
        )
      )
        if (run.status === 'pending')
          throw new PendingSeedvaultFence('Remote Seedvault resources remain reserved');
        else throw new Error('Seedvault completed with unresolved remote resources');
    } finally {
      await this.journal.ingestNative(run.id);
      if (lease.operationId !== run.id) await this.journal.ingestNative(run.id, lease.operationId);
    }
  }
  private async start(
    run: RunRecord,
    prepared: PreparedSeedvaultOperation,
    control: ExecutionControl,
    lease: DeviceLease,
  ): Promise<ActiveSeedvault> {
    const scope = new ResourceScope(this.store, prepared.target.device.canonicalSerial, run.id);
    if ((await scope.list()).some((entry) => entry.operationId !== run.id && entry.status !== 'resolved'))
      throw new Error('Device has unresolved recovery obligations from another operation');
    const live = await this.plans.inspect(prepared.target, control.signal);
    if (seedvaultIdentity(live) !== seedvaultIdentity(prepared.baseline))
      throw new Error('Seedvault build or Android profile identity changed since review');
    const expected = await this.store.get<SeedvaultReport>('seedvault-progress', run.id);
    const report = expected ?? initialSeedvaultReport(run, prepared);
    validateSeedvaultReport(report, run, prepared);
    const active = { run, prepared, report, expected: structuredClone(expected), scope, lease, control };
    run.status = 'running';
    delete run.manualGate;
    delete run.error;
    await this.save(active, 'seedvault-started');
    return active;
  }
  private async profiles(active: ActiveSeedvault): Promise<void> {
    while (active.report.cursor < active.report.profiles.length) {
      await active.control.check();
      const live = await this.plans.inspect(active.prepared.target, active.control.signal);
      if (seedvaultIdentity(live) !== seedvaultIdentity(active.prepared.baseline))
        throw new Error('Android profile identity changed during Seedvault operation');
      const profile = live.profiles.find(
        (item) => item.profileId === active.report.profiles[active.report.cursor]?.profileId,
      );
      if (!profile || !this.plans.port) throw new Error('Seedvault profile or adapter is unavailable');
      const report = active.report.profiles[active.report.cursor]!;
      report.status = 'running';
      await this.save(active, 'seedvault-profile-started');
      const result = await this.plans.port.executeProfile(
        active.prepared.target,
        profile,
        active.prepared.request,
        {
          lease: active.lease,
          signal: active.control.signal,
          operationId: active.run.id,
          obligations: active.scope.child(`profile-${active.report.cursor}`).writer(),
          ...(report.progress ? { progress: structuredClone(report.progress) } : {}),
          saveProgress: async (progress) => {
            const checked = validateSeedvaultProgress(progress);
            if (
              !active.prepared.request.adapter ||
              checked.adapterDigest !== digest(active.prepared.request.adapter)
            )
              throw new Error('Seedvault progress differs from the reviewed adapter');
            if (report.progress && checked.step < report.progress.step)
              throw new Error('Seedvault progress cannot replay earlier UI steps');
            report.progress = checked;
            await this.save(active, 'seedvault-profile-progress');
          },
        },
      );
      await active.control.check();
      if (!(await this.result(active, result))) return;
    }
    active.run.status = 'completed';
    await this.save(active, 'seedvault-completed');
  }
  private async result(active: ActiveSeedvault, result: SeedvaultProfileResult): Promise<boolean> {
    validateSeedvaultResult(result, active.prepared, active.report.cursor);
    const profile = active.report.profiles[active.report.cursor]!;
    if (result.progress && profile.progress && result.progress.step < profile.progress.step)
      throw new Error('Seedvault returned progress that would replay earlier UI steps');
    if (result.progress) profile.progress = result.progress;
    if (result.status === 'manual-pending') {
      profile.status = 'pending';
      profile.instructions = result.instructions;
      active.run.status = 'pending';
      active.run.manualGate = `seedvault:${profile.profileId}`;
      await this.save(active, 'seedvault-manual-pending');
      return false;
    }
    if (
      (await active.scope.list()).some(
        (entry) => entry.status !== 'resolved' && entry.user?.userId === profile.user.userId,
      )
    )
      throw new Error('Seedvault profile reported completion with outstanding remote resources');
    profile.status = 'completed';
    profile.evidence = result.evidence;
    delete profile.instructions;
    active.report.cursor++;
    await this.save(active, 'seedvault-profile-completed');
    return true;
  }
  private async save(active: ActiveSeedvault, type: string): Promise<void> {
    active.run.cursor = active.report.cursor;
    active.report.status = active.run.status;
    await this.journal.save(
      active.run,
      type,
      [{ kind: 'set', collection: 'seedvault-progress', key: active.run.id, value: active.report }],
      [{ collection: 'seedvault-progress', key: active.run.id, value: active.expected }],
    );
    active.expected = structuredClone(active.report);
  }
  private async saveFailure(run: RunRecord): Promise<void> {
    const report = await this.store.get<SeedvaultReport>('seedvault-progress', run.id);
    const changes = report
      ? [
          {
            kind: 'set' as const,
            collection: 'seedvault-progress',
            key: run.id,
            value: { ...report, status: run.status },
          },
        ]
      : [];
    const expected = report ? [{ collection: 'seedvault-progress', key: run.id, value: report }] : [];
    await this.journal.save(run, run.status, changes, expected);
  }
}
