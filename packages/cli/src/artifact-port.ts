import { checked, type RepositoryEvidence } from '@pxv/adapters';
import { digest, type ArtifactPolicy, type RepositoryPolicy, type SelectedTarget } from '@pxv/contracts';
import { containedPath, type ArtifactPort } from '@pxv/engine';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ApplicationDependencies } from './dependencies.js';

const OFFICIAL_FDROID: RepositoryPolicy = {
  id: 'fdroid-official',
  url: 'https://f-droid.org/repo',
  signerSha256: '43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab',
  maxAgeDays: 30,
  redirectHosts: [],
};

interface StoredArtifactProvenance {
  repository: RepositoryPolicy;
  evidence: RepositoryEvidence;
}

function artifactPins(
  artifact: ArtifactPolicy,
): Pick<ArtifactPolicy, 'packageId' | 'versionCode' | 'sha256' | 'signerSha256'> {
  return {
    packageId: artifact.packageId,
    versionCode: artifact.versionCode,
    sha256: artifact.sha256,
    signerSha256: artifact.signerSha256,
  };
}

function repositoryForArtifact(
  deps: ApplicationDependencies,
  artifact: ArtifactPolicy,
): RepositoryPolicy | undefined {
  const source = artifact.source;
  if (source?.kind === 'fdroidcl') return OFFICIAL_FDROID;
  if (source?.kind === 'fdroid-repository')
    return {
      id: `inline-${digest({ url: source.url, fingerprint: source.fingerprint }).slice(0, 32)}`,
      url: source.url,
      signerSha256: source.fingerprint,
      maxAgeDays: source.maxAgeDays ?? 30,
      redirectHosts: source.redirectHosts ?? [],
    };
  return artifact.repositoryId
    ? deps.project.policy.repositories.find((value) => value.id === artifact.repositoryId)
    : undefined;
}

async function repositorySource(
  deps: ApplicationDependencies,
  artifact: ArtifactPolicy,
  repository: RepositoryPolicy,
  target: SelectedTarget | undefined,
  signal?: AbortSignal,
): Promise<{ candidate: ArtifactPolicy; apkUrl: string; evidence: RepositoryEvidence }> {
  const { tools, repositories, android } = deps;
  await tools.require('java');
  if (!target) throw new Error('Repository selection requires measured target SDK and ABIs');
  const index = await repositories.index(repository, signal ? { signal } : {});
  const sdk = Number(
    (await android.shell(target, ['getprop', 'ro.build.version.sdk'], signal ? { signal } : {})).trim(),
  );
  const abis = (await android.shell(target, ['getprop', 'ro.product.cpu.abilist'], signal ? { signal } : {}))
    .trim()
    .split(',')
    .filter(Boolean);
  const candidate = repositories.candidate(index, artifact.packageId, {
    sdk,
    abis,
    versionCode: artifact.versionCode,
  });
  if (!candidate.url) throw new Error('Authenticated repository candidate has no APK URL');
  if (candidate.sha256 !== artifact.sha256 || candidate.signerSha256 !== artifact.signerSha256)
    throw new Error('Reviewed APK differs from the authenticated repository candidate');
  return { candidate, apkUrl: candidate.url, evidence: index.evidence };
}

