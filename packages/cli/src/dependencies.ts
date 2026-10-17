import { AndroidAdapter, ArtifactService, HostTools, ImageService, RepositoryService } from '@pxv/adapters';
import { containedPath, type ProjectContext } from '@pxv/engine';
import { CommandRunner, type SqliteStore } from '@pxv/runtime';
import { join } from 'node:path';
export interface ApplicationDependencies {
  project: ProjectContext;
  store: SqliteStore;
  runner: CommandRunner;
  tools: HostTools;
  artifacts: ArtifactService;
  images: ImageService;
  android: AndroidAdapter;
  repositories: RepositoryService;
}
export async function createDependencies(
  project: ProjectContext,
  resources: string,
  store: SqliteStore,
): Promise<ApplicationDependencies> {
  const runner = new CommandRunner();
  const tools = new HostTools({ runner });
  const pathFor = async (name: Parameters<HostTools['discover']>[0]): Promise<string> =>
    (await tools.discover(name)) ?? name;
  const cacheRoot = await containedPath(project.root, 'state/artifacts', false);
  const artifacts = new ArtifactService({
    runner,
    aapt: await pathFor('aapt'),
    apksigner: await pathFor('apksigner'),
    cacheRoot,
  });
  const images = new ImageService({ runner, sshKeygen: await pathFor('ssh-keygen'), cacheRoot });
  const android = new AndroidAdapter({
    runner,
    artifacts,
    adb: await pathFor('adb'),
    fastboot: await pathFor('fastboot'),
  });
  const repositories = new RepositoryService({
    runner,
    java: await pathFor('java'),
    verifierPath: join(resources, 'resources/VerifyRepositoryIndex.java'),
    freshness: {
      read: (key) => store.get('repository-freshness', key),
      async advance(key, previous, next) {
        if (!(await store.compareAndSet('repository-freshness', key, previous, next)))
          throw new Error('Concurrent repository observation; prepare again');
      },
    },
  });

  return { project, store, runner, tools, artifacts, images, android, repositories };
}
