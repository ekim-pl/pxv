import { AndroidAdapter, HostTools } from '@pxv/adapters';
import { validatePolicyDocument, type ArtifactPolicy, type PolicyDocument } from '@pxv/contracts';
import { createProject, writePolicyLock } from '@pxv/engine';
import { CommandRunner, type CommandOptions, type CommandResult } from '@pxv/runtime';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/src/cli.js';
import { OFFICIAL_FDROID } from '../../packages/cli/src/artifact-repository.js';
import { device, hashA, hashB, product } from '../contracts/fixtures.js';
import { expect, vi } from '../test-api.js';

export const appId = 'org.example.app';
export const checksum = (value: string): string => createHash('sha256').update(value).digest('hex');
export const apkBytes = (id = appId, code = 1): string => JSON.stringify({ id, code });
interface UpdateRow {
  versionCode: number;
  apkName: string;
  hash: string;
  signer: string;
  minSdkVersion: number;
  maxSdkVersion?: number;
  nativecode: string[];
}
export const version = (code: number, id = appId): UpdateRow => ({
  versionCode: code,
  apkName: `${id}_${code}.apk`,
  hash: checksum(apkBytes(id, code)),
  signer: hashB,
  minSdkVersion: 28,
  nativecode: ['arm64-v8a'],
});
export const artifact = (id = appId): ArtifactPolicy => ({
  packageId: id,
  versionCode: 1,
  sha256: checksum(apkBytes(id)),
  signerSha256: hashB,
  source: { kind: 'fdroidcl' },
});
interface TestIndex {
  repo: { address: string; timestamp: number };
  apps: { packageName: string; suggestedVersionCode?: string | number }[];
  packages: Record<string, UpdateRow[]>;
}
function updateDocument(): PolicyDocument {
  return validatePolicyDocument({
    id: 'updater',
    name: 'Updater fixture',
    capabilities: [],
    repositories: [],
    apps: { messenger: artifact() },
    deviceSettings: [],
    profiles: [
      {
        id: 'owner',
        name: 'Owner',
        kind: 'owner',
        apps: ['messenger'],
        settings: [],
        permissions: [],
        vpn: { packageId: null, alwaysOn: false, lockdown: false },
      },
    ],
  });
}

