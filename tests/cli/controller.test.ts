import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectContext } from '@pxv/engine';
import type * as EngineModule from '@pxv/engine';
import type * as RuntimeModule from '@pxv/runtime';
import type * as AdapterModule from '@pxv/adapters';
import type { ExtensionLock } from '@pxv/contracts';
import { device, policy, product, project as config } from '../contracts/fixtures.js';
const mocks = vi.hoisted(() => ({
  resourceRoot: vi.fn(),
  productAt: vi.fn(),
  application: vi.fn(),
  loadProject: vi.fn(),
  recordLifecycle: vi.fn(),
  runCommand: vi.fn(),
  inspectHost: vi.fn(),
  bootstrapTool: vi.fn(),
  startLocalAdbServer: vi.fn(),
  toolRequire: vi.fn(),
  toolDiscover: vi.fn(),
  guardTarget: vi.fn(),
  runInDocker: vi.fn(),
  prepareDockerEnvironment: vi.fn(),
  startDockerAdb: vi.fn(),
  stopDockerAdb: vi.fn(),
  managerConstruct: vi.fn(),
  extensionList: vi.fn(),
  extensionInstall: vi.fn(),
  extensionUpdate: vi.fn(),
  extensionInspect: vi.fn(),
  extensionInvoke: vi.fn(),
  readContribution: vi.fn(),
  invokeAdapter: vi.fn(),
  executePlan: vi.fn(),
  serveStdio: vi.fn(),
  serverClose: vi.fn(),
  reservations: vi.fn(),
}));
vi.mock('../../packages/cli/src/context.js', () => ({
  resourceRoot: mocks.resourceRoot,
  productAt: mocks.productAt,
  application: mocks.application,
}));
vi.mock('../../packages/cli/src/host.js', () => ({
  inspectHost: mocks.inspectHost,
  bootstrapTool: mocks.bootstrapTool,
}));
vi.mock('../../packages/cli/src/docker.js', () => ({
  runInDocker: mocks.runInDocker,
  prepareDockerEnvironment: mocks.prepareDockerEnvironment,
  startDockerAdb: mocks.startDockerAdb,
  stopDockerAdb: mocks.stopDockerAdb,
}));
vi.mock('../../packages/cli/src/backend.js', () => ({
  agentBackend: () => ({ executePlan: mocks.executePlan }),
  liveAgentBackend: () => ({ executePlan: mocks.executePlan }),
}));
vi.mock('@pxv/engine', async (original) => ({
  ...(await original<typeof EngineModule>()),
  loadProject: mocks.loadProject,
  recordLifecycle: mocks.recordLifecycle,
}));
vi.mock('@pxv/runtime', async (original) => ({
  ...(await original<typeof RuntimeModule>()),
  CommandRunner: class {
    run = mocks.runCommand;
  },
  recoveryReservations: mocks.reservations,
  commitProjectFile: async (input: RuntimeModule.ProjectFileCommit) =>
    (await original<typeof RuntimeModule>()).atomicWritePrivate(input.path, input.data),
}));
vi.mock('@pxv/adapters', async (original) => ({
  ...(await original<typeof AdapterModule>()),
  startLocalAdbServer: mocks.startLocalAdbServer,
  HostTools: class {
    require = mocks.toolRequire;
    discover = mocks.toolDiscover;
  },
  AndroidAdapter: class {
    guardTarget = mocks.guardTarget;
  },
}));
vi.mock('@pxv/extensions', () => ({
  ExtensionManager: class {
    constructor(options: unknown) {
      mocks.managerConstruct(options);
    }
    list = mocks.extensionList;
    install = mocks.extensionInstall;
    update = mocks.extensionUpdate;
    inspect = mocks.extensionInspect;
    invoke = mocks.extensionInvoke;
    readContribution = mocks.readContribution;
    invokeAdapter = mocks.invokeAdapter;
  },
}));
vi.mock('@pxv/mcp', () => ({ serveStdio: mocks.serveStdio }));
import { runCli, type CliIo } from '../../packages/cli/src/cli.js';
let root: string;
let resources: string;
let projectRoot: string;
let project: ProjectContext;
let output: string[];
let io: CliIo;
let saved: NodeJS.ProcessEnv;
const lock: ExtensionLock = {
  id: '@vendor/private',
  version: '1.0.0',
  apiVersion: 1,
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  entry: 'index.mjs',
  installPath: 'private/1.0.0',
};
const store = {
  close: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  entries: vi.fn(),
  events: vi.fn(),
};
const engine = {
  observe: vi.fn(),
  prepare: vi.fn(),
  prepareExtension: vi.fn(),
  submit: vi.fn(),
  execute: vi.fn(),
  executeFleet: vi.fn(),
  cancel: vi.fn(),
  readiness: vi.fn(),
  acceptCustody: vi.fn(),
  acceptedHandoff: vi.fn(),
  refreshReview: vi.fn(),
  attest: vi.fn(),
  finalize: vi.fn(),
  recover: vi.fn(),
};
const prepared = {
  plan: { id: 'reviewed-plan' },
  reviewSummary: 'exact-summary',
  expiresAt: '2026-10-17T00:00:00Z',
};
beforeEach(async () => {
  for (const mock of [...Object.values(mocks), ...Object.values(store), ...Object.values(engine)])
    mock.mockReset();
  saved = { ...process.env };
  delete process.env['PXV_DOCKER_MODE'];
  root = await mkdtemp(join(tmpdir(), 'pxv-controller-'));
  resources = join(root, 'resources');
  projectRoot = join(root, 'project');
  await mkdir(resources);
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, config.policyFile), JSON.stringify(policy));
  project = {
    root: projectRoot,
    revisions: { config: 'a'.repeat(64), policy: 'b'.repeat(64), inventory: 'c'.repeat(64) },
    config: structuredClone(config),
    product,
    policy,
    inventory: { schemaVersion: 1, devices: [device] },
    resolved: { digest: 'a'.repeat(64) },
  } as unknown as ProjectContext;
  await writeFile(join(projectRoot, config.inventoryFile), JSON.stringify(project.inventory));
  await writeFile(join(projectRoot, 'pxv.project.json'), JSON.stringify(project.config));
  output = [];
  io = { out: (value) => output.push(value), error: (value) => output.push(value) };
  mocks.resourceRoot.mockResolvedValue(resources);
  mocks.productAt.mockResolvedValue(product);
  mocks.loadProject.mockResolvedValue(project);
  mocks.application.mockResolvedValue({ engine, store });
  store.close.mockResolvedValue(undefined);
  store.get.mockResolvedValue(undefined);
  store.set.mockResolvedValue(undefined);
  store.delete.mockResolvedValue(undefined);
  store.entries.mockResolvedValue([]);
  store.events.mockResolvedValue([]);
  mocks.runCommand.mockResolvedValue({ code: 0, stdout: 'built helper\n', stderr: '' });
  mocks.toolRequire.mockResolvedValue('/fixture/adb');
  mocks.toolDiscover.mockResolvedValue('/fixture/adb');
  mocks.guardTarget.mockResolvedValue(undefined);
  mocks.startLocalAdbServer.mockResolvedValue(undefined);
  mocks.bootstrapTool.mockResolvedValue('/installed/distribution');
  mocks.runInDocker.mockResolvedValue(7);
  mocks.prepareDockerEnvironment.mockResolvedValue({ controlRoot: '/control' });
  mocks.startDockerAdb.mockResolvedValue({ port: 5038 });
  mocks.stopDockerAdb.mockResolvedValue({ stopped: true });
  mocks.inspectHost.mockResolvedValue({ supported: true, supervisor: true, tools: [{ compatible: true }] });
  mocks.extensionList.mockResolvedValue([lock]);
  mocks.extensionInstall.mockResolvedValue(lock);
  mocks.extensionUpdate.mockResolvedValue({ ...lock, version: '1.1.0' });
  mocks.extensionInspect.mockResolvedValue({ verified: true });
  mocks.extensionInvoke.mockResolvedValue([]);
  mocks.readContribution.mockImplementation((...args: unknown[]) =>
    Promise.resolve(args[1] === 'guides' ? '# Extension guide' : policy),
  );
  mocks.invokeAdapter.mockResolvedValue([]);
  mocks.executePlan.mockResolvedValue({ id: 'run', status: 'queued' });
  mocks.reservations.mockResolvedValue([]);
  mocks.recordLifecycle.mockResolvedValue({ recorded: true });
  mocks.serverClose.mockResolvedValue(undefined);
  mocks.serveStdio.mockResolvedValue({ close: mocks.serverClose });
  engine.prepare.mockResolvedValue(prepared);
  engine.prepareExtension.mockResolvedValue(prepared);
  engine.submit.mockResolvedValue({ id: 'run' });
  engine.execute.mockResolvedValue({ id: 'run', status: 'completed' });
  engine.executeFleet.mockResolvedValue([{ id: 'run', status: 'completed' }]);
  engine.readiness.mockResolvedValue({ ready: true });
  engine.acceptCustody.mockResolvedValue({ outcome: 'completed-custody' });
  engine.acceptedHandoff.mockRejectedValue(
    new Error('Finalize the device before exporting a handoff packet'),
  );
  engine.refreshReview.mockResolvedValue(prepared);
  engine.attest.mockResolvedValue({ recorded: true });
  engine.finalize.mockResolvedValue({ outcome: 'ready-for-handoff' });
  engine.recover.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});
