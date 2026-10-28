import {
  digest,
  sameAndroidUser,
  validateObservation,
  type AndroidUserIdentity,
  type Action,
  type ArtifactPolicy,
  type DeviceObservation,
  type SelectedTarget,
  type SharedApkEffect,
} from '@pxv/contracts';
import type { ProjectContext } from './project.js';
import { canonicalEffects } from './reviewed-plan.js';
import type { WorkflowPort } from './workflow-types.js';

/** Read-only enrollment and observation boundary shared by planning, execution and handoff. */
export interface ObservationReader {
  assertTarget(target: SelectedTarget): void;
  observe(target: SelectedTarget, signal?: AbortSignal): Promise<DeviceObservation>;
  observeAction(
    target: SelectedTarget,
    previous: DeviceObservation,
    action: Action,
    signal?: AbortSignal,
  ): Promise<DeviceObservation>;
  sharedEffects(
    target: SelectedTarget,
    packageIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]>;
  nextEffects(
    effects: SharedApkEffect[],
    artifact: ArtifactPolicy,
    user: AndroidUserIdentity,
  ): SharedApkEffect[];
}

export class ObservationService implements ObservationReader {
  constructor(
    private readonly project: ProjectContext,
    private readonly port: WorkflowPort,
  ) {}

  assertTarget(target: SelectedTarget): void {
    const enrolled = this.project.inventory.devices.find(
      (device) => device.assetId === target.device.assetId,
    );
    if (
      !enrolled ||
      digest(enrolled) !== digest(target.device) ||
      !enrolled.transports.some((transport) => digest(transport) === digest(target.transport))
    )
      throw new Error('Target differs from the enrolled device or approved transport');
  }

  async observe(target: SelectedTarget, signal?: AbortSignal): Promise<DeviceObservation> {
    this.assertTarget(target);
    return this.validate(target, await this.port.inspect(target, this.project.policy, signal));
  }

  async observeAction(
    target: SelectedTarget,
    previous: DeviceObservation,
    action: Action,
    signal?: AbortSignal,
  ): Promise<DeviceObservation> {
    if (!this.port.inspectAction || !['setting', 'permission', 'install-apk'].includes(action.kind))
      return this.observe(target, signal);
    this.assertTarget(target);
    return this.validate(
      target,
      await this.port.inspectAction(target, this.project.policy, previous, action, signal),
    );
  }

  private validate(target: SelectedTarget, observation: DeviceObservation): DeviceObservation {
    const value = validateObservation(observation);
    if (value.profiles.some((profile) => profile.packages.some((artifact) => !artifact.sha256)))
      throw new Error('Installed APK content measurements are required for current observations');
    if (digest(value.device) !== digest(target.device))
      throw new Error('Observed identity differs from enrollment');
    return value;
  }

  async sharedEffects(
    target: SelectedTarget,
    packageIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]> {
    if (!packageIds.length) return [];
    if (!this.port.sharedEffects)
      throw new Error('Device-wide APK review service is required before planning an install');
    const effects = canonicalEffects(await this.port.sharedEffects(target, packageIds, signal));
    if (effects.some((effect) => effect.users.some((entry) => !entry.sha256)))
      throw new Error('Installed APK content measurements are required before reviewing shared effects');
    if (digest(effects.map((effect) => effect.packageId)) !== digest([...packageIds].sort()))
      throw new Error('Shared APK effect inspection is incomplete');
    return effects;
  }

  nextEffects(
    effects: SharedApkEffect[],
    artifact: ArtifactPolicy,
    user: AndroidUserIdentity,
  ): SharedApkEffect[] {
    return canonicalEffects(
      effects.map((effect) => {
        if (effect.packageId !== artifact.packageId) return effect;
        const users = effect.users.map((item) => ({
          ...item,
          versionCode: artifact.versionCode,
          signerSha256: artifact.signerSha256,
          sha256: artifact.sha256,
        }));
        if (!users.some((item) => sameAndroidUser(item.user, user)))
          users.push({
            user,
            versionCode: artifact.versionCode,
            signerSha256: artifact.signerSha256,
            sha256: artifact.sha256,
          });
        return { ...effect, users };
      }),
    );
  }
}
