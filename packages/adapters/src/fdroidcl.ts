import type { ArtifactPolicy, RepositoryPolicy } from '@pxv/contracts';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AdapterError, checked, packageId, type CommandRunner, type CommandOptions } from './command.js';

/** One repository per session prevents fdroidcl's repository merging from changing APK selection. */
export class FdroidclSession {
  private constructor(
    readonly root: string,
    readonly indexPath: string,
    private readonly executable: string,
    private readonly runner: CommandRunner,
    private readonly options: CommandOptions,
  ) {}

  static async open(
    runner: CommandRunner,
    executable: string,
    repository: RepositoryPolicy,
    signal?: AbortSignal,
  ): Promise<FdroidclSession> {
    signal?.throwIfAborted();
    if (!isAbsolute(executable)) throw new AdapterError('fdroidcl requires a resolved absolute executable');
    const root = await mkdtemp(join(tmpdir(), 'pxv-fdroidcl-'));
    try {
      const config = join(root, 'config', 'fdroidcl');
      const cache = join(root, 'cache');
      const noAdb = join(root, 'no-adb');
      await Promise.all([config, cache, noAdb].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
      await writeFile(
        join(config, 'config.toml'),
        `[[repos]]\nid = "f-droid"\nurl = ${JSON.stringify(repository.url.replace(/\/$/, ''))}\nenabled = true\n`,
        { flag: 'wx', mode: 0o600 },
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      // fdroidcl download tries to start/discover adb. Its absolute executable needs no PATH entries.
      Object.assign(env, {
        PATH: noAdb,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_CACHE_HOME: cache,
        XDG_DATA_HOME: join(root, 'data'),
      });
      return new FdroidclSession(root, join(config, 'f-droid.jar'), executable, runner, {
        cwd: root,
        env,
        timeoutMs: 600_000,
        check: false,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async update(): Promise<void> {
    checked(
      await this.runner.run([this.executable, 'update'], this.options),
      'fdroidcl index update (the repository must expose index-v1.jar)',
    );
  }

  async download(artifact: Pick<ArtifactPolicy, 'packageId' | 'versionCode'>): Promise<string> {
    packageId(artifact.packageId);
    if (!Number.isSafeInteger(artifact.versionCode) || artifact.versionCode < 1)
      throw new AdapterError('fdroidcl requires an exact positive version code');
    const output = checked(
      await this.runner.run(
        [this.executable, 'download', `${artifact.packageId}:${artifact.versionCode}`],
        this.options,
      ),
      'fdroidcl APK download',
    );
    const matches = [...output.matchAll(/^APK available in (.+)\r?$/gm)];
    if (matches.length !== 1 || !matches[0]?.[1])
      throw new AdapterError('fdroidcl did not identify one downloaded APK');
    const apk = await realpath(resolve(this.root, matches[0][1].trim()));
    const cacheRelative = relative(join(this.root, 'cache'), apk);
    if (
      !cacheRelative ||
      cacheRelative === '..' ||
      cacheRelative.startsWith(`..${sep}`) ||
      isAbsolute(cacheRelative)
    )
      throw new AdapterError('fdroidcl returned an APK outside its isolated cache');
    return apk;
  }

  async close(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
