import {
  digest,
  validateSeedvaultProgress,
  type ObligationWriter,
  type RecoveryObligation,
  type SeedvaultAdapterDefinition,
  type SeedvaultProfileEvidence,
  type SeedvaultProfileIdentity,
  type SeedvaultProfileProgress,
  type SeedvaultProfileResult,
  type SeedvaultRequest,
  type SelectedTarget,
  type UiSelector,
} from '@pxv/contracts';
import { randomUUID } from 'node:crypto';
import type { AndroidAdapter } from './android.js';
import { AdapterError } from './command.js';
import type { SeedvaultExecutionOptions } from './seedvault.js';
import { foregroundUser, seedvaultTokens, userUnlocked } from './seedvault-inspection.js';
import { cleanupSeedvault } from './seedvault-recovery.js';
import {
  seedvaultGuard,
  seedvaultNode,
  seedvaultSnapshot,
  seedvaultWorkQuiescent,
  tapSeedvault,
} from './seedvault-ui.js';
import { matchUiNode, type UiNode } from './ui-snapshot.js';
type SeedvaultStep = SeedvaultAdapterDefinition['backup']['steps'][number];

export class SeedvaultRun {
  private readonly writer: ObligationWriter;
  private progress!: SeedvaultProfileProgress;
  constructor(
    private readonly android: AndroidAdapter,
    private readonly target: SelectedTarget,
    private readonly profile: SeedvaultProfileIdentity,
    private readonly request: SeedvaultRequest,
    private readonly definition: SeedvaultAdapterDefinition,
    private readonly options: SeedvaultExecutionOptions,
  ) {
    this.writer = options.obligations.child('seedvault-' + digest(profile.profileId).slice(0, 32));
  }
  async execute(): Promise<SeedvaultProfileResult> {
    await this.android.guardUser(this.target, this.profile.user, this.options.signal);
    this.progress = this.options.progress
      ? validateSeedvaultProgress(this.options.progress)
      : await this.prepare();
    if (this.progress.adapterDigest !== digest(this.definition))
      throw new AdapterError('Seedvault adapter changed during a paused visit');
    try {
      await this.focus();
      await seedvaultGuard(
        this.android,
        this.target,
        this.profile.user,
        this.definition,
        this.options.signal,
      );
      if (this.progress.phase === 'prepared') await this.start();
      let evidence = await this.completedPrivately();
      if (!evidence && this.progress.inFlight === undefined) await this.steps();
      evidence ??= await this.measure();
      await this.complete();
      return { status: 'measured', evidence, progress: this.progress };
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'MANUAL_PENDING')
        return { status: 'manual-pending', instructions: error.message, progress: this.progress };
      throw error;
    }
  }
  private async completedPrivately(): Promise<SeedvaultProfileEvidence | undefined> {
    if (!this.canMeasure()) return undefined;
    try {
      return await this.measure();
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'MANUAL_PENDING') return undefined;
      throw error;
    }
  }
  private async prepare(): Promise<SeedvaultProfileProgress> {
    const previousId = await foregroundUser(this.android, this.target, this.options.signal);
    const previousForeground = (await this.android.users(this.target, this.options.signal)).find(
      (user) => user.userId === previousId,
    );
    if (!previousForeground)
      throw new AdapterError('Previous foreground user cannot be bound to stable identity');
    const progress: SeedvaultProfileProgress = {
      phase: 'prepared',
      beforeTokens: [],
      obligationIds: [randomUUID(), randomUUID()],
      adapterDigest: digest(this.definition),
      step: 0,
      previousForeground,
    };
    for (const kind of ['seedvault-job', 'seedvault-foreground'] as const) {
      const index = kind === 'seedvault-job' ? 1 : 0;
      await this.writer.record(this.obligation(progress, kind, index));
    }
    await this.options.saveProgress(progress);
    return progress;
  }
  private obligation(progress: SeedvaultProfileProgress, kind: string, index: number): RecoveryObligation {
    const id = progress.obligationIds[index];
    if (!id) throw new AdapterError('Seedvault progress lost its recovery obligation identity');
    return {
      schemaVersion: 1,
      id,
      operationId: this.writer.operationId,
      ownerOperationId: this.writer.ownerOperationId,
      deviceSerial: this.target.device.canonicalSerial,
      user: this.profile.user,
      kind,
      resource: 'seedvault:' + this.profile.user.serialNo,
      payload: {
        adapter: this.definition,
        operation: this.request.operation,
        previousForeground: progress.previousForeground,
      },
      status: 'pending',
    };
  }
  private async focus(): Promise<void> {
    if ((await foregroundUser(this.android, this.target, this.options.signal)) !== this.profile.user.userId) {
      await this.android.guardUser(this.target, this.profile.user, this.options.signal);
      await this.android.shell(this.target, ['am', 'switch-user', String(this.profile.user.userId)], {
        ...this.options,
        mutation: true,
      });
    }
    if (!(await userUnlocked(this.android, this.target, this.profile.user, this.options.signal)))
      throw new AdapterError(
        'Privately unlock the selected profile; Seedvault recovery words and credentials remain on the device',
        'MANUAL_PENDING',
      );
  }
  private async start(): Promise<void> {
    this.progress.beforeTokens = await seedvaultTokens(
      this.android,
      this.target,
      this.profile.user,
      this.options.signal,
    );
    const source = this.request.sources?.find((item) => item.profileId === this.profile.profileId);
    if (
      this.request.operation === 'restore' &&
      (!source || !this.progress.beforeTokens.includes(source.token))
    )
      throw new AdapterError(
        'The exact reviewed source token is not available for this profile',
        'MANUAL_PENDING',
      );
    this.progress.phase = 'running';
    await this.options.saveProgress(this.progress);
    await this.android.shell(
      this.target,
      [
        'am',
        'start',
        '--user',
        String(this.profile.user.userId),
        '-a',
        'com.android.settings.BACKUP_SETTINGS',
      ],
      { ...this.options, mutation: true },
    );
  }
  private async steps(): Promise<void> {
    const steps = this.definition[this.request.operation].steps;
    if (this.progress.step > steps.length)
      throw new AdapterError('Seedvault step cursor exceeds the accepted recipe');
    for (let index = this.progress.step; index < steps.length; index++)
      await this.performStep(steps[index]!, index);
  }
  private selector(step: SeedvaultStep): UiSelector {
    const source = this.request.sources?.find((source) => source.profileId === this.profile.profileId);
    const selector =
      'selector' in step
        ? step.selector
        : step.action === 'select-source'
          ? source?.selector
          : source?.filesSelector;
    if (!selector) throw new AdapterError('Restore requires an explicit public source selector');
    return selector as UiSelector;
  }
  private async performStep(step: SeedvaultStep, index: number): Promise<void> {
    const waiting = step.action === 'wait' || step.action === 'observe-files-running';
    const node = await seedvaultNode(
      this.android,
      this.target,
      this.profile.user,
      this.definition,
      this.selector(step),
      stepTimeout(step),
      this.options.signal,
    );
    if (
      step.action === 'start-backup' ||
      step.action === 'start-restore' ||
      step.action === 'start-files-restore'
    )
      await seedvaultWorkQuiescent(this.android, this.target, this.profile.user, this.options.signal);
    if (!waiting) {
      this.progress.inFlight = index;
      await this.options.saveProgress(this.progress);
      await tapSeedvault(this.android, this.target, this.profile.user, this.definition, node, this.options);
    }
    delete this.progress.inFlight;
    this.progress.step = index + 1;
    await this.options.saveProgress(this.progress);
  }
  private async completionGeneration(): Promise<{ generation: string; fileGeneration: string }> {
    const completion = this.definition[this.request.operation].completion;
    const nodes = await seedvaultSnapshot(
      this.android,
      this.target,
      this.profile.user,
      this.definition,
      this.options.signal,
    );
    for (const key of ['apps', 'files', 'finalized', 'idle'] as const)
      if (!matchUiNode(nodes, completion[key] as UiSelector, this.definition.package.packageId))
        throw new AdapterError(
          'Complete Seedvault apps, files and snapshot finalization privately, then show the reviewed completion screen',
          'MANUAL_PENDING',
        );
    return {
      generation: publicGeneration(
        nodes,
        completion.generation as UiSelector,
        this.definition.package.packageId,
      ),
      fileGeneration: publicGeneration(
        nodes,
        completion.fileGeneration as UiSelector,
        this.definition.package.packageId,
      ),
    };
  }
  private async measure(): Promise<SeedvaultProfileEvidence> {
    if (!this.canMeasure())
      throw new AdapterError(
        'Start restoration through the exact reviewed source and accepted restore trigger before measuring completion',
        'MANUAL_PENDING',
      );
    const { generation, fileGeneration } = await this.completionGeneration();
    const tokens = await seedvaultTokens(this.android, this.target, this.profile.user, this.options.signal);
    const source = this.request.sources?.find((item) => item.profileId === this.profile.profileId);
    if (source && generation !== source.selector.text)
      throw new AdapterError(
        'Restored Seedvault generation does not match the reviewed source label',
        'MANUAL_PENDING',
      );
    if (source && fileGeneration !== source.filesSelector.text)
      throw new AdapterError(
        'Restored files generation does not match the reviewed files source label',
        'MANUAL_PENDING',
      );
    const candidates =
      this.request.operation === 'restore'
        ? tokens.filter((token) => token === source?.token)
        : tokens.filter((token) => !this.progress.beforeTokens.includes(token));
    if (candidates.length !== 1)
      throw new AdapterError('A unique durable Seedvault generation could not be measured', 'MANUAL_PENDING');
    const token = candidates[0]!;
    return {
      profileId: this.profile.profileId,
      user: this.profile.user,
      operation: this.request.operation,
      token,
      observedAt: this.android.now().toISOString(),
      adapterDigest: this.progress.adapterDigest,
      apps: true,
      files: true,
      finalized: true,
      coverage: {
        scope: 'representative-ui-only',
        exclusions: 'not-enumerated',
        contentVerification: 'owner-required',
      },
      source: source ?? {
        profileId: this.profile.profileId,
        token,
        selector: { resourceId: this.definition.restoreSourceResourceId, text: generation },
        filesSelector: { resourceId: this.definition.restoreFileSourceResourceId, text: fileGeneration },
      },
    };
  }
  private async complete(): Promise<void> {
    for (const [kind, index] of [
      ['seedvault-job', 1],
      ['seedvault-foreground', 0],
    ] as const) {
      const obligation = this.obligation(this.progress, kind, index);
      await cleanupSeedvault(this.android, this.target, obligation, {
        lease: this.options.lease,
        operationId: this.writer.ownerOperationId,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
      await this.writer.resolve(obligation.id);
    }
    this.progress.phase = 'completed';
    delete this.progress.inFlight;
    await this.options.saveProgress(this.progress);
  }
  private canMeasure(): boolean {
    const steps = this.definition[this.request.operation].steps;
    const trigger = steps.findIndex(
      (step) =>
        step.action === (this.request.operation === 'backup' ? 'start-backup' : 'start-files-restore'),
    );
    const files = steps.findIndex((step) => step.action === 'observe-files-running');
    return (
      trigger >= 0 && files > trigger && this.progress.step > files && this.progress.inFlight === undefined
    );
  }
}
function publicGeneration(nodes: UiNode[], selector: UiSelector, packageId: string): string {
  const generation = matchUiNode(nodes, selector, packageId)?.attributes['text'];
  if (!generation || generation.length > 200)
    throw new AdapterError('Seedvault backup generation label is unavailable', 'MANUAL_PENDING');
  return generation;
}
function stepTimeout(step: SeedvaultStep): number {
  return step.action === 'wait' || step.action === 'observe-files-running' ? (step.timeoutMs ?? 30000) : 1;
}