const args = (values: string[]) => [...values, '--resource-root', resources, '--project-root', projectRoot];
describe('operator controller dispatch without device access', () => {
  it('keeps internal worker outcomes durable for completed, manual and failed runs', async () => {
    if (typeof process.disconnect === 'function')
      vi.spyOn(process, 'disconnect').mockImplementation(() => undefined);
    if (typeof process.send === 'function') vi.spyOn(process, 'send').mockImplementation(() => true);
    for (const [status, code] of [
      ['completed', 0],
      ['pending', 4],
      ['failed', 3],
    ] as const) {
      engine.execute.mockResolvedValueOnce({ id: 'run', status });
      expect(await runCli(args(['internal-worker', '--run', 'run']), io)).toBe(code);
    }
    expect(store.delete).toHaveBeenCalledTimes(3);
    engine.execute.mockRejectedValueOnce(new Error('missing run'));
    store.get.mockResolvedValueOnce(undefined);
    await expect(runCli(args(['internal-worker', '--run', 'missing']), io)).rejects.toThrow('missing run');
    expect(store.set).not.toHaveBeenCalled();
  });
  it('rejects missing workflows and ambiguous multi-asset device commands before actions', async () => {
    await expect(runCli(args(['device', '--asset', 'all']), io)).rejects.toThrow('Unknown device workflow');
    await expect(runCli(args(['device', 'constructor', '--asset', 'all']), io)).rejects.toThrow(
      'Unknown device workflow',
    );
    await expect(runCli(args(['lifecycle']), io)).rejects.toThrow('Unknown lifecycle');
    await expect(runCli(args(['handoff', 'unknown']), io)).rejects.toThrow('Unknown command');
    project.inventory.devices.push({
      ...device,
      assetId: 'second',
      canonicalSerial: 'SECOND',
      transports: [{ kind: 'usb', serial: 'SECOND' }],
    });
    await expect(runCli(args(['device', 'inspect', '--all']), io)).rejects.toThrow('exactly one asset');
    expect(engine.observe).not.toHaveBeenCalled();
  });

  it('inspects every selected fleet asset and preserves single-device response shape', async () => {
    project.inventory.devices.push({
      ...device,
      assetId: 'second',
      canonicalSerial: 'SECOND',
      transports: [{ kind: 'usb', serial: 'SECOND' }],
    });
    engine.observe.mockImplementation((target: { device: { assetId: string } }) =>
      Promise.resolve({ assetId: target.device.assetId, measured: true }),
    );
    expect(await runCli(args(['fleet', 'inspect', '--all']), io)).toBe(0);
    expect(engine.observe).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output.at(-1) ?? 'null')).toEqual([
      { assetId: 'all', measured: true },
      { assetId: 'second', measured: true },
    ]);
    expect(await runCli(args(['device', 'inspect', '--asset', 'all']), io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? 'null')).toEqual({ assetId: 'all', measured: true });
  });
  it('rejects conflicting selectors and fleet confirmation commands before any device action', async () => {
    for (const selectors of [
      ['--asset', 'all', '--group', 'pilot'],
      ['--asset', 'all', '--all'],
      ['--group', 'pilot', '--all'],
    ])
      await expect(runCli(args(['fleet', 'inspect', ...selectors]), io)).rejects.toThrow('Choose one');
    for (const command of ['attest', 'finalize', 'recover'])
      for (const selector of [['--all'], ['--group', 'pilot']])
        await expect(runCli(args(['fleet', command, ...selector, '--yes']), io)).rejects.toThrow(
          'one exact --asset',
        );
    expect(engine.observe).not.toHaveBeenCalled();
    expect(engine.attest).not.toHaveBeenCalled();
    expect(engine.finalize).not.toHaveBeenCalled();
    expect(engine.recover).not.toHaveBeenCalled();
  });
  it('projects legacy OS pause reasons on status without rewriting the run', async () => {
    store.get
      .mockResolvedValueOnce({ id: 'flash', planId: 'plan', status: 'pending' })
      .mockResolvedValueOnce({ operation: 'install-os' });
    expect(await runCli(args(['agent', 'status', '--run', 'flash']), io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? 'null')).toMatchObject({
      run: { id: 'flash', status: 'pending', pauseReason: { kind: 'reenrollment' } },
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('enrolls only the measured USB or emulator target and rejects mismatched fastboot identities', async () => {
    const base = [
      'inventory',
      'enroll',
      '--asset',
      'second',
      '--serial',
      'SECOND',
      '--model',
      'Pixel 8a',
      '--codename',
      'akita',
      '--yes',
    ];
    expect(await runCli(args([...base, '--group', 'visit']), io)).toBe(0);
    const selected: unknown = mocks.guardTarget.mock.calls[0]?.[0];
    expect(selected).toMatchObject({ device: { assetId: 'second', groups: ['visit'] } });
    mocks.toolDiscover.mockResolvedValueOnce(undefined);
    expect(await runCli(args([...base, '--kind', 'emulator', '--transport', 'emulator']), io)).toBe(0);
    mocks.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: 'SECOND\tfastboot\nOTHER\tfastboot\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '(bootloader) product: akita\n' });
    expect(await runCli(args([...base, '--mode', 'fastboot']), io)).toBe(0);
    expect(mocks.runCommand).toHaveBeenLastCalledWith(['/fixture/adb', '-s', 'SECOND', 'getvar', 'product']);
    for (const [stdout, error] of [
      ['', 'unavailable or ambiguous'],
      ['SECOND\tfastboot\nSECOND\tfastboot\n', 'unavailable or ambiguous'],
    ]) {
      mocks.runCommand.mockResolvedValueOnce({ code: 0, stdout, stderr: '' });
      await expect(runCli(args([...base, '--mode', 'fastboot']), io)).rejects.toThrow(error);
    }
    mocks.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: 'SECOND\tfastboot', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'product: husky', stderr: '' });
    await expect(runCli(args([...base, '--mode', 'fastboot']), io)).rejects.toThrow(
      'differs from enrollment',
    );
    mocks.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: 'SECOND\tfastboot', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'unrecognized', stderr: '' });
    await expect(runCli(args([...base, '--mode', 'fastboot']), io)).rejects.toThrow(
      'differs from enrollment',
    );
    await expect(runCli(args([...base, '--kind', 'emulator', '--mode', 'fastboot']), io)).rejects.toThrow(
      'USB Pixel',
    );
    await expect(runCli(args([...base, '--kind', 'tablet']), io)).rejects.toThrow('Device kind');
    await expect(runCli(args([...base, '--transport', 'wifi']), io)).rejects.toThrow('First enrollment');
    await expect(runCli(args([...base, '--mode', 'invalid']), io)).rejects.toThrow('Enrollment mode');
  });
  it('starts ADB only by explicit host request and handles missing HOME', async () => {
    process.env['HOME'] = join(root, 'private-home');
    expect(await runCli(args(['host', 'adb-start', '--yes']), io)).toBe(0);
    expect(mocks.startLocalAdbServer).toHaveBeenCalledOnce();
    delete process.env['HOME'];
    expect(await runCli(args(['host', 'adb-start', '--yes']), io)).toBe(0);
  });

  it('reads declared extension guides, explicitly selects validated policies and plans adapter actions', async () => {
    project.config.extensions.push(lock);
    expect(
      await runCli(args(['extension', 'guide', '--extension', lock.id, '--contribution', 'guide.md']), io),
    ).toBe(0);
    expect(output.at(-1)).toBe('# Extension guide');
    await expect(
      runCli(args(['extension', 'policy', '--extension', lock.id, '--contribution', 'policy.json']), {
        ...io,
        confirm: () => Promise.resolve(false),
      }),
    ).rejects.toThrow('Cancelled');
    expect(
      await runCli(
        args(['extension', 'policy', '--extension', lock.id, '--contribution', 'policy.json', '--yes']),
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(join(projectRoot, config.policyFile), 'utf8')) as unknown).toEqual(
      policy,
    );
    expect(
      await runCli(
        args([
          'extension',
          'adapter',
          '--extension',
          lock.id,
          '--contribution',
          'adapter.js',
          '--asset',
          'all',
        ]),
        io,
      ),
    ).toBe(0);
    expect(mocks.invokeAdapter).toHaveBeenCalledWith(lock, 'adapter.js', {});
    expect(engine.prepareExtension).toHaveBeenCalledWith(expect.objectContaining({ device }), []);
  });
  it('rejects unknown execution before falling back to a host or Docker operation', async () => {
    await expect(
      runCli(args(['device', 'provision', '--asset', 'all', '--execution', 'unknown', '--yes']), io),
    ).rejects.toThrow(/host or docker/);
    expect(mocks.application).not.toHaveBeenCalled();
    expect(mocks.runInDocker).not.toHaveBeenCalled();
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.submit).not.toHaveBeenCalled();
  });
  it('rejects invalid fleet concurrency before preparing or durably submitting any run', async () => {
    for (const jobs of ['0', '9', '1.5', 'NaN'])
      await expect(
        runCli(args(['fleet', 'provision', '--all', `--jobs=${jobs}`, '--yes']), io),
      ).rejects.toThrow(/jobs must/);
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.submit).not.toHaveBeenCalled();
    expect(engine.executeFleet).not.toHaveBeenCalled();
  });
  it('dispatches host diagnostics and explicit Docker lifecycle commands with confirmation', async () => {
    expect(await runCli(args(['host', 'doctor']), io)).toBe(0);
    mocks.inspectHost.mockResolvedValue({ supported: true, supervisor: false, tools: [] });
    expect(await runCli(args(['host', 'doctor']), io)).toBe(4);
    await expect(
      runCli(args(['host', 'docker-prepare']), { ...io, confirm: () => Promise.resolve(false) }),
    ).rejects.toThrow(/Cancelled/);
    expect(mocks.prepareDockerEnvironment).not.toHaveBeenCalled();
    expect(await runCli(args(['host', 'docker-prepare', '--yes']), io)).toBe(0);
    expect(await runCli(args(['host', 'docker-adb-start', '--image', 'local:test', '--yes']), io)).toBe(0);
    expect(mocks.startDockerAdb).toHaveBeenCalledWith('local:test', expect.any(String));
    expect(await runCli(args(['host', 'docker-adb-stop', '--yes']), io)).toBe(0);
    expect(mocks.stopDockerAdb).toHaveBeenCalledOnce();
    expect(
      await runCli(
        args([
          'device',
          'inspect',
          '--execution',
          'docker',
          '--image',
          'local:test',
          '--docker-mode',
          'direct',
        ]),
        io,
      ),
    ).toBe(7);
    expect(mocks.runInDocker).toHaveBeenCalledWith(
      expect.any(Array),
      projectRoot,
      'local:test',
      'direct',
      expect.any(String),
    );
  });
  it('requires reviewed bootstrap inputs and bounded helper types and excludes unrelated environment secrets', async () => {
    const descriptor = join(root, 'archive.json');
    await writeFile(descriptor, '{}');
    expect(
      await runCli(
        args([
          'host',
          'bootstrap',
          '--file',
          descriptor,
          '--license',
          'android-sdk-license',
          '--path',
          join(root, 'tools'),
          '--yes',
        ]),
        io,
      ),
    ).toBe(0);
    expect(mocks.bootstrapTool).toHaveBeenCalledWith(
      descriptor,
      'android-sdk-license',
      join(root, 'tools'),
      expect.any(Object),
    );
    process.env['NPM_TOKEN'] = 'sentinel-do-not-inherit';
    process.env['ANDROID_HOME'] = '/sdk';
    expect(await runCli(args(['host', 'build-helper', '--type', 'probe', '--yes']), io)).toBe(0);
    const command = mocks.runCommand.mock.calls[0];
    expect(command?.[0]).toContain('--component');
    expect(command?.[1]).toMatchObject({ env: { ANDROID_HOME: '/sdk' }, timeoutMs: 120000 });
    expect(JSON.stringify(command)).not.toContain('sentinel-do-not-inherit');
    await expect(runCli(args(['host', 'build-helper', '--type', 'bad', '--yes']), io)).rejects.toThrow(
      /Choose/,
    );
    await expect(runCli(args(['host', 'unknown']), io)).rejects.toThrow(/Unknown host/);
  });
  it('pins local and registry extension installation, replacement and removal into the project', async () => {
    expect(await runCli(args(['extension', 'list']), io)).toBe(0);
    const archive = join(root, 'extension.tgz');
    expect(await runCli(args(['extension', 'install', '--file', archive, '--yes']), io)).toBe(0);
    expect(mocks.extensionInstall).toHaveBeenCalledWith({ tarball: archive });
    expect(
      JSON.parse(await readFile(join(projectRoot, 'pxv.project.json'), 'utf8')) as unknown,
    ).toMatchObject({ extensions: [lock] });
    expect(
      await runCli(
        args([
          'extension',
          'install',
          '--package',
          '@vendor/private',
          '--version',
          '1.0.0',
          '--registry',
          'https://registry.example',
          '--yes',
        ]),
        io,
      ),
    ).toBe(0);
    expect(mocks.extensionInstall).toHaveBeenLastCalledWith({ package: '@vendor/private', version: '1.0.0' });
    await expect(
      runCli(args(['extension', 'update', '--extension', lock.id, '--file', archive, '--yes']), io),
    ).rejects.toThrow(/installed extension/);
    project.config.extensions.push(lock);
    expect(
      await runCli(args(['extension', 'update', '--extension', lock.id, '--file', archive, '--yes']), io),
    ).toBe(0);
    expect(mocks.extensionUpdate).toHaveBeenCalledWith(lock, { tarball: archive });
    expect(await runCli(args(['extension', 'inspect', '--extension', lock.id]), io)).toBe(0);
    expect(await runCli(args(['extension', 'remove', '--extension', lock.id, '--yes']), io)).toBe(0);
    expect(
      JSON.parse(await readFile(join(projectRoot, 'pxv.project.json'), 'utf8')) as unknown,
    ).toMatchObject({ extensions: [] });
    expect(output.at(-1)).toContain('retainedInSharedStore');
  });
  it('prepares extension-contributed actions through the core and closes the application on errors', async () => {
    project.config.extensions.push(lock);
    const input = join(root, 'input.json');
    await writeFile(input, '{"publicConfig":"enabled"}');
    expect(
      await runCli(
        args([
          'extension',
          'invoke',
          '--extension',
          lock.id,
          '--command',
          'setup',
          '--input-file',
          input,
          '--asset',
          'all',
        ]),
        io,
      ),
    ).toBe(0);
    expect(mocks.extensionInvoke).toHaveBeenCalledWith(lock, 'setup', { publicConfig: 'enabled' });
    expect(engine.prepareExtension).toHaveBeenCalledWith(expect.objectContaining({ device }), []);
    expect(store.close).toHaveBeenCalledOnce();
    await expect(runCli(args(['extension', 'unknown', '--extension', lock.id]), io)).rejects.toThrow(
      /Unknown extension/,
    );
    await expect(runCli(args(['extension', 'inspect', '--extension', 'missing']), io)).rejects.toThrow(
      /not pinned/,
    );
    engine.prepareExtension.mockRejectedValueOnce(new Error('invalid actions'));
    await expect(
      runCli(
        args(['extension', 'invoke', '--extension', lock.id, '--command', 'setup', '--asset', 'all']),
        io,
      ),
    ).rejects.toThrow(/invalid actions/);
    expect(store.close).toHaveBeenCalledTimes(2);
  });
  it('records all supported lifecycle events with explicit erasure and bounded operator notes delegated to the service', async () => {
    for (const type of ['maintenance', 'policy-change', 'loss', 'retirement'])
      expect(
        await runCli(
          args([
            'lifecycle',
            type,
            '--asset',
            'all',
            '--operator',
            'operator',
            '--note',
            'Reviewed event',
            '--erased',
            '--yes',
          ]),
          io,
        ),
      ).toBe(0);
    expect(mocks.recordLifecycle).toHaveBeenLastCalledWith(
      project,
      store,
      {
        assetId: 'all',
        type: 'retirement',
        operator: 'operator',
        note: 'Reviewed event',
        confirmedErasure: true,
      },
      undefined,
      undefined,
    );
    expect(store.close).toHaveBeenCalledTimes(4);
    await expect(runCli(args(['lifecycle', 'unknown', '--asset', 'all', '--yes']), io)).rejects.toThrow(
      /Unknown lifecycle/,
    );
    expect(store.close).toHaveBeenCalledTimes(5);
  });
  it('reports detached run progress and explicit cancellation/resume without spawning a new worker for reads', async () => {
    expect(await runCli(args(['agent', 'refresh', '--run', 'run']), io)).toBe(0);
    expect(engine.refreshReview).toHaveBeenCalledWith('run', expect.any(AbortSignal));
    expect(await runCli(args(['agent', 'runs']), io)).toBe(0);
    expect(await runCli(args(['agent', 'status', '--run', 'run', '--after', '9']), io)).toBe(0);
    expect(store.events).toHaveBeenCalledWith('run', 9, 100);
    expect(await runCli(args(['agent', 'cancel', '--run', 'run']), io)).toBe(0);
    expect(engine.cancel).toHaveBeenCalledWith('run');
    expect(await runCli(args(['agent', 'resume', '--run', 'run', '--yes']), io)).toBe(0);
    expect(engine.execute).toHaveBeenCalledWith('run', expect.any(AbortSignal));
    const review = join(root, 'review.json');
    await writeFile(review, 'exact-summary');
    expect(
      await runCli(
        args(['agent', 'execute', '--plan', 'plan', '--review-file', review, '--operator', 'operator']),
        io,
      ),
    ).toBe(0);
    expect(mocks.executePlan).toHaveBeenCalledWith('plan', 'exact-summary', 'operator');
    await expect(runCli(args(['agent', 'unknown']), io)).rejects.toThrow(/Unknown agent/);
  });
  it.each(['direct', 'host-adb'])(
    'keeps %s Docker agent execution foreground until the approved run finishes',
    async (mode) => {
      process.env['PXV_DOCKER_MODE'] = mode;
      const review = join(root, 'review.txt');
      await writeFile(review, 'exact-summary');
      let finish: ((run: { id: string; status: string }) => void) | undefined;
      engine.execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let settled = false;
      const running = runCli(
        args(['agent', 'execute', '--plan', 'plan', '--review-file', review, '--operator', 'operator']),
        io,
      ).then((code) => {
        settled = true;
        return code;
      });
      await vi.waitFor(() => expect(engine.execute).toHaveBeenCalledWith('run', expect.any(AbortSignal)));
      expect(engine.submit).toHaveBeenCalledWith('plan', 'exact-summary', 'operator');
      expect(mocks.executePlan).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(store.close).not.toHaveBeenCalled();
      finish?.({ id: 'run', status: 'completed' });
      expect(await running).toBe(0);
      expect(store.close).toHaveBeenCalledOnce();
      expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ id: 'run', status: 'completed' });
    },
  );
  it('reports foreground Docker manual, failure and cancellation results without detaching', async () => {
    process.env['PXV_DOCKER_MODE'] = 'direct';
    const review = join(root, 'review.txt');
    await writeFile(review, 'exact-summary');
    for (const [status, code] of [
      ['pending', 4],
      ['failed', 3],
      ['cancelled', 130],
    ] as const) {
      engine.execute.mockResolvedValueOnce({ id: 'run', status });
      expect(
        await runCli(
          args(['agent', 'execute', '--plan', 'plan', '--review-file', review, '--operator', 'operator']),
          io,
        ),
      ).toBe(code);
    }
    expect(mocks.executePlan).not.toHaveBeenCalled();
    engine.submit.mockRejectedValueOnce(new Error('review mismatch'));
    const executed = engine.execute.mock.calls.length;
    await expect(
      runCli(
        args(['agent', 'execute', '--plan', 'plan', '--review-file', review, '--operator', 'operator']),
        io,
      ),
    ).rejects.toThrow('review mismatch');
    expect(engine.execute).toHaveBeenCalledTimes(executed);
  });
  it('rejects host-ADB OS preparation and invalid worker modes before opening an application', async () => {
    process.env['PXV_DOCKER_MODE'] = 'host-adb';
    await expect(runCli(args(['device', 'install-os', '--asset', 'all', '--dry-run']), io)).rejects.toThrow(
      'direct USB',
    );
    expect(mocks.application).not.toHaveBeenCalled();
    expect(engine.prepare).not.toHaveBeenCalled();
    process.env['PXV_DOCKER_MODE'] = 'invalid';
    await expect(runCli(args(['host', 'doctor']), io)).rejects.toThrow('Invalid Docker worker mode');
    expect(mocks.inspectHost).not.toHaveBeenCalled();
    process.env['PXV_DOCKER_MODE'] = 'direct';
    expect(await runCli(args(['device', 'install-os', '--asset', 'all', '--dry-run']), io)).toBe(0);
    expect(engine.prepare).toHaveBeenCalledWith(expect.any(Object), 'install-os', expect.any(AbortSignal));
  });
  it('preserves worker failures and returns status codes for queued fleet outcomes', async () => {
    engine.execute.mockRejectedValueOnce(new Error('worker interrupted'));
    store.get.mockResolvedValueOnce({ id: 'run', status: 'running' });
    const disconnect =
      typeof process.disconnect === 'function'
        ? vi.spyOn(process, 'disconnect').mockImplementation(() => undefined)
        : undefined;
    const send =
      typeof process.send === 'function'
        ? vi.spyOn(process, 'send').mockImplementation(() => true)
        : undefined;
    try {
      await expect(runCli(args(['internal-worker', '--run', 'run']), io)).rejects.toThrow(
        /worker interrupted/,
      );
    } finally {
      disconnect?.mockRestore();
      send?.mockRestore();
    }
    expect(store.set).toHaveBeenCalledWith(
      'runs',
      'run',
      expect.objectContaining({ status: 'needs-inspection' }),
    );
    for (const [status, expected] of [
      ['failed', 3],
      ['needs-inspection', 3],
      ['cancelled', 130],
      ['pending', 4],
      ['completed', 0],
    ] as const) {
      engine.executeFleet.mockResolvedValueOnce([{ id: 'run', status }]);
      expect(await runCli(args(['fleet', 'provision', '--all', '--yes']), io)).toBe(expected);
    }
    await expect(runCli(args(['fleet', 'provision', '--all', '--jobs', '9', '--yes']), io)).rejects.toThrow(
      /jobs must/,
    );
  });
  it('supports explicit recipient acceptance and recovery while keeping missing handoff evidence blocked', async () => {
    expect(
      await runCli(
        args(['handoff', 'accept', '--asset', 'all', '--recipient', 'recipient', '--debugging-off', '--yes']),
        io,
      ),
    ).toBe(0);
    expect(engine.acceptCustody).toHaveBeenCalledWith('all', 'recipient', true);
    await expect(
      runCli(args(['handoff', 'export', '--asset', 'all', '--output', join(root, 'handoff')]), io),
    ).rejects.toThrow(/Finalize/);
    expect(await runCli(args(['device', 'recover', '--asset', 'all']), io)).toBe(4);
    expect(engine.recover).not.toHaveBeenCalled();
    expect(
      await runCli(
        args(['device', 'recover', '--asset', 'all', '--inspected', '--run', 'old-run', '--yes']),
        io,
      ),
    ).toBe(0);
    expect(engine.recover).toHaveBeenCalledWith(expect.any(Object), 'old-run', expect.any(AbortSignal));
  });
  it('closes the MCP server without retaining a stale application context', async () => {
    const serving = runCli(args(['mcp', 'serve']), io);
    await vi.waitFor(() => expect(mocks.serveStdio).toHaveBeenCalledOnce());
    process.stdin.emit('end');
    expect(await serving).toBe(0);
    expect(mocks.serverClose).toHaveBeenCalledOnce();
    expect(mocks.application).not.toHaveBeenCalled();
  });
});
