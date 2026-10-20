import {
  FdroidclSession,
  copySnapshot,
  download,
  fileDigest,
  type AuthenticatedUpdateRepository,
  type CandidateDevice,
} from '@pxv/adapters';
import {
  validatePolicyDocument,
  validatePolicySourceDocument,
  type ArtifactDeclaration,
  type ArtifactPolicy,
  type PolicyDocument,
  type PolicySourceDocument,
  type RepositoryPolicy,
} from '@pxv/contracts';
import { containedPath } from '@pxv/engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRepository, repositoryUpdateKey } from './artifact-repository.js';
import type { AppUpdateServices } from './policy-app-updates.js';
import { compatibleRepositoryApk } from './policy-app-candidates.js';

const MAX_APK_BYTES = 512 * 1024 * 1024;
const pinKeys = ['versionCode', 'sha256', 'signerSha256'] as const;
export interface AppResolution {
  appId: string;
  before: ArtifactDeclaration;
  after: ArtifactPolicy;
  discovered: (typeof pinKeys)[number][];
  observedSignerSha256?: string;
}
export interface AppResolutionPlan {
  policy: PolicyDocument;
  resolutions: AppResolution[];
  unchanged: string[];
}

function canonicalApp(
  app: ArtifactDeclaration,
): Omit<ArtifactDeclaration, 'source'> & Pick<ArtifactPolicy, 'source'> {
  const { source, ...rest } = app;
  return { ...rest, ...(source ? { source: source.kind === 'fdroid' ? { kind: 'fdroidcl' } : source } : {}) };
}
function matchesPins(app: ArtifactDeclaration, candidate: ArtifactPolicy): boolean {
  return pinKeys.every((key) => app[key] === undefined || app[key] === candidate[key]);
}
function resolveCandidate(
  app: ArtifactDeclaration,
  index: AuthenticatedUpdateRepository,
  services: AppUpdateServices,
  device: CandidateDevice,
): ArtifactPolicy {
  const suggestion = index.suggestedVersionCodes[app.packageId];
  if (app.versionCode === undefined && suggestion === undefined)
    throw new Error(`No stable suggestedVersionCode for ${app.packageId}; specify an exact versionCode`);
  const rows = index.packages[app.packageId] ?? [];
  const approved = rows.filter(
    (row) =>
      (app.versionCode !== undefined
        ? row.versionCode === app.versionCode
        : row.versionCode <= suggestion!) &&
      compatibleRepositoryApk(row, device) &&
      matchesPins(app, row),
  );
  if (!approved.length)
    throw new Error(`No compatible repository APK satisfies supplied pins for ${app.packageId}`);
  const candidate = services.repositories.candidate(
    { ...index, packages: { [app.packageId]: approved } },
    app.packageId,
    device,
  );
  // fdroidcl downloads by package and version only; reject variants it cannot disambiguate.
  if (
    rows.some(
      (row) =>
        row.versionCode === candidate.versionCode &&
        (row.sha256 !== candidate.sha256 ||
          row.signerSha256 !== candidate.signerSha256 ||
          row.url !== candidate.url),
    )
  )
    throw new Error(`Ambiguous repository APK identities for ${app.packageId}:${candidate.versionCode}`);
  return candidate;
}

async function inspectSource(
  path: string,
  app: ArtifactDeclaration,
  services: AppUpdateServices,
  device: CandidateDevice,
  signal: AbortSignal,
): Promise<ArtifactPolicy> {
  const sha256 = await fileDigest(path, MAX_APK_BYTES, signal);
  const identity = await services.artifacts.identity(path, signal);
  const candidate = { ...identity, sha256 };
  if (candidate.packageId !== app.packageId || !matchesPins(app, candidate))
    throw new Error(`APK identity or hash does not match supplied pins for ${app.packageId}`);
  await verifyCandidate(path, candidate, services, device, signal);
  return candidate;
}
async function verifyCandidate(
  path: string,
  candidate: ArtifactPolicy,
  services: AppUpdateServices,
  device: CandidateDevice,
  signal: AbortSignal,
): Promise<void> {
  await services.artifacts.inspect(path, candidate, signal);
  await services.artifacts.checkCompatibility(path, device.sdk, device.abis, signal);
}

interface ResolutionContext {
  base: string;
  temporary: string;
  document: PolicySourceDocument;
  services: AppUpdateServices;
  device: CandidateDevice;
  signal: AbortSignal;
  sessions: Map<string, { session: FdroidclSession; index: AuthenticatedUpdateRepository }>;
}

