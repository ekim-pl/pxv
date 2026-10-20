import {
  FdroidclSession,
  type ArtifactService,
  type AuthenticatedUpdateRepository,
  type CandidateDevice,
  type CommandRunner,
  type HostTools,
  type RepositoryApk,
  type RepositoryService,
} from '@pxv/adapters';
import type { ArtifactPolicy, PolicyDocument, RepositoryPolicy } from '@pxv/contracts';
import {
  artifactRepository,
  OFFICIAL_FDROID,
  repositoryForUpdate,
  repositoryUpdateKey,
} from './artifact-repository.js';

export interface AppUpdate {
  appId: string;
  before: ArtifactPolicy;
  after: ArtifactPolicy;
}
export interface AppUpdatePlan {
  policy: PolicyDocument;
  updates: AppUpdate[];
  unchanged: string[];
  skipped: { appId: string; reason: string }[];
}
export interface AppUpdateServices {
  runner: CommandRunner;
  tools: HostTools;
  repositories: RepositoryService;
  artifacts: ArtifactService;
}
interface RepositoryGroup {
  repository: RepositoryPolicy;
  apps: [string, ArtifactPolicy][];
}

function repositoryGroups(document: PolicyDocument, plan: AppUpdatePlan): RepositoryGroup[] {
  const trusted = [OFFICIAL_FDROID, ...document.repositories];
  for (const app of Object.values(document.apps)) {
    const repository = artifactRepository(app, document.repositories);
    if (repository) trusted.push(repository);
  }
  const groups = new Map<string, RepositoryGroup>();
  for (const [id, app] of Object.entries(document.apps)) {
    const repository = repositoryForUpdate(app, trusted);
    if (!repository) {
      plan.skipped.push({
        appId: id,
        reason: 'No trusted F-Droid repository mapping (local or publisher APK)',
      });
      continue;
    }
    const key = repositoryUpdateKey(repository);
    const group = groups.get(key) ?? { repository, apps: [] };
    group.apps.push([id, app]);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function compatible(row: RepositoryApk, device: CandidateDevice): boolean {
  const { minSdk, maxSdk, abis } = row.compatibility;
  return (
    minSdk <= device.sdk &&
    (maxSdk === undefined || maxSdk >= device.sdk) &&
    (!abis.length || abis.some((abi) => device.abis.includes(abi)))
  );
}

function stableCandidate(
  services: AppUpdateServices,
  index: AuthenticatedUpdateRepository,
  app: ArtifactPolicy,
  device: CandidateDevice,
): ArtifactPolicy | string {
  const rows = index.packages[app.packageId] ?? [];
  const signer = app.signerSha256.toLowerCase();
  const current = rows.filter((row) => row.versionCode === app.versionCode && row.signerSha256 === signer);
  if (current.some((row) => row.sha256 !== app.sha256.toLowerCase()))
    throw new Error(`Repository replaced pinned APK bytes for ${app.packageId}:${app.versionCode}`);
  const suggestion = index.suggestedVersionCodes[app.packageId];
  if (suggestion === undefined) return 'Repository has no stable suggestedVersionCode for this package';
  const stable = rows.filter((row) => row.versionCode <= suggestion && compatible(row, device));
  const approved = stable.filter((row) => row.signerSha256 === signer);
  const latest = Math.max(0, ...approved.map((row) => row.versionCode));
  if (stable.some((row) => row.versionCode >= app.versionCode && row.versionCode > latest))
    throw new Error(
      `Latest stable APK requires a signing-key change for ${app.packageId}; review it manually`,
    );
  if (!approved.length) return 'Repository has no compatible stable version with the pinned signer';
  const candidate = services.repositories.candidate(
    { ...index, packages: { [app.packageId]: approved } },
    app.packageId,
    device,
  );
  if (
    rows.some(
      (row) =>
        row.versionCode === candidate.versionCode &&
        (row.sha256 !== candidate.sha256 || row.signerSha256 !== candidate.signerSha256),
    )
  )
    throw new Error(`Ambiguous repository APK identities for ${app.packageId}:${candidate.versionCode}`);
  if (candidate.versionCode < app.versionCode)
    return 'Policy version is newer than the latest compatible stable version';
  return candidate;
}

function updatedArtifact(before: ArtifactPolicy, candidate: ArtifactPolicy): ArtifactPolicy {
  const after = { ...before, versionCode: candidate.versionCode, sha256: candidate.sha256 };
  if (before.source?.kind === 'direct') after.source = { ...before.source, url: candidate.url! };
  else if (before.url) after.url = candidate.url!;
  return after;
}

async function updateRepository(
  group: RepositoryGroup,
  plan: AppUpdatePlan,
  services: AppUpdateServices,
  device: CandidateDevice,
  signal: AbortSignal,
): Promise<void> {
  const session = await FdroidclSession.open(
    services.runner,
    await services.tools.require('fdroidcl'),
    group.repository,
    signal,
  );
  try {
    await session.update();
    const index = await services.repositories.indexFromJar(group.repository, session.indexPath, {
      signal,
      packageIds: group.apps.map(([, app]) => app.packageId),
    });
    for (const [id, app] of group.apps) {
      signal.throwIfAborted();
      const candidate = stableCandidate(services, index, app, device);
      if (typeof candidate === 'string') plan.skipped.push({ appId: id, reason: candidate });
      else if (candidate.versionCode === app.versionCode) plan.unchanged.push(id);
      else {
        await Promise.all([services.tools.require('aapt'), services.tools.require('apksigner')]);
        const path = await session.download(candidate);
        await services.artifacts.inspect(path, candidate, signal);
        await services.artifacts.checkCompatibility(path, device.sdk, device.abis, signal);
        const after = updatedArtifact(app, candidate);
        plan.policy.apps[id] = after;
        plan.updates.push({ appId: id, before: app, after });
      }
    }
  } finally {
    await session.close();
  }
}

export async function planAppUpdates(
  document: PolicyDocument,
  services: AppUpdateServices,
  device: CandidateDevice,
  signal: AbortSignal,
): Promise<AppUpdatePlan> {
  const plan: AppUpdatePlan = { policy: structuredClone(document), updates: [], unchanged: [], skipped: [] };
  const groups = repositoryGroups(document, plan);
  if (groups.length) await services.tools.require('java');
  for (const group of groups) await updateRepository(group, plan, services, device, signal);
  return plan;
}
