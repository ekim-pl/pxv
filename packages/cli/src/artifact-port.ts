import type { RepositoryEvidence } from '@pxv/adapters';
import { digest, type ArtifactPolicy, type SelectedTarget } from '@pxv/contracts';
import { containedPath, type ArtifactPort } from '@pxv/engine';
import type { ApplicationDependencies } from './dependencies.js';
async function repositorySource(
  deps: ApplicationDependencies,
  artifact: ArtifactPolicy,
  target: SelectedTarget | undefined,
  signal?: AbortSignal,
): Promise<{ source: ArtifactPolicy; evidence: RepositoryEvidence }> {
  const { tools, project, repositories, android } = deps;
  await tools.require('java');
  const repository = project.policy.repositories.find((value) => value.id === artifact.repositoryId);
  if (!repository) throw new Error('Unknown authenticated repository');
  if (!target) throw new Error('Repository selection requires measured target SDK and ABIs');
  const index = await repositories.index(repository, signal ? { signal } : {});
  const sdk = Number(
    (await android.shell(target, ['getprop', 'ro.build.version.sdk'], signal ? { signal } : {})).trim(),
  );
  const abis = (await android.shell(target, ['getprop', 'ro.product.cpu.abilist'], signal ? { signal } : {}))
    .trim()
    .split(',')
    .filter(Boolean);
  const approved = repositories.candidate(index, artifact.packageId, {
    sdk,
    abis,
    versionCode: artifact.versionCode,
  });
  if (approved.sha256 !== artifact.sha256 || approved.signerSha256 !== artifact.signerSha256)
    throw new Error('Reviewed APK differs from the authenticated repository candidate');
  return { source: approved, evidence: index.evidence };
}

export function createArtifactPort(deps: ApplicationDependencies): ArtifactPort {
  const { tools, project, artifacts, images, store, repositories } = deps;
  return {
    async snapshot(artifact, destination, signal, target) {
      await Promise.all([tools.require('aapt'), tools.require('apksigner')]);
      let source = artifact;
      let evidence: RepositoryEvidence | undefined;
      if (artifact.path) source = { ...artifact, path: await containedPath(project.root, artifact.path) };
      if (artifact.repositoryId) {
        const selected = await repositorySource(deps, artifact, target, signal);
        source = selected.source;
        evidence = selected.evidence;
      }
      const verified = await artifacts.snapshot(source, destination, signal);
      if (evidence) await store.set('artifact-provenance', digest(destination), evidence);
      return {
        ...verified,
        path: verified.path,
        ...(source.repositoryId ? { repositoryId: source.repositoryId } : {}),
      };
    },
    async snapshotOs(policy, directory, signal) {
      if (process.env['PXV_DOCKER_MODE'] === 'host-adb') throw new Error('Fastboot requires direct USB mode');
      await tools.require('ssh-keygen');
      return images.snapshot(policy, directory, signal);
    },
    async validateBeforeExecution(artifact) {
      if (!artifact.repositoryId) return;
      const repository = project.policy.repositories.find((value) => value.id === artifact.repositoryId);
      const evidence = artifact.path
        ? await store.get<RepositoryEvidence>('artifact-provenance', digest(artifact.path))
        : undefined;
      if (!repository || !evidence) throw new Error('Reviewed repository evidence is missing');
      await repositories.validateEvidence(repository, evidence);
    },
  };
}
