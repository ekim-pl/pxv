import {
  digest,
  evaluateObservation,
  finalSetupActions,
  observationDigest,
  profileLocale,
  sameAndroidUser as sameUser,
} from '@pxv/contracts';
import type {
  Action,
  AndroidUserIdentity,
  DeviceObservation,
  ProfilePolicy,
  RecipePolicy,
  NetworkProbePolicy,
  OperatorAttestation,
  SelectedTarget,
} from '@pxv/contracts';
import type { DeviceLease, Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { ResourceScope } from './recovery.js';
import { ExecutionControl } from './execution-control.js';
import type {
  WorkflowPort,
  ArtifactPort,
  ActiveExecution,
  PreparedOperation,
  RunRecord,
  WorkflowState,
  ExecutionContext,
  RecipeProof,
  RecipeExecutionResult,
  ProbeObservation,
  ProbeExecutionResult,
} from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import type { PlanReader } from './plan-repository.js';
import type { EvidenceReader } from './evidence-service.js';
import type { ProjectOwnership, DeviceOwnership } from './ownership.js';
import type { Journal } from './journal.js';
import { checkLanguageDelta, normalReceiptMatches } from './setup-evidence.js';
import { canonicalEffects } from './reviewed-plan.js';
import type { CredentialDefaultHistory, DefaultCredentialAction } from './credential-default-history.js';
export class ExecutionService {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly port: WorkflowPort,
    readonly artifacts: ArtifactPort,
    readonly observations: ObservationReader,
    readonly evidence: EvidenceReader,
    readonly plans: PlanReader,
    readonly projects: ProjectOwnership,
    readonly devices: DeviceOwnership,
    readonly journal: Journal,
    readonly clock: () => Date,
    readonly credentialDefaults: CredentialDefaultHistory,
  ) {}
  execute(runId: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    return this.projects.run(() => this.executeOwned(runId, externalSignal));
  }
  /** One project lease covers a bounded fleet batch; each phone keeps an independent lease. */
  async executeFleet(runIds: string[], jobs = 2, signal?: AbortSignal): Promise<RunRecord[]> {
    this.validateFleetBatch(runIds, jobs);
    if (!runIds.length) return [];
    const groups = new Map<string, string[]>();
    for (const runId of runIds) {
      const run = await this.store.get<RunRecord>('runs', runId);
      if (!run) throw new Error('Unknown approved run');
      const prepared = await this.plans.read(run.planId);
      const key = prepared.target.device.canonicalSerial;
      groups.set(key, [...(groups.get(key) ?? []), runId]);
    }
    return this.executeFleetGroups(groups, runIds, jobs, signal);
  }
  private validateFleetBatch(runIds: string[], jobs: number): void {
    if (
      !Number.isInteger(jobs) ||
      jobs < 1 ||
      jobs > 8 ||
      runIds.length > 1000 ||
      new Set(runIds).size !== runIds.length
    )
      throw new Error('Fleet execution requires unique runs and 1 to 8 workers');
  }
  private executeFleetGroups(
    groups: Map<string, string[]>,
    runIds: string[],
    jobs: number,
    signal?: AbortSignal,
  ): Promise<RunRecord[]> {
    return this.projects.run(async () => {
      const queue = [...groups.values()];
      const results = new Map<string, RunRecord>();
      await Promise.all(
        Array.from({ length: Math.min(jobs, queue.length) }, async () => {
          while (queue.length) {
            const group = queue.shift();
            if (!group) break;
            for (const runId of group) results.set(runId, await this.executeOwned(runId, signal));
          }
        }),
      );
      return runIds.map((id) => {
        const result = results.get(id);
        if (!result) throw new Error('Fleet result missing');
        return result;
      });
    });
  }
  private workflowState(
    target: SelectedTarget,
    prepared: PreparedOperation,
    observation: DeviceObservation,
    run: RunRecord,
    manualGate?: string,
  ): WorkflowState {
    const report = evaluateObservation(this.project.resolved, observation);
    const pending = report.checks.filter((value) => !value.passed).map((value) => value.key);
    if (manualGate) pending.push(`manual:${manualGate}`);
    const state: WorkflowState = {
      schemaVersion: 1,
      assetId: target.device.assetId,
      policyDigest: this.project.resolved.digest,
      planDigest: prepared.plan.digest,
      observation,
      observedAt: this.clock().toISOString(),
      status: pending.length ? 'pending' : 'verified',
      pending,
      languageReady: this.localesReady(observation),
      completedSetup: run.completedSetup ?? [],
      planId: prepared.plan.id,
      capabilityEvidence: run.capabilityEvidence ?? [],
    };
    return state;
  }
  private async checkpoint(active: ActiveExecution, type: string, gate?: string): Promise<void> {
    const state = this.workflowState(active.target, active.prepared, active.observation, active.run, gate);
    await this.journal.save(
      active.run,
      type,
      [{ kind: 'set', collection: 'workflow', key: active.target.device.assetId, value: state }],
      [{ collection: 'workflow', key: active.target.device.assetId, value: active.workflowExpected }],
    );
    active.workflowExpected = state;
  }
  private canResume(run: RunRecord): boolean {
    return run.status === 'pending' && run.manualGate !== undefined && Number.isSafeInteger(run.cursor);
  }
  private async executeOwned(runId: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    const run = await this.store.get<RunRecord>('runs', runId);
    if (!run) throw new Error('Unknown approved run');
    this.journal.track(run);
    await this.journal.ingestNative(runId);
    const resume = this.canResume(run);
    if (run.status !== 'queued' && !resume) return run;
    const prepared = await this.plans.read(run.planId);
    const control = new ExecutionControl(this.store, runId, externalSignal);
    try {
      await control.check();
      await this.devices.run(prepared.target, runId, (lease) =>
        this.executeLeased(run, prepared, resume, control, lease),
      );
    } catch (error) {
      run.status = control.signal.aborted ? 'cancelled' : 'needs-inspection';
      run.error = error instanceof Error ? error.message : 'Execution failed; inspect device';
    } finally {
      control.dispose();
    }
    await this.finishExecution(run);
    return run;
  }
  private async finishExecution(run: RunRecord): Promise<void> {
    if (run.status === 'needs-inspection' || run.status === 'cancelled') {
      await this.failExecution(run);
    }
  }
  private async failExecution(run: RunRecord): Promise<void> {
    const prepared = await this.plans.read(run.planId, undefined, true);
    const assetId = prepared.target.device.assetId;
    const state = await this.store.get<WorkflowState>('workflow', assetId);
    if (!state || state.planDigest !== prepared.plan.digest) return this.journal.save(run, run.status);
    await this.journal.save(
      run,
      run.status,
      [
        {
          kind: 'set',
          collection: 'workflow',
          key: assetId,
          value: { ...state, status: 'failed', pending: ['execution-inspection'] },
        },
      ],
      [{ collection: 'workflow', key: assetId, value: state }],
    );
  }
  private async executeLeased(
    run: RunRecord,
    prepared: PreparedOperation,
    resume: boolean,
    control: ExecutionControl,
    lease: DeviceLease,
  ): Promise<void> {
    try {
      await this.executeWithinLease(run, prepared, resume, control, lease);
    } finally {
      await this.ingestExecution(run);
    }
  }
  private async ingestExecution(run: RunRecord): Promise<void> {
    try {
      await this.journal.ingestNative(run.id);
    } catch {
      run.status = 'needs-inspection';
      run.error = 'Native completion receipts are malformed or unavailable; preserve them for inspection';
      await this.failExecution(run);
      throw new Error(run.error);
    }
  }
  private async executeWithinLease(
    run: RunRecord,
    prepared: PreparedOperation,
    resume: boolean,
    control: ExecutionControl,
    lease: DeviceLease,
  ): Promise<void> {
    const target = prepared.target;
    const scope = new ResourceScope(this.store, target.device.canonicalSerial, run.id);
    if ((await scope.list()).some((value) => value.status !== 'resolved'))
      throw new Error(
        'Device has unresolved recovery obligations; recover before executing another operation',
      );
    const context: ExecutionContext = {
      lease,
      signal: control.signal,
      operationId: run.id,
      obligations: scope.writer(),
      ...(prepared.osSnapshot ? { osSnapshot: prepared.osSnapshot } : {}),
    };
    const observation =
      prepared.operation === 'install-os'
        ? prepared.baseline
        : await this.observations.observe(target, control.signal);
    const active: ActiveExecution = {
      run,
      prepared,
      target,
      scope,
      context,
      control,
      observation,
      effects: canonicalEffects(prepared.sharedEffects),
      resume,
      workflowExpected: await this.store.get('workflow', target.device.assetId),
    };
    if (!(await this.checkExecutionBaseline(active))) return;
    await this.checkCredentialDefaultsPlan(active);
    await this.checkExecutionEffects(active);
    run.status = 'running';
    delete run.manualGate;
    await this.journal.save(run, resume ? 'resumed' : 'started');
    if (!(await this.executeActions(active))) return;
    await this.completeActions(active);
  }
  private async checkCredentialDefaultsPlan(active: ActiveExecution): Promise<void> {
    if (active.prepared.operation !== 'provision') return;
    const pending = await this.credentialDefaults.pending(
      active.target,
      active.observation,
      finalSetupActions(this.project.policy),
    );
    const remaining = active.prepared.plan.actions.slice(active.run.cursor ?? 0);
    for (const action of pending)
      if (
        (action.kind === 'default-credential' || action.kind === 'default-duress') &&
        !remaining.some((planned) => digest(planned) === digest(action))
      )
        throw new Error('Credential initialization history changed; prepare a fresh reviewed plan');
  }
  private async checkExecutionBaseline(active: ActiveExecution): Promise<boolean> {
    const { run, prepared, target, resume, observation } = active;
    const state = resume ? await this.evidence.state(target.device.assetId) : undefined;
    if (state && state.planDigest !== prepared.plan.digest)
      throw new Error('Manual checkpoint belongs to a different reviewed plan');
    const expected = state ? state.observation : prepared.baseline;
    const paused = resume ? this.cursorAction(prepared, run) : undefined;
    if (paused?.kind === 'language' && run.manualGate === `language:${paused.profileId}`)
      return this.observePausedLanguage(active, expected, paused);
    if (observationDigest(observation) !== observationDigest(expected))
      throw new Error('Live state changed since review; prepare again');
    return true;
  }
  private cursorAction(prepared: PreparedOperation, run: RunRecord): Action | undefined {
    return prepared.plan.actions[run.cursor ?? 0];
  }
  private async observePausedLanguage(
    active: ActiveExecution,
    expected: DeviceObservation,
    action: Extract<Action, { kind: 'language' }>,
  ): Promise<boolean> {
    checkLanguageDelta(expected, active.observation, action.profileId);
    const actual = active.observation.profiles.find((value) => value.profileId === action.profileId);
    if (actual?.language !== action.language) return false;
    active.run.cursor = (active.run.cursor ?? 0) + 1;
    await this.journal.event(active.run.id, 'language-observed', {
      profileId: action.profileId,
      source: 'recipient-private-entry',
      observationDigest: observationDigest(active.observation),
    });
    return true;
  }
  private async checkExecutionEffects(active: ActiveExecution): Promise<void> {
    if (active.resume)
      for (const action of active.prepared.plan.actions.slice(0, active.run.cursor ?? 0)) {
        if (action.kind !== 'install-apk') continue;
        const user = active.observation.profiles.find((value) => value.profileId === action.profileId)?.user;
        if (!user) throw new Error('Installed APK profile identity is missing at checkpoint');
        active.effects = this.observations.nextEffects(active.effects, action.artifact, user);
      }
    if (!(await this.effectsMatch(active))) throw new Error('Device-wide APK effects changed since review');
  }
  private async effectsMatch(active: ActiveExecution): Promise<boolean> {
    const measured = await this.observations.sharedEffects(
      active.target,
      active.effects.map((value) => value.packageId),
      active.control.signal,
    );
    return digest(measured) === digest(active.effects);
  }
  private async executeActions(active: ActiveExecution): Promise<boolean> {
    for (let index = active.run.cursor ?? 0; index < active.prepared.plan.actions.length; index++) {
      const action = active.prepared.plan.actions[index];
      if (!action) throw new Error('Plan action cursor is invalid');
      await active.control.check();
      await this.journal.event(active.run.id, 'intent', {
        kind: action.kind,
        profileId: 'profileId' in action ? action.profileId : '',
      });
      if (!(await this.executeAction(active, action, index))) return false;
      if (action.kind === 'manual' || action.kind === 'install-os') continue;
      active.observation = await this.observations.observe(active.target, active.control.signal);
      active.run.cursor = index + 1;
      await this.journal.save(active.run, 'observed', [], [], {
        kind: action.kind,
        observationDigest: observationDigest(active.observation),
      });
    }
    return true;
  }
  private async executeAction(active: ActiveExecution, action: Action, index: number): Promise<boolean> {
    if (action.kind === 'manual') return this.executeManual(active, action, index);
    if (action.kind === 'install-os') {
      await this.credentialDefaults.clear(active.target);
      await this.port.flash(active.target, this.project.policy, active.context);
      return true;
    }
    const profile = this.project.policy.profiles.find((value) => value.id === action.profileId);
    if (!profile) throw new Error('Plan references an unknown profile');
    const live = await this.observations.observe(active.target, active.control.signal);
    this.checkEstablishedUsers(active.observation, live);
    if (action.kind === 'create-user') {
      await this.port.createUser(active.target, profile, active.context);
      return true;
    }
    const user = live.profiles.find((value) => value.profileId === profile.id)?.user;
    if (!user) throw new Error('Selected Android user is absent');
    return this.executeProfileAction(active, action, index, profile, user, live);
  }
  private checkEstablishedUsers(previous: DeviceObservation, live: DeviceObservation): void {
    for (const profile of previous.profiles) {
      const actual = live.profiles.find((value) => value.profileId === profile.profileId);
      if (!actual || !sameUser(actual.user, profile.user))
        throw new Error('Android user identity changed during execution');
    }
  }
  private async executeProfileAction(
    active: ActiveExecution,
    action: Exclude<Action, { kind: 'manual' | 'install-os' | 'create-user' }>,
    index: number,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    live: DeviceObservation,
  ): Promise<boolean> {
    switch (action.kind) {
      case 'install-apk':
        await this.executeApk(active, action, user);
        break;
      case 'setting':
        await this.port.applySetting(active.target, user, action.setting, active.context);
        break;
      case 'permission':
        await this.port.applyPermission(active.target, user, action.permission, active.context);
        break;
      case 'vpn':
        await this.port.applyVpn(active.target, user, action.vpn, active.context);
        break;
      case 'recipe':
        return this.executeRecipe(active, action, index, profile, user, live);
      case 'network-probe':
        await this.executeProbe(active, action, index, profile, user);
        break;
      case 'language':
        return this.executeLanguage(active, action, index, user, live);
      case 'default-credential':
      case 'default-duress':
        await this.executeCredentialDefault(active, action, profile, user, live);
        break;
    }
    return true;
  }
  private async executeCredentialDefault(
    active: ActiveExecution,
    action: DefaultCredentialAction,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    live: DeviceObservation,
  ): Promise<void> {
    if (await this.credentialDefaults.alreadyAccepted(active.target, action, user)) return;
    await this.assertCredentialDefaultAllowed(active, action, profile, user, live);
    active.observation = live;
    await this.credentialDefaultCheckpoint(active, action.kind === 'default-duress');
    if (action.kind === 'default-credential') {
      if (!this.port.setCredentialDefault) throw new Error('Credential defaults adapter is unavailable');
      await this.port.setCredentialDefault(active.target, user, profile, active.context);
    } else {
      if (!this.port.setDuressDefault) throw new Error('Duress defaults adapter is unavailable');
      await this.port.setDuressDefault(active.target, user, profile, active.context);
    }
    await this.credentialDefaults.recordAccepted(active.target, action, user, active.run.id);
  }
  private async assertCredentialDefaultAllowed(
    active: ActiveExecution,
    action: DefaultCredentialAction,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    live: DeviceObservation,
  ): Promise<void> {
    if (action.kind === 'default-credential') {
      if (active.run.completedSetup?.some((value) => value.check === 'normal_credentials'))
        throw new Error('Initial credential defaults cannot replace completed recipient credentials');
      return;
    }
    if (profile.kind !== 'owner' || user.userId !== 0)
      throw new Error('Duress defaults require the Android owner');
    const receipts = await this.evidence.receipts(active.target.device.assetId);
    const normal = receipts.some((value) =>
      normalReceiptMatches(value, active.prepared.plan.digest, live, active.run.completedSetup),
    );
    if (!normal || !this.localesReady(live))
      throw new Error('Verify normal credentials and final language before setting duress defaults');
  }
  private localesReady(observation: DeviceObservation): boolean {
    return this.project.policy.profiles.every((profile) => {
      const locale = profileLocale(profile);
      return (
        !locale ||
        observation.profiles.some((value) => value.profileId === profile.id && value.language === locale)
      );
    });
  }
  private async credentialDefaultCheckpoint(active: ActiveExecution, duress: boolean): Promise<void> {
    const assetId = active.target.device.assetId;
    const previous = await this.store.get('attestations', assetId);
    const checks = ['duress', 'operator_signoff', 'recipient_acceptance'];
    if (!duress) checks.push('normal_credentials');
    const receipts = this.evidence.parseReceipts(previous).filter((value) => !checks.includes(value.check));
    const handoff = await this.store.get('handoff', assetId);
    const state = this.workflowState(
      active.target,
      active.prepared,
      active.observation,
      active.run,
      duress ? 'duress' : 'normal_credentials',
    );
    await this.journal.save(
      active.run,
      'credential-default-intent',
      [
        { kind: 'set', collection: 'workflow', key: assetId, value: state },
        { kind: 'set', collection: 'attestations', key: assetId, value: receipts },
        { kind: 'delete', collection: 'handoff', key: assetId },
      ],
      [
        { collection: 'workflow', key: assetId, value: active.workflowExpected },
        { collection: 'attestations', key: assetId, value: previous },
        { collection: 'handoff', key: assetId, value: handoff },
      ],
    );
    active.workflowExpected = state;
  }
  private async executeApk(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'install-apk' }>,
    user: AndroidUserIdentity,
  ): Promise<void> {
    const effect = active.effects.find((value) => value.packageId === action.artifact.packageId);
    if (!effect) throw new Error('APK is absent from reviewed device-wide effects');
    await this.artifacts.validateBeforeExecution?.(action.artifact, active.target, active.control.signal);
    await this.port.install(active.target, user, action.artifact, {
      ...active.context,
      reviewedDeviceWideEffect: { ...effect, toVersionCode: action.artifact.versionCode },
    });
    active.effects = this.observations.nextEffects(active.effects, action.artifact, user);
    if (!(await this.effectsMatch(active)))
      throw new Error('Installed APK effects differ from the reviewed transition');
  }
  private async pauseExecution(
    active: ActiveExecution,
    index: number,
    gate: string,
    observation = active.observation,
  ): Promise<false> {
    active.run.status = 'pending';
    active.run.cursor = index;
    active.run.manualGate = gate;
    active.observation = observation;
    await this.checkpoint(active, 'manual-pending', gate);
    return false;
  }
  private async currentReceipt(
    active: ActiveExecution,
    check: string,
    observation = active.observation,
  ): Promise<OperatorAttestation | undefined> {
    return (await this.evidence.receipts(active.target.device.assetId)).find(
      (value) =>
        value.check === check &&
        value.planDigest === active.prepared.plan.digest &&
        value.observationDigest === observationDigest(observation),
    );
  }
  private async executeManual(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'manual' }>,
    index: number,
  ): Promise<boolean> {
    const consumed = active.run.completedSetup?.some((value) => value.check === action.capability);
    const receipt = await this.currentReceipt(active, action.capability);
    if (!consumed && !receipt) return this.pauseExecution(active, index, action.capability);
    if (receipt && !consumed)
      active.run.completedSetup = [
        ...(active.run.completedSetup ?? []),
        { check: action.capability, receiptId: receipt.id, planDigest: receipt.planDigest },
      ];
    active.run.cursor = index + 1;
    await this.journal.save(active.run, 'manual-receipt-consumed');
    return true;
  }
  private async executeRecipe(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'recipe' }>,
    index: number,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    live: DeviceObservation,
  ): Promise<boolean> {
    if (!this.port.runRecipe) throw new Error('Configured recipe adapter is unavailable');
    const evidenceId = `${active.run.id}:recipe:${index}`;
    const previousId = index === 0 ? active.prepared.refreshedFrom?.pendingRecipeEvidenceId : undefined;
    const previous = await this.store.get<RecipeProof>('capability-evidence', previousId ?? evidenceId);
    if (previous?.status === 'manual-pending')
      return this.completeManualRecipe(active, action, index, profile, user, live, previous);
    const result = await this.port.runRecipe(active.target, user, action.recipe, active.context);
    this.checkRecipeResult(action.recipe, result);
    if (result.status === 'manual-pending') {
      await this.writeRecipeEvidence(active, action, index, profile, user, result, 'manual-pending');
      active.observation = await this.observations.observe(active.target, active.control.signal);
      return this.pauseExecution(active, index, 'app_setup');
    }
    if (result.postconditions !== action.recipe.postconditions.length)
      throw new Error('Recipe postcondition evidence is incomplete');
    await this.writeRecipeEvidence(active, action, index, profile, user, result, 'measured');
    return true;
  }
  private checkRecipeResult(recipe: RecipePolicy, result: RecipeExecutionResult): void {
    if (
      result.capability !== 'app-setup' ||
      result.recipeDigest !== digest(recipe) ||
      !['measured', 'manual-pending'].includes(result.status)
    )
      throw new Error('Recipe adapter returned evidence for a different configuration');
  }
  private async completeManualRecipe(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'recipe' }>,
    index: number,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    live: DeviceObservation,
    previous: RecipeProof,
  ): Promise<boolean> {
    if (previous.configurationDigest !== digest(action.recipe) || !sameUser(previous.user, user))
      throw new Error('Recipe checkpoint identity changed');
    if (!(await this.currentReceipt(active, 'app_setup', live)))
      return this.pauseExecution(active, index, 'app_setup', live);
    await this.writeRecipeEvidence(active, action, index, profile, user, previous.result, 'manual-completed');
    return true;
  }
  private async writeRecipeEvidence(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'recipe' }>,
    index: number,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
    result: RecipeExecutionResult,
    status: 'measured' | 'manual-completed' | 'manual-pending',
  ): Promise<void> {
    const evidenceId = `${active.run.id}:recipe:${index}`;
    const configurationDigest = digest(action.recipe);
    await this.store.set('capability-evidence', evidenceId, {
      kind: 'recipe',
      status,
      runId: active.run.id,
      policyDigest: active.prepared.plan.policyDigest,
      configurationDigest,
      user,
      app: {
        packageId: action.recipe.packageId,
        versionCode: action.recipe.versionCode,
        signerSha256: action.recipe.signerSha256,
      },
      ...(status !== 'manual-pending'
        ? {
            observationDigest: observationDigest(
              await this.observations.observe(active.target, active.control.signal),
            ),
          }
        : {}),
      result,
    });
    if (status === 'manual-pending') return;
    active.run.capabilityEvidence = [
      ...(active.run.capabilityEvidence ?? []).filter((value) => value.evidenceId !== evidenceId),
      { kind: 'recipe', profileId: profile.id, configurationDigest, evidenceId, status },
    ];
  }
  private probeRoute(value: ProbeObservation, requireVpn: boolean): boolean {
    return (
      Number.isSafeInteger(value.uid) &&
      value.uid > 0 &&
      value.requestSucceeded &&
      value.connectionObserved &&
      (!requireVpn || value.vpnActive) &&
      typeof value.egressIp === 'string' &&
      value.egressIp.length > 0
    );
  }
  private validProbeFailure(
    failure: ProbeExecutionResult['failures'][number],
    normal: ProbeObservation,
    probe: NetworkProbePolicy,
    index: number,
  ): boolean {
    return (
      failure.stoppedPackage === probe.failurePackages[index] &&
      failure.stopped.uid === normal.uid &&
      failure.recovered.uid === normal.uid &&
      !failure.stopped.requestSucceeded &&
      !failure.stopped.connectionObserved &&
      !!failure.stopped.errorType &&
      this.probeRoute(failure.recovered, probe.requireVpn)
    );
  }
  private checkProbeResult(probe: NetworkProbePolicy, result: ProbeExecutionResult): void {
    if (
      result.scope !== 'probe-app-uid-https-only' ||
      !this.probeRoute(result.normal, probe.requireVpn) ||
      result.failures.length !== probe.failurePackages.length ||
      result.failures.some((failure, index) => !this.validProbeFailure(failure, result.normal, probe, index))
    )
      throw new Error('Network probe evidence is incomplete or outside the requested helper UID scope');
  }
  private async executeProbe(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'network-probe' }>,
    index: number,
    profile: ProfilePolicy,
    user: AndroidUserIdentity,
  ): Promise<void> {
    if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
    const effect = active.effects.find((value) => value.packageId === action.probe.artifact.packageId);
    if (!effect || effect.users.length)
      throw new Error('Probe helper state differs from its reviewed empty baseline');
    const prior = new Set((await active.scope.list()).map((value) => value.id));
    await this.artifacts.validateBeforeExecution?.(
      action.probe.artifact,
      active.target,
      active.control.signal,
    );
    const result = await this.port.runProbe(active.target, user, action.probe, {
      ...active.context,
      reviewedDeviceWideEffect: { ...effect, toVersionCode: action.probe.artifact.versionCode },
    });
    this.checkProbeResult(action.probe, result);
    if (
      !(await this.effectsMatch(active)) ||
      (await active.scope.list()).some((value) => !prior.has(value.id) && value.status !== 'resolved')
    )
      throw new Error('Network probe cleanup is incomplete');
    const configurationDigest = digest(profile.networkProbe ?? action.probe);
    const evidenceId = `${active.run.id}:probe:${index}`;
    await this.store.set('capability-evidence', evidenceId, {
      kind: 'network-probe',
      status: 'measured',
      runId: active.run.id,
      policyDigest: active.prepared.plan.policyDigest,
      configurationDigest,
      user,
      observationDigest: observationDigest(
        await this.observations.observe(active.target, active.control.signal),
      ),
      result,
    });
    active.run.capabilityEvidence = [
      ...(active.run.capabilityEvidence ?? []),
      { kind: 'network-probe', profileId: profile.id, configurationDigest, evidenceId, status: 'measured' },
    ];
  }
  private async executeLanguage(
    active: ActiveExecution,
    action: Extract<Action, { kind: 'language' }>,
    index: number,
    user: AndroidUserIdentity,
    live: DeviceObservation,
  ): Promise<boolean> {
    const receipts = await this.evidence.receipts(active.target.device.assetId);
    if (
      !receipts.some((value) =>
        normalReceiptMatches(value, active.prepared.plan.digest, live, active.run.completedSetup),
      )
    )
      return this.pauseExecution(active, index, 'normal_credentials', live);
    const result = await this.port.language(active.target, user, action.language, active.context);
    if (result?.status === 'manual-pending')
      return this.pauseExecution(active, index, `language:${action.profileId}`, live);
    return true;
  }
  private async completeActions(active: ActiveExecution): Promise<void> {
    if (active.prepared.operation === 'install-os') {
      active.run.status = 'pending';
      await this.journal.save(active.run, 'awaiting-os-reenrollment');
      return;
    }
    active.observation = await this.observations.observe(active.target, active.control.signal);
    const state = this.workflowState(active.target, active.prepared, active.observation, active.run);
    active.run.status =
      state.status === 'verified' && active.prepared.operation !== 'provision' ? 'completed' : 'pending';
    await this.checkpoint(active, active.run.status);
  }
  async cancel(runId: string): Promise<void> {
    if (!(await this.store.get<RunRecord>('runs', runId))) throw new Error('Unknown run');
    await this.store.set('cancellation', runId, { requested: true });
  }
}
