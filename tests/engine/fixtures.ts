import type {
  AndroidUserIdentity,
  ArtifactPolicy,
  DeviceObservation,
  ExecutionPolicy,
  ProfilePolicy,
  SelectedTarget,
  SharedApkEffect,
} from '@pxv/contracts';
import type { ExecutionContext, WorkflowPort, WorkflowEngine } from '@pxv/engine';
import { writePolicyLock, type ProjectContext } from '@pxv/engine';
import { observation, policy } from '../contracts/fixtures.js';

/** Explicitly approve a synthetic fixture's baseline before reviewed device work. */
export async function approveProject(project: ProjectContext): Promise<ProjectContext> {
  await writePolicyLock(project);
  return project;
}

export function basePolicy(): ExecutionPolicy {
  const result = structuredClone(policy);
  result.capabilities = [];
  result.requiredAttestations = ['operator_signoff', 'recipient_acceptance'];
  for (const profile of result.profiles) {
    delete profile.language;
    delete profile.defaultLocale;
  }
  return result;
}

/** Existing workflow regressions explicitly simulate the new witnessed Settings steps. */
export async function executeWithWitnesses(engine: WorkflowEngine, runId: string, signal?: AbortSignal) {
  let run = await engine.execute(runId, signal);
  while (run.status === 'pending' && run.manualGate === 'vpn_settings') {
    const prepared = await engine.plan(run.planId);
    const action = prepared.plan.actions[run.cursor ?? -1];
    const port = engine.port;
    if (action?.kind !== 'vpn' || !(port instanceof MemoryPort)) throw new Error('VPN fixture missing');
    const profile = port.observation.profiles.find((value) => value.profileId === action.profileId);
    if (!profile) throw new Error('VPN fixture profile missing');
    profile.vpn = structuredClone(action.vpn);
    await engine.attest(prepared.target, 'vpn_settings', 'Fixture witness');
    run = await engine.execute(runId, signal);
  }
  return run;
}

export class MemoryPort implements WorkflowPort {
  verifyEmulatorEvidence?: NonNullable<WorkflowPort['verifyEmulatorEvidence']>;
  runRecipe?: NonNullable<WorkflowPort['runRecipe']>;
  runProbe?: NonNullable<WorkflowPort['runProbe']>;
  cleanup?: NonNullable<WorkflowPort['cleanup']>;
  inspectUser?: NonNullable<WorkflowPort['inspectUser']>;
  observation: DeviceObservation = structuredClone(observation);
  calls: string[] = [];
  failAt: string | undefined;

  private mark(kind: string, context: ExecutionContext): void {
    this.calls.push(kind);
    context.signal?.throwIfAborted();
    if (!context.lease) throw new Error('Mutation missing native lease');
    if (this.failAt === kind) throw new Error(`Injected ${kind} failure`);
  }
  private profile(user: AndroidUserIdentity): DeviceObservation['profiles'][number] {
    const profile = this.observation.profiles.find(
      (item) => item.user.serialNo === user.serialNo && item.user.userId === user.userId,
    );
    if (!profile) throw new Error('Unknown stable user');
    return profile;
  }
  inspect(
    _target: SelectedTarget,
    _policy: ExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<DeviceObservation> {
    signal?.throwIfAborted();
    return Promise.resolve(structuredClone(this.observation));
  }
  createUser(
    _target: SelectedTarget,
    profile: ProfilePolicy,
    context: ExecutionContext,
  ): Promise<AndroidUserIdentity> {
    this.mark('create-user', context);
    const user = {
      userId: 10 + this.observation.profiles.length,
      serialNo: 30 + this.observation.profiles.length,
      name: profile.name,
    };
    this.observation.profiles.push({
      profileId: profile.id,
      user,
      packages: [],
      settings: [],
      permissions: [],
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    });
    return Promise.resolve(user);
  }
  install(
    _target: SelectedTarget,
    user: AndroidUserIdentity,
    artifact: ArtifactPolicy,
    context: ExecutionContext,
  ): Promise<void> {
    this.mark('install-apk', context);
    if (!context.reviewedDeviceWideEffect) throw new Error('Missing shared APK review');
    for (const item of this.observation.profiles)
      for (const installed of item.packages)
        if (installed.packageId === artifact.packageId) {
          installed.versionCode = artifact.versionCode;
          installed.signerSha256 = artifact.signerSha256;
        }
    const profile = this.profile(user);
    profile.packages = [
      ...profile.packages.filter((item) => item.packageId !== artifact.packageId),
      {
        packageId: artifact.packageId,
        versionCode: artifact.versionCode,
        signerSha256: artifact.signerSha256,
      },
    ];
    return Promise.resolve();
  }
  applySetting(
    _target: SelectedTarget,
    user: AndroidUserIdentity,
    setting: ProfilePolicy['settings'][number],
    context: ExecutionContext,
  ): Promise<void> {
    this.mark('setting', context);
    const profile = this.profile(user);
    profile.settings = [
      ...profile.settings.filter((item) => item.namespace !== setting.namespace || item.key !== setting.key),
      setting,
    ];
    return Promise.resolve();
  }
  applyPermission(
    _target: SelectedTarget,
    user: AndroidUserIdentity,
    permission: ProfilePolicy['permissions'][number],
    context: ExecutionContext,
  ): Promise<void> {
    this.mark('permission', context);
    const profile = this.profile(user);
    profile.permissions = [
      ...profile.permissions.filter(
        (item) => item.packageId !== permission.packageId || item.permission !== permission.permission,
      ),
      permission,
    ];
    return Promise.resolve();
  }
  verifyVpnConfiguration(
    _target: SelectedTarget,
    user: AndroidUserIdentity,
    vpn: ProfilePolicy['vpn'],
    context: ExecutionContext,
  ): Promise<void> {
    context.signal?.throwIfAborted();
    if (JSON.stringify(this.profile(user).vpn) !== JSON.stringify(vpn))
      throw new Error('VPN configuration differs from witnessed Settings');
    return Promise.resolve();
  }
  language(
    _target: SelectedTarget,
    user: AndroidUserIdentity,
    language: string,
    context: ExecutionContext,
  ): ReturnType<WorkflowPort['language']> {
    this.mark('language', context);
    this.profile(user).language = language;
    return Promise.resolve();
  }
  flash(_target: SelectedTarget, _policy: ExecutionPolicy, context: ExecutionContext): Promise<void> {
    this.mark('install-os', context);
    return Promise.resolve();
  }
  finalize(_target: SelectedTarget, context: ExecutionContext): Promise<void> {
    this.mark('finalize', context);
    this.observation.debuggingEnabled = false;
    return Promise.resolve();
  }
  sharedEffects(_target: SelectedTarget, packageIds: string[]): Promise<SharedApkEffect[]> {
    return Promise.resolve(
      packageIds.map((packageId) => ({
        packageId,
        users: this.observation.profiles.flatMap((profile) =>
          profile.packages
            .filter((item) => item.packageId === packageId)
            .map((item) => ({
              user: profile.user,
              versionCode: item.versionCode,
              signerSha256: item.signerSha256,
            })),
        ),
      })),
    );
  }
}
