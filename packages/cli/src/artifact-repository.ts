import { digest, type ArtifactPolicy, type RepositoryPolicy } from '@pxv/contracts';

export const OFFICIAL_FDROID: RepositoryPolicy = {
  id: 'fdroid-official',
  url: 'https://f-droid.org/repo',
  signerSha256: '43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab',
  maxAgeDays: 30,
  redirectHosts: [],
};

export function repositoryUpdateKey(repository: RepositoryPolicy): string {
  return digest({
    url: repository.url.replace(/\/$/, ''),
    signerSha256: repository.signerSha256.toLowerCase(),
    maxAgeDays: repository.maxAgeDays,
    redirectHosts: [...repository.redirectHosts].sort(),
  });
}

export function artifactRepository(
  artifact: Pick<ArtifactPolicy, 'source' | 'repositoryId'>,
  repositories: readonly RepositoryPolicy[],
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
  if (!artifact.repositoryId) return undefined;
  const repository = repositories.find((value) => value.id === artifact.repositoryId);
  if (!repository) throw new Error('Unknown authenticated repository');
  return repository;
}

export function repositoryForUpdate(
  artifact: ArtifactPolicy,
  repositories: readonly RepositoryPolicy[],
): RepositoryPolicy | undefined {
  if (artifact.path) return undefined;
  const explicit = artifactRepository(artifact, repositories);
  if (explicit) return explicit;
  const url = artifact.source?.kind === 'direct' ? artifact.source.url : artifact.url;
  if (!url) return undefined;
  const apk = new URL(url);
  const matches = repositories.filter((repository) => {
    const root = new URL(repository.url);
    return apk.origin === root.origin && apk.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`);
  });
  const identities = new Set(matches.map(repositoryUpdateKey));
  if (identities.size > 1) throw new Error('APK URL matches ambiguous trusted repositories');
  return matches[0];
}