export async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pxv-policy-updates-'));
  const resources = join(root, 'resources');
  const path = join(root, 'standalone.json');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  const document = updateDocument();
  const index: TestIndex = {
    repo: { address: OFFICIAL_FDROID.url, timestamp: Date.now() },
    apps: [{ packageName: appId, suggestedVersionCode: '2' }],
    packages: { [appId]: [version(1), version(2)] },
  };
  const indexes = new Map([[OFFICIAL_FDROID.url, index]]);
  const sessions = new Set<string>();
  const state = {
    fail: '',
    actualSdk: 28,
    actualAbi: 'arm64-v8a',
    actualId: '',
    actualCode: 0,
    actualSigner: hashB,
    beforeDownload: async () => {},
    timeout: false,
  };
  const io = {
    out: vi.fn((text: string) => {
      void text;
    }),
    error: vi.fn((text: string) => {
      void text;
    }),
    confirm: vi.fn(() => Promise.resolve(true)),
  };
  const savedControl = process.env['PXV_CONTROL_ROOT'];
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  const discover = vi
    .spyOn(HostTools.prototype, 'discover')
    .mockImplementation((name) => Promise.resolve(`/tools/${name}`));
  const requireTool = vi
    .spyOn(HostTools.prototype, 'require')
    .mockImplementation((name) => Promise.resolve(`/tools/${name}`));
  const guard = vi.spyOn(AndroidAdapter.prototype, 'guardTarget').mockResolvedValue();
  const shell = vi
    .spyOn(AndroidAdapter.prototype, 'shell')
    .mockImplementation((_target, args) =>
      Promise.resolve(args[1] === 'ro.build.version.sdk' ? '36\n' : 'arm64-v8a,armeabi-v7a\n'),
    );

  async function fdroid(args: string[], options: CommandOptions): Promise<CommandResult> {
    const sessionRoot = options.cwd!;
    sessions.add(sessionRoot);
    expect(options.env?.['PATH']).toBe(join(sessionRoot, 'no-adb'));
    expect(options.signal).toBeDefined();
    const config = await readFile(join(sessionRoot, 'config/fdroidcl/config.toml'), 'utf8');
    const url = JSON.parse(/^url = (.+)$/m.exec(config)![1]!) as string;
    const selected = indexes.get(url)!;
    if (state.timeout) throw new Error('Command timed out');
    if (args[1] === 'update') {
      if (state.fail === 'update') return { code: 1, stdout: '', stderr: '404 index-v1.jar' };
      await writeFile(join(sessionRoot, 'config/fdroidcl/f-droid.jar'), JSON.stringify(selected));
      return { code: 0, stdout: '', stderr: '' };
    }
    await state.beforeDownload();
    const [id, code] = args[2]!.split(':');
    const apk = join(sessionRoot, 'cache/fdroidcl/apks', `${id}_${code}.apk`);
    await mkdir(join(sessionRoot, 'cache/fdroidcl/apks'), { recursive: true });
    await writeFile(apk, apkBytes(id, Number(code)));
    return { code: 0, stdout: `APK available in ${apk}\n`, stderr: '' };
  }
  const run = vi.spyOn(CommandRunner.prototype, 'run').mockImplementation(async (args, options = {}) => {
    options.signal?.throwIfAborted();
    if (args[0] === '/tools/fdroidcl') return fdroid(args, options);
    if (args[0] === '/tools/java') {
      if (state.fail === 'signature') return { code: 2, stdout: '', stderr: 'bad signature' };
      expect(args[5]).toBe('index-v1.json');
      await writeFile(args[6]!, await readFile(args[3]!));
      return { code: 0, stdout: '', stderr: '' };
    }
    const bytes = JSON.parse(await readFile(args.at(-1)!, 'utf8')) as { id: string; code: number };
    if (args[0] === '/tools/aapt')
      return {
        code: 0,
        stderr: '',
        stdout:
          `package: name='${state.actualId || bytes.id}' versionCode='${state.actualCode || bytes.code}'\n` +
          `sdkVersion:'${state.actualSdk}'\nnative-code: '${state.actualAbi}'\n`,
      };
    if (args[0] === '/tools/apksigner')
      return {
        code: state.fail === 'apk-signature' ? 2 : 0,
        stderr: '',
        stdout: `Signer #1 certificate SHA-256 digest: ${state.actualSigner}\n`,
      };
    throw new Error(`Unexpected command ${JSON.stringify(args)}`);
  });
  await writeFile(path, JSON.stringify(document));
  const args = (extra: string[]) => [
    'policy',
    'update-apps',
    '--json',
    '--resource-root',
    resources,
    ...extra,
  ];
  return {
    root,
    resources,
    path,
    document,
    index,
    indexes,
    sessions,
    state,
    io,
    run,
    guard,
    shell,
    discover,
    requireTool,
    async save() {
      await writeFile(path, JSON.stringify(document));
    },
    async standalone(extra: string[] = ['--dry-run']) {
      return runCli(args(['--policy', path, '--sdk', '36', '--abi', 'arm64-v8a', ...extra]), io);
    },
    async project() {
      const project = await createProject(join(root, 'project'), product, document, resources);
      await writeFile(
        join(project.root, 'inventory.json'),
        JSON.stringify({ schemaVersion: 1, devices: [device] }),
      );
      const { loadProject } = await import('@pxv/engine');
      const loaded = await loadProject(project.root, product, resources);
      await writePolicyLock(loaded);
      return {
        context: loaded,
        path: join(project.root, 'policy.json'),
        run: (extra: string[] = ['--dry-run']) =>
          runCli(args(['--project-root', project.root, '--asset', device.assetId, ...extra]), io),
      };
    },
    output() {
      return JSON.parse(io.out.mock.calls.at(-1)![0]) as {
        written: boolean;
        dryRun: boolean;
        policyLockRequired: boolean;
        updates: { appId: string; before: ArtifactPolicy; after: ArtifactPolicy }[];
        unchanged: string[];
        skipped: { appId: string; reason: string }[];
      };
    },
    async close() {
      vi.restoreAllMocks();
      if (savedControl === undefined) delete process.env['PXV_CONTROL_ROOT'];
      else process.env['PXV_CONTROL_ROOT'] = savedControl;
      for (const session of sessions) await expect(access(session)).rejects.toThrow();
      await rm(root, { recursive: true, force: true });
    },
    customRepository() {
      return {
        id: 'custom',
        url: 'https://custom.example/repo',
        signerSha256: hashA,
        maxAgeDays: 30,
        redirectHosts: [],
      };
    },
  };
}