async function acquireWithFdroidcl(
  deps: ApplicationDependencies,
  artifact: ArtifactPolicy,
  signal?: AbortSignal,
): Promise<{ root: string; apk: string }> {
  const executable = await deps.tools.require('fdroidcl');
  const root = await mkdtemp(join(tmpdir(), 'pxv-fdroidcl-'));
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  try {
    await Promise.all([
      mkdir(cache, { recursive: true, mode: 0o700 }),
      mkdir(join(config, 'fdroidcl'), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(config, 'fdroidcl', 'config.toml'),
      '[[repos]]\nid = "f-droid"\nurl = "https://f-droid.org/repo"\nenabled = true\n',
      { flag: 'wx', mode: 0o600 },
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    env['XDG_CACHE_HOME'] = cache;
    env['XDG_CONFIG_HOME'] = config;
    const options = {
      cwd: root,
      env,
      timeoutMs: 600_000,
      ...(signal ? { signal } : {}),
    };
    checked(await deps.runner.run([executable, 'update'], options), 'fdroidcl official index update');
    const appVersion = `${artifact.packageId}:${artifact.versionCode}`;
    const output = checked(
      await deps.runner.run([executable, 'download', appVersion], options),
      'fdroidcl APK download',
    );
    const matches = [...output.matchAll(/^APK available in (.+)$/gm)];
    if (matches.length !== 1 || !matches[0]?.[1])
      throw new Error('fdroidcl did not identify one downloaded APK');
    const apk = await realpath(resolve(root, matches[0][1].trim()));
    const cacheRelative = relative(resolve(cache), apk);
    if (
      !cacheRelative ||
      cacheRelative === '..' ||
      cacheRelative.startsWith(`..${sep}`) ||
      isAbsolute(cacheRelative)
    )
      throw new Error('fdroidcl returned an APK outside its isolated cache');
    return { root, apk };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function directAcquisition(root: string, artifact: ArtifactPolicy): Promise<ArtifactPolicy> {
  if (artifact.path) return { ...artifactPins(artifact), path: await containedPath(root, artifact.path) };
  if (artifact.source?.kind === 'direct')
    return {
      ...artifactPins(artifact),
      url: artifact.source.url,
      ...(artifact.source.redirectHosts ? { redirectHosts: artifact.source.redirectHosts } : {}),
    };
  return artifact;
}

function storedProvenance(retained: unknown): Partial<StoredArtifactProvenance> {
  if (!retained) return {};
  if (typeof retained === 'object' && 'repository' in retained && 'evidence' in retained)
    return retained as StoredArtifactProvenance;
  return { evidence: retained as RepositoryEvidence };
}

export function createArtifactPort(deps: ApplicationDependencies): ArtifactPort {
  const { tools, project, artifacts, images, store, repositories } = deps;
  return {
    async snapshot(artifact, destination, signal, target) {
      await Promise.all([tools.require('aapt'), tools.require('apksigner')]);
      let acquisition: ArtifactPolicy = artifact;
      let evidence: RepositoryEvidence | undefined;
      const repository = repositoryForArtifact(deps, artifact);
      if (artifact.repositoryId && !repository) throw new Error('Unknown authenticated repository');
      if (repository) {
        const selected = await repositorySource(deps, artifact, repository, target, signal);
        evidence = selected.evidence;
        if (artifact.source?.kind === 'fdroidcl') {
          const downloaded = await acquireWithFdroidcl(deps, artifact, signal);
          try {
            acquisition = { ...artifactPins(artifact), path: downloaded.apk };
            const verified = await artifacts.snapshot(acquisition, destination, signal);
            await store.set('artifact-provenance', digest(destination), { repository, evidence });
            return { ...verified, path: verified.path };
          } finally {
            await rm(downloaded.root, { recursive: true, force: true });
          }
        }
        acquisition = {
          ...artifactPins(artifact),
          url: selected.apkUrl,
          ...(selected.candidate.redirectHosts ? { redirectHosts: selected.candidate.redirectHosts } : {}),
        };
      } else acquisition = await directAcquisition(project.root, artifact);
      const verified = await artifacts.snapshot(acquisition, destination, signal);
      if (evidence && repository)
        await store.set('artifact-provenance', digest(destination), { repository, evidence });
      return { ...verified, path: verified.path };
    },
    async snapshotOs(policy, directory, signal) {
      if (process.env['PXV_DOCKER_MODE'] === 'host-adb') throw new Error('Fastboot requires direct USB mode');
      await tools.require('ssh-keygen');
      return images.snapshot(policy, directory, signal);
    },
    async validateBeforeExecution(artifact) {
      const retained = artifact.path
        ? await store.get<unknown>('artifact-provenance', digest(artifact.path))
        : undefined;
      if (!retained && !artifact.repositoryId) return;
      const stored = storedProvenance(retained);
      let repository = stored.repository;
      const evidence = stored.evidence;
      if (artifact.repositoryId) {
        const policyRepository = project.policy.repositories.find(
          (value) => value.id === artifact.repositoryId,
        );
        if (!policyRepository) throw new Error('Reviewed repository is missing from policy');
        if (repository && digest(repository) !== digest(policyRepository))
          throw new Error('Reviewed repository configuration changed');
        repository = policyRepository;
      }
      if (!repository || !evidence) throw new Error('Reviewed repository evidence is missing');
      await repositories.validateEvidence(repository, evidence);
    },
  };
}
