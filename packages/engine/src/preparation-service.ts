import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  digest,
  finalSetupActions,
  requiredAttestations,
  validateAction,
  validateArtifact,
} from '@pxv/contracts';
import type {
  Action,
  ArtifactPolicy,
  DeviceObservation,
  ProfilePolicy,
  RecipePolicy,
  NetworkProbePolicy,
  SelectedTarget,
  SharedApkEffect,
} from '@pxv/contracts';
import type { ProjectContext } from './project.js';
import type {
  ArtifactPort,
  WorkflowPort,
  PreparedOperation,
  Operation,
  OsSnapshot,
} from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import type { PlanWriter } from './plan-repository.js';
import { sameArtifact } from './reviewed-plan.js';
export interface Preparation {
  prepare(target: SelectedTarget, operation?: Operation, signal?: AbortSignal): Promise<PreparedOperation>;
  prepareExtension(
    target: SelectedTarget,
    contributions: Action[],
    signal?: AbortSignal,
  ): Promise<PreparedOperation>;
  reviewEffects(target: SelectedTarget, actions: Action[], signal?: AbortSignal): Promise<SharedApkEffect[]>;
}
export class PreparationService implements Preparation {
  constructor(
    readonly project: ProjectContext,
    readonly port: WorkflowPort,
    readonly artifacts: ArtifactPort,
    readonly observations: ObservationReader,
    readonly plans: PlanWriter,
    readonly clock: () => Date,
  ) {}
  /** Artifact acquisition is allowed; preparation never changes the phone. */
  async prepare(
    target: SelectedTarget,
    operation: Operation = 'provision',
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    if (operation === 'extension') throw new Error('Use prepareExtension for explicit contributed actions');
    return this.prepareActions(target, operation, signal);
  }
  async prepareExtension(
    target: SelectedTarget,
    contributions: Action[],
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    if (!Array.isArray(contributions) || contributions.length === 0 || contributions.length > 1000)
      throw new Error('An extension must contribute a bounded nonempty list of core actions');
    const actions = contributions.map(validateAction);
    const os = actions.filter((action) => action.kind === 'install-os');
    if (os.length) {
      if (actions.length !== 1 || digest(os[0]?.os) !== digest(this.project.policy.os ?? null))
        throw new Error('OS extension actions must be a separate operation using the selected policy');
      return this.prepare(target, 'install-os', signal);
    }
    for (const action of actions) this.assertExtensionAction(target, action);
    return this.prepareActions(target, 'extension', signal, actions);
  }
  private assertExtensionAction(target: SelectedTarget, action: Action): void {
    if (action.kind === 'install-os') throw new Error('OS actions require separate preparation');
    if (action.kind === 'manual') {
      if (
        ![
          ...this.project.policy.capabilities,
          ...requiredAttestations(this.project.policy, target.device.kind),
        ].includes(action.capability)
      )
        throw new Error('Extension manual action is outside selected policy capabilities');
      return;
    }
    const profile = this.project.policy.profiles.find((value) => value.id === action.profileId);
    if (!profile) throw new Error('Extension references a profile outside selected policy');
    if (!this.extensionActionMatches(profile, action))
      throw new Error('Extension action contradicts selected policy');
  }
  private extensionActionMatches(
    profile: ProfilePolicy,
    action: Exclude<Action, { kind: 'manual' | 'install-os' }>,
  ): boolean {
    switch (action.kind) {
      case 'install-apk':
        return profile.packages.some((value) => sameArtifact(value, action.artifact));
      case 'setting':
        return profile.settings.some((value) => digest(value) === digest(action.setting));
      case 'permission':
        return profile.permissions.some((value) => digest(value) === digest(action.permission));
      case 'vpn':
        return digest(profile.vpn) === digest(action.vpn);
      case 'language':
        return profile.language === action.language;
      case 'recipe':
        return this.declaredRecipes(profile).some((value) => digest(value) === digest(action.recipe));
      case 'network-probe':
        return this.declaredProbeMatches(profile, action.probe);
      case 'create-user':
        return profile.kind === 'secondary' && profile.name === action.name;
    }
  }
  private declaredRecipes(profile: ProfilePolicy): RecipePolicy[] {
    return profile.recipes ?? [];
  }
  private declaredProbeMatches(profile: ProfilePolicy, probe: NetworkProbePolicy): boolean {
    return profile.networkProbe !== undefined && digest(profile.networkProbe) === digest(probe);
  }
  private async prepareActions(
    target: SelectedTarget,
    operation: Operation,
    signal?: AbortSignal,
    contributions?: Action[],
  ): Promise<PreparedOperation> {
    this.observations.assertTarget(target);
    const lifecycleGeneration = await this.plans.generation(target.device.assetId);
    const baseline = await this.prepareBaseline(target, operation, signal);
    const id = randomUUID();
    let actions: Action[];
    let osSnapshot: OsSnapshot | undefined;
    if (operation === 'install-os') {
      osSnapshot = await this.prepareOs(id, signal);
      actions = [{ kind: 'install-os', os: osSnapshot.policy }];
    } else if (contributions) {
      actions = [];
      for (const action of contributions)
        actions.push(await this.snapshotContribution(target, id, actions.length, action, signal));
    } else actions = await this.prepareProfiles(target, id, operation, baseline, signal);
    const sharedEffects = await this.reviewEffects(target, actions, signal);
    return this.plans.persist({
      id,
      target,
      operation,
      baseline,
      actions,
      sharedEffects,
      ...(lifecycleGeneration ? { lifecycleGeneration } : {}),
      ...(osSnapshot ? { osSnapshot } : {}),
    });
  }
  private async prepareBaseline(
    target: SelectedTarget,
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<DeviceObservation> {
    if (operation === 'install-os') {
      if (target.device.kind !== 'pixel' || target.transport.kind !== 'usb' || !this.project.policy.os)
        throw new Error('OS installation requires an enrolled USB Pixel and pinned OS policy');
      return {
        schemaVersion: 1,
        device: target.device,
        observedAt: this.clock().toISOString(),
        os: { codename: target.device.codename, release: 'unobserved', bootVerified: false },
        profiles: [],
        helpers: [],
        debuggingEnabled: false,
      };
    }
    const baseline = await this.observations.observe(target, signal);
    const owner = this.project.policy.profiles.find((value) => value.kind === 'owner');
    const actual = baseline.profiles.find((value) => value.profileId === owner?.id);
    if (owner && actual && actual.user.name !== owner.name)
      throw new Error('Owner display name differs; update policy or rename on device and prepare again');
    return baseline;
  }
  private async prepareOs(id: string, signal?: AbortSignal): Promise<OsSnapshot> {
    const os = this.project.policy.os;
    if (!os) throw new Error('OS policy is missing');
    if (!this.artifacts.snapshotOs) throw new Error('Verified OS snapshot service is required');
    return this.artifacts.snapshotOs(os, join(this.project.root, 'state/plans', id, 'os'), signal);
  }
  private async snapshotArtifact(
    target: SelectedTarget,
    artifact: ArtifactPolicy,
    path: string,
    signal?: AbortSignal,
    probe = false,
  ): Promise<ArtifactPolicy> {
    const result = validateArtifact(await this.artifacts.snapshot(artifact, path, signal, target));
    if (!sameArtifact(result, artifact))
      throw new Error(
        probe
          ? 'Probe helper snapshot identity differs from selected policy'
          : 'Artifact service returned a different identity than reviewed policy',
      );
    return result;
  }
  private async snapshotContribution(
    target: SelectedTarget,
    id: string,
    index: number,
    action: Action,
    signal?: AbortSignal,
  ): Promise<Action> {
    if (action.kind === 'install-apk')
      return {
        ...action,
        artifact: await this.snapshotArtifact(
          target,
          action.artifact,
          join(
            this.project.root,
            'state/plans',
            id,
            `${index}-${action.profileId}-${action.artifact.packageId}.apk`,
          ),
          signal,
        ),
      };
    if (action.kind === 'network-probe') {
      if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
      const artifact = await this.snapshotArtifact(
        target,
        action.probe.artifact,
        join(this.project.root, 'state/plans', id, `probe-${index}-${action.profileId}.apk`),
        signal,
        true,
      );
      return { ...action, probe: { ...action.probe, artifact } };
    }
    if (action.kind === 'recipe' && !this.port.runRecipe)
      throw new Error('Configured recipe adapter is unavailable');
    return action;
  }
  private async prepareProfiles(
    target: SelectedTarget,
    id: string,
    operation: Operation,
    baseline: DeviceObservation,
    signal?: AbortSignal,
  ): Promise<Action[]> {
    const actions: Action[] = [];
    for (const profile of this.project.policy.profiles) {
      const observed = baseline.profiles.find((value) => value.profileId === profile.id);
      if (!observed) actions.push(this.missingProfileAction(profile, operation));
      if (operation === 'create-users') continue;
      actions.push(...(await this.preparePackages(target, id, profile, observed, signal)));
      if (operation === 'provision')
        actions.push(
          ...this.prepareSettings(profile, observed),
          ...(await this.prepareCapabilities(target, id, profile, signal)),
        );
    }
    if (operation === 'provision') actions.push(...this.remainingSetupActions(baseline));
    return actions;
  }
  private missingProfileAction(profile: ProfilePolicy, operation: Operation): Action {
    if (profile.kind === 'owner') throw new Error('The owner user must already exist');
    if (operation === 'deploy-apps')
      throw new Error('Deploy requires existing Android users; review user creation separately');
    return { kind: 'create-user', profileId: profile.id, name: profile.name };
  }
  private async preparePackages(
    target: SelectedTarget,
    id: string,
    profile: ProfilePolicy,
    observed: DeviceObservation['profiles'][number] | undefined,
    signal?: AbortSignal,
  ): Promise<Action[]> {
    const actions: Action[] = [];
    for (const artifact of profile.packages) {
      const current = observed?.packages.find((value) => value.packageId === artifact.packageId);
      if (current && current.versionCode > artifact.versionCode) throw new Error('Package downgrade refused');
      if (current?.versionCode === artifact.versionCode && current.signerSha256 === artifact.signerSha256)
        continue;
      const snapshot = await this.snapshotArtifact(
        target,
        artifact,
        join(this.project.root, 'state/plans', id, `${profile.id}-${artifact.packageId}.apk`),
        signal,
      );
      actions.push({ kind: 'install-apk', profileId: profile.id, artifact: snapshot });
    }
    return actions;
  }
  private prepareSettings(
    profile: ProfilePolicy,
    observed: DeviceObservation['profiles'][number] | undefined,
  ): Action[] {
    const actions: Action[] = [];
    for (const setting of profile.settings)
      if (!observed?.settings.some((value) => digest(value) === digest(setting)))
        actions.push({ kind: 'setting', profileId: profile.id, setting });
    for (const permission of profile.permissions)
      if (!observed?.permissions.some((value) => digest(value) === digest(permission)))
        actions.push({ kind: 'permission', profileId: profile.id, permission });
    if (!observed || digest(observed.vpn) !== digest(profile.vpn))
      actions.push({ kind: 'vpn', profileId: profile.id, vpn: profile.vpn });
    return actions;
  }
  private async prepareCapabilities(
    target: SelectedTarget,
    id: string,
    profile: ProfilePolicy,
    signal?: AbortSignal,
  ): Promise<Action[]> {
    const actions: Action[] = [];
    for (const recipe of this.declaredRecipes(profile)) {
      if (!this.port.runRecipe) throw new Error('Configured recipe adapter is unavailable');
      actions.push({ kind: 'recipe', profileId: profile.id, recipe });
    }
    if (profile.networkProbe) {
      if (!this.port.runProbe) throw new Error('Configured network probe adapter is unavailable');
      const artifact = await this.snapshotArtifact(
        target,
        profile.networkProbe.artifact,
        join(this.project.root, 'state/plans', id, `probe-${profile.id}.apk`),
        signal,
        true,
      );
      actions.push({
        kind: 'network-probe',
        profileId: profile.id,
        probe: { ...profile.networkProbe, artifact },
      });
    }
    return actions;
  }
  private remainingSetupActions(baseline: DeviceObservation): Action[] {
    return finalSetupActions(this.project.policy).filter(
      (action) =>
        action.kind !== 'language' ||
        baseline.profiles.find((value) => value.profileId === action.profileId)?.language !== action.language,
    );
  }
  private installedPackages(actions: readonly Action[]): string[] {
    return [
      ...new Set(
        actions.flatMap((action) =>
          action.kind === 'install-apk'
            ? [action.artifact.packageId]
            : action.kind === 'network-probe'
              ? [action.probe.artifact.packageId]
              : [],
        ),
      ),
    ];
  }
  async reviewEffects(
    target: SelectedTarget,
    actions: Action[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]> {
    const effects = await this.observations.sharedEffects(target, this.installedPackages(actions), signal);
    for (const effect of effects) this.assertSharedEffect(effect, actions);
    return effects;
  }
  private assertSharedEffect(effect: SharedApkEffect, actions: Action[]): void {
    if (
      actions.some(
        (action) => action.kind === 'network-probe' && action.probe.artifact.packageId === effect.packageId,
      ) &&
      effect.users.length
    )
      throw new Error('A probe helper is already installed; inspect its owner before continuing');
    const action = actions.find(
      (value) => value.kind === 'install-apk' && value.artifact.packageId === effect.packageId,
    );
    if (
      action?.kind === 'install-apk' &&
      effect.users.some(
        (item) =>
          item.versionCode > action.artifact.versionCode ||
          item.signerSha256 !== action.artifact.signerSha256,
      )
    )
      throw new Error('A shared APK would downgrade or replace another Android user signer');
  }
}
