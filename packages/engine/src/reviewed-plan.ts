import { digest, observationDigest, validateSharedEffect } from '@pxv/contracts';
import type { ArtifactPolicy, SharedApkEffect } from '@pxv/contracts';
import type { PreparedOperation } from './workflow-types.js';
export function sameArtifact(a: ArtifactPolicy, b: ArtifactPolicy): boolean {
  return (
    a.packageId === b.packageId &&
    a.versionCode === b.versionCode &&
    a.sha256 === b.sha256 &&
    a.signerSha256 === b.signerSha256
  );
}

export function summaryData(prepared: Omit<PreparedOperation, 'reviewSummary'>): Record<string, unknown> {
  const { plan, target, baseline, operation, expiresAt, osSnapshot } = prepared;
  return {
    planId: plan.id,
    operation,
    expiresAt,
    assetId: target.device.assetId,
    deviceKind: target.device.kind,
    transport: target.transport,
    policyDigest: plan.policyDigest,
    users: baseline.profiles.map((value) => ({ profileId: value.profileId, user: value.user })),
    sharedEffects: prepared.sharedEffects,
    refreshedFrom: prepared.refreshedFrom
      ? {
          runId: prepared.refreshedFrom.runId,
          planDigest: prepared.refreshedFrom.planDigest,
          completedActions: prepared.refreshedFrom.completedActions,
          completedSetup: prepared.refreshedFrom.completedSetup.map((value) => value.check),
          completedCapabilities: prepared.refreshedFrom.capabilityEvidence.map((value) => ({
            kind: value.kind,
            profileId: value.profileId,
            configurationDigest: value.configurationDigest,
          })),
        }
      : null,
    osSnapshot: osSnapshot
      ? { sha256: osSnapshot.sha256, signatureSha256: osSnapshot.signatureSha256, policy: osSnapshot.policy }
      : null,
    actions: plan.actions.map((action) =>
      action.kind === 'install-apk'
        ? {
            ...action,
            artifact: {
              packageId: action.artifact.packageId,
              versionCode: action.artifact.versionCode,
              sha256: action.artifact.sha256,
              signerSha256: action.artifact.signerSha256,
            },
            sharedWithProfiles: baseline.profiles
              .filter((value) =>
                value.packages.some((artifact) => artifact.packageId === action.artifact.packageId),
              )
              .map((value) => value.profileId),
          }
        : action.kind === 'network-probe'
          ? {
              ...action,
              probe: {
                ...action.probe,
                artifact: {
                  packageId: action.probe.artifact.packageId,
                  versionCode: action.probe.artifact.versionCode,
                  sha256: action.probe.artifact.sha256,
                  signerSha256: action.probe.artifact.signerSha256,
                },
              },
              scope: 'probe-app-uid-https-only',
            }
          : action,
    ),
    notes: [
      'APK versions are shared across Android users',
      'Manual checks are separate from automated observations',
    ],
  };
}

export function preparedDigest(
  prepared: Omit<PreparedOperation, 'reviewSummary'>,
  extensions: unknown,
): string {
  const { digest: _digest, ...body } = prepared.plan;
  void _digest;
  return digest({
    plan: body,
    baseline: observationDigest(prepared.baseline),
    extensions,
    target: prepared.target,
    osSnapshot: prepared.osSnapshot ?? null,
    sharedEffects: prepared.sharedEffects,
    operation: prepared.operation,
    expiresAt: prepared.expiresAt,
    refreshedFrom: prepared.refreshedFrom ?? null,
    review: summaryData(prepared),
  });
}

export function canonicalEffects(input: SharedApkEffect[]): SharedApkEffect[] {
  const effects = input
    .map(validateSharedEffect)
    .map((effect) => ({
      ...effect,
      users: [...effect.users].sort((a, b) => a.user.serialNo - b.user.serialNo),
    }))
    .sort((a, b) => a.packageId.localeCompare(b.packageId));
  if (new Set(effects.map((effect) => effect.packageId)).size !== effects.length)
    throw new Error('Duplicate shared APK effects');
  return effects;
}
