import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AndroidAdapter, ArtifactService, HostTools, ImageService, RepositoryService } from '@pxv/adapters';
import type { ArtifactPolicy, RepositoryPolicy } from '@pxv/contracts';
import { createProject } from '@pxv/engine';
import { CommandRunner, SqliteStore } from '@pxv/runtime';
import type { ApplicationDependencies } from '../../packages/cli/src/dependencies.js';
import { createArtifactPort } from '../../packages/cli/src/artifact-port.js';
import { hashA, hashB, policy, policyDocument, product } from '../contracts/fixtures.js';
import { expect, vi } from '../test-api.js';

export const reviewed: ArtifactPolicy = {
  packageId: 'org.example.app',
  versionCode: 42,
  sha256: hashA,
  signerSha256: hashB,
  source: { kind: 'fdroidcl' },
};
export const repository: RepositoryPolicy = {
  id: 'reviewed',
  url: 'https://example.test/repo',
  signerSha256: hashB,
  maxAgeDays: 7,
  redirectHosts: ['cdn.example.test'],
};
export const evidence = {
  url: repository.url,
  signerSha256: hashB,
  timestamp: 123,
  entrySha256: hashA,
  indexSha256: hashB,
  format: 'v2' as const,
  maxAgeDays: 7,
};
export type AcquisitionFailure =
  | 'update'
  | 'download'
  | 'missing-location'
  | 'ambiguous-location'
  | 'missing-file'
  | 'outside'
  | 'cache-itself'
  | 'symlink-escape'
  | 'verify'
  | 'store';

async function dependencies() {
  const root = await mkdtemp(join(tmpdir(), 'pxv-artifact-port-test-'));
  await writeFile(join(root, 'product.json'), JSON.stringify(product));
  const created = await createProject(join(root, 'project'), product, policyDocument, root);
  const project = { ...created, policy: { ...structuredClone(policy), repositories: [repository] } };
  const store = await SqliteStore.open(join(root, 'store.sqlite3'));
  const runner = new CommandRunner();
  const deps: ApplicationDependencies = {
    project,
    store,
    runner,
    tools: new HostTools({ runner }),
    android: new AndroidAdapter({ runner }),
    artifacts: new ArtifactService({ runner }),
    images: new ImageService({ runner }),
    repositories: new RepositoryService({
      runner,
      verifierPath: '/unused',
      freshness: {
        read: () => Promise.resolve(undefined),
        advance: () => Promise.resolve(),
      },
    }),
  };
  return { root, deps };
}

interface AcquisitionState {
  failure: AcquisitionFailure | undefined;
  acquisitionRoot: string;
  order: string[];
}

export async function artifactFixture() {
  const { root, deps } = await dependencies();
  const state = {
    failure: undefined as AcquisitionFailure | undefined,
    acquisitionRoot: '',
    order: [] as string[],
  };
  const repo = repositoryMocks(deps, state);
  const verification = verificationMocks(deps, state);
  const run = downloadRunner(deps, state, root);
  return {
    root,
    deps,
    state,
    ...repo,
    ...verification,
    run,
    port: createArtifactPort(deps),
    destination: join(root, 'reviewed.apk'),
    async close() {
      await deps.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function repositoryMocks(deps: ApplicationDependencies, state: AcquisitionState) {
  const requireTool = vi
    .spyOn(deps.tools, 'require')
    .mockImplementation((name) => Promise.resolve(`/tools/${name}`));
  const index = vi.spyOn(deps.repositories, 'index').mockImplementation(() => {
    state.order.push('index');
    return Promise.resolve({ evidence, packages: {} });
  });
  const candidate = vi.spyOn(deps.repositories, 'candidate').mockImplementation(() => {
    state.order.push('candidate');
    return { ...reviewed, url: 'https://example.test/repo/app.apk', redirectHosts: ['cdn.example.test'] };
  });
  const shell = vi
    .spyOn(deps.android, 'shell')
    .mockImplementation((_target, args) =>
      Promise.resolve(args[1] === 'ro.build.version.sdk' ? '35\n' : 'arm64-v8a,armeabi-v7a\n'),
    );
  const validate = vi.spyOn(deps.repositories, 'validateEvidence').mockResolvedValue();
  return { requireTool, index, candidate, shell, validate };
}

function verificationMocks(deps: ApplicationDependencies, state: AcquisitionState) {
  const snapshot = vi.spyOn(deps.artifacts, 'snapshot').mockImplementation(async (artifact, destination) => {
    state.order.push('verify');
    if (artifact.path && state.acquisitionRoot)
      expect(await readFile(artifact.path, 'utf8')).toBe('synthetic APK');
    if (state.failure === 'verify') throw new Error('verification failed');
    return {
      packageId: artifact.packageId,
      versionCode: artifact.versionCode,
      sha256: artifact.sha256,
      signerSha256: artifact.signerSha256,
      path: destination,
    };
  });
  const set = vi.spyOn(deps.store, 'set').mockImplementation(() => {
    state.order.push('store');
    if (state.failure === 'store') return Promise.reject(new Error('store failed'));
    return Promise.resolve();
  });
  return { snapshot, set };
}

function downloadRunner(deps: ApplicationDependencies, state: AcquisitionState, root: string) {
  const run = vi.spyOn(deps.runner, 'run').mockImplementation(async (args, options) => {
    const command = args[1]!;
    state.order.push(command);
    state.acquisitionRoot = options!.cwd!;
    const stdout = command === 'download' ? await downloadOutput() : '';
    return { stdout, stderr: '', code: state.failure === command ? 1 : 0 };
  });
  async function downloadOutput() {
    const cache = join(state.acquisitionRoot, 'cache');
    await mkdir(join(cache, 'fdroidcl'), { recursive: true });
    const outside = join(root, 'outside.apk');
    await writeFile(outside, 'synthetic APK');
    const apk = join(cache, 'fdroidcl', 'app.apk');
    if (state.failure === 'symlink-escape') await symlink(outside, apk);
    else if (state.failure !== 'missing-file') await writeFile(apk, 'synthetic APK');
    if (state.failure === 'missing-location') return 'Download complete\n';
    if (state.failure === 'ambiguous-location') return `APK available in ${apk}\nAPK available in ${apk}\n`;
    const location = state.failure === 'outside' ? outside : state.failure === 'cache-itself' ? cache : apk;
    return `Downloading org.example.app\nAPK available in ${location}\n`;
  }
  return run;
}