function repositoryPackages(context: ResolutionContext, key: string): string[] {
  return Object.values(context.document.apps)
    .filter((app) => {
      const repository = artifactRepository(canonicalApp(app), context.document.repositories);
      return repository && repositoryUpdateKey(repository) === key;
    })
    .map((app) => app.packageId);
}
async function openRepository(repository: RepositoryPolicy, context: ResolutionContext) {
  const { services, signal } = context;
  await services.tools.require('java');
  const session = await FdroidclSession.open(
    services.runner,
    await services.tools.require('fdroidcl'),
    repository,
    signal,
  );
  try {
    await session.update();
    const index = await services.repositories.indexFromJar(repository, session.indexPath, {
      signal,
      packageIds: repositoryPackages(context, repositoryUpdateKey(repository)),
    });
    return { session, index };
  } catch (error) {
    await session.close();
    throw error;
  }
}
async function sourceCandidate(
  id: string,
  declaration: ArtifactDeclaration,
  context: ResolutionContext,
): Promise<ArtifactPolicy> {
  const { services, device, signal } = context;
  const app = canonicalApp(declaration);
  const repository = artifactRepository(app, context.document.repositories);
  if (repository) {
    const key = repositoryUpdateKey(repository);
    let retained = context.sessions.get(key);
    if (!retained) {
      retained = await openRepository(repository, context);
      context.sessions.set(key, retained);
    }
    const candidate = resolveCandidate(app, retained.index, services, device);
    const path = await retained.session.download(candidate);
    await verifyCandidate(path, candidate, services, device, signal);
    return candidate;
  }
  return directCandidate(id, app, context);
}
async function directCandidate(
  id: string,
  app: ArtifactDeclaration,
  context: ResolutionContext,
): Promise<ArtifactPolicy> {
  const { services, device, signal } = context;
  const path = join(context.temporary, `${id}.apk`);
  const url = app.source?.kind === 'direct' ? app.source.url : app.url;
  if (url)
    await download(path, url, {
      hosts: app.source?.kind === 'direct' ? (app.source.redirectHosts ?? []) : (app.redirectHosts ?? []),
      limit: MAX_APK_BYTES,
      signal,
    });
  else if (app.path)
    await copySnapshot(await containedPath(context.base, app.path), path, MAX_APK_BYTES, signal);
  else throw new Error(`App ${id} has no resolvable source`);
  return inspectSource(path, app, services, device, signal);
}
function resolvedApp(appId: string, before: ArtifactDeclaration, candidate: ArtifactPolicy): AppResolution {
  const after: ArtifactPolicy = {
    ...canonicalApp(before),
    versionCode: before.versionCode ?? candidate.versionCode,
    sha256: before.sha256 ?? candidate.sha256,
    signerSha256: before.signerSha256 ?? candidate.signerSha256,
  };
  return {
    appId,
    before,
    after,
    discovered: pinKeys.filter((key) => before[key] === undefined),
    ...(before.signerSha256 === undefined ? { observedSignerSha256: candidate.signerSha256 } : {}),
  };
}

/** Resolve every declaration or fail without returning a partially usable policy. */
export async function planAppResolutions(
  document: PolicySourceDocument,
  base: string,
  services: AppUpdateServices,
  device: CandidateDevice,
  signal: AbortSignal,
): Promise<AppResolutionPlan> {
  const validated = validatePolicySourceDocument(document);
  const policy = { ...structuredClone(document), apps: {} as Record<string, ArtifactPolicy> };
  const resolutions: AppResolution[] = [];
  const unchanged: string[] = [];
  const context: ResolutionContext = {
    base,
    services,
    device,
    signal,
    document: validated,
    sessions: new Map(),
    temporary: await mkdtemp(join(tmpdir(), 'pxv-policy-resolve-')),
  };
  try {
    if (Object.keys(document.apps).length)
      await Promise.all([services.tools.require('aapt'), services.tools.require('apksigner')]);
    for (const [id, declaration] of Object.entries(validated.apps)) {
      signal.throwIfAborted();
      const candidate = await sourceCandidate(id, declaration, context);
      const resolution = resolvedApp(id, document.apps[id]!, candidate);
      policy.apps[id] = resolution.after;
      if (JSON.stringify(resolution.before) === JSON.stringify(resolution.after)) unchanged.push(id);
      else resolutions.push(resolution);
    }
    signal.throwIfAborted();
    validatePolicyDocument(policy);
    return { policy, resolutions, unchanged };
  } finally {
    try {
      await Promise.all([...context.sessions.values()].map(({ session }) => session.close()));
    } finally {
      await rm(context.temporary, { recursive: true, force: true });
    }
  }
}
