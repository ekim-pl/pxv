import { FdroidclSession, type RepositoryEvidence } from '@pxv/adapters';
import { digest, type ArtifactPolicy, type RepositoryPolicy, type SelectedTarget } from '@pxv/contracts';
import { containedPath, type ArtifactPort } from '@pxv/engine';
import type { ApplicationDependencies } from './dependencies.js';
import { artifactRepository } from './artifact-repository.js';

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
      const repository = artifactRepository(artifact, project.policy.repositories);
      if (artifact.repositoryId && !repository) throw new Error('Unknown authenticated repository');
      if (repository) {
        const selected = await repositorySource(deps, artifact, repository, target, signal);
        evidence = selected.evidence;
        if (artifact.source?.kind === 'fdroidcl') {
          const session = await FdroidclSession.open(
            deps.runner,
            await tools.require('fdroidcl'),
            repository,
            signal,
          );
          try {
            await session.update();
            acquisition = { ...artifactPins(artifact), path: await session.download(artifact) };
            const verified = await artifacts.snapshot(acquisition, destination, signal);
            await store.set('artifact-provenance', digest(destination), { repository, evidence });
            return { ...verified, path: verified.path };
          } finally {
            await session.close();
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
