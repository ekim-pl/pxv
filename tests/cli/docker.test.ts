import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '@pxv/adapters';
import { dockerfile } from '../../packages/release/src/formats.js';
import type { CandidateManifest } from '../../packages/release/src/candidate.js';
import { product } from '../contracts/fixtures.js';
import {
  prepareDockerEnvironment,
  runInDocker,
  startDockerAdb,
  stopDockerAdb,
  type DockerEnvironment,
} from '../../packages/cli/src/docker.js';
const image = `sha256:${'a'.repeat(64)}`;
interface Container {
  Image: string;
  Config: { User: string; Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
}
class DockerFixture implements CommandRunner {
  calls: { args: string[]; options?: CommandOptions }[] = [];
  container: Container | undefined;
  digest = image;
  workerCode = 0;
  failDevices = false;
  inspectError = '';
  failStart = false;
  constructor(readonly state: DockerEnvironment) {}
  run(args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ args, ...(options ? { options } : {}) });
    const output = (stdout = '', code = 0, stderr = '') => Promise.resolve({ code, stdout, stderr });
    if (args.slice(1, 3).join(' ') === 'image inspect') return output(this.digest);
    if (args.slice(1, 3).join(' ') === 'container inspect') {
      if (this.inspectError) return output('', 1, this.inspectError);
      return this.container ? output(JSON.stringify(this.container)) : output('', 1, 'Error: No such object');
    }
    if (args[1] === 'run' && args.includes('--detach')) {
      if (this.failStart) return output('', 1, 'start failed');
      this.container = this.owned();
      return output('b'.repeat(64));
    }
    if (args[1] === 'exec') return this.failDevices ? output('', 1) : output('List of devices attached\n');
    if (args[1] === 'start') {
      if (this.failStart) return output('', 1);
      if (this.container) this.container.State.Running = true;
      return output('started');
    }
    if (args[1] === 'stop') {
      if (this.failStart) return output('', 1);
      if (this.container) this.container.State.Running = false;
      return output('stopped');
    }
    if (args[1] === 'run') return output('', this.workerCode);
    return Promise.reject(new Error(`Unexpected Docker fixture command: ${args.join(' ')}`));
  }
  owned(): Container {
    return {
      Image: image,
      Config: {
        User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        Labels: {
          'org.pxv.adb-control': createHash('sha256').update(this.state.controlRoot).digest('hex'),
          'org.pxv.adb-port': '5038',
        },
      },
      State: { Running: true },
      HostConfig: { NetworkMode: 'host' },
      Mounts: [{ Source: this.state.adbHome, Destination: '/adb-home', RW: true }],
    };
  }
}
let root: string;
let extensions: string;
let project: string;
let saved: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-docker-cli-'));
  saved = { ...process.env };
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  extensions = join(root, 'extensions');
  project = join(root, 'project with spaces');
  await mkdir(project, { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});
describe('explicit Docker execution and independent ADB lifecycle', () => {
  it('defaults raw image execution to foreground host-ADB mode unless direct mode is explicit', () => {
    const manifest = {
      product,
      version: '0.1.0',
      source: { revision: null },
      sourceDigest: 'a'.repeat(64),
    } as CandidateManifest;
    expect(dockerfile(manifest)).toContain(' PXV_DOCKER_MODE=host-adb ');
  });
  it('prepares private persistent control and keys only through the explicit preparation command', async () => {
    const unprepared = {
      controlRoot: join(root, 'control'),
      adbHome: join(root, 'control/adb-home'),
      extensionRoot: extensions,
    };
    const runner = new DockerFixture(unprepared);
    await expect(
      runInDocker(['inventory', 'list'], project, 'pxv/local', 'host-adb', extensions, runner),
    ).rejects.toThrow(/docker-prepare/);
    expect(runner.calls).toHaveLength(0);
    expect(await readdir(root)).toEqual(['project with spaces']);
    const state = await prepareDockerEnvironment(extensions);
    expect((await lstat(state.adbHome)).mode & 0o077).toBe(0);
    expect((await lstat(join(state.adbHome, '.android'))).mode & 0o077).toBe(0);
    expect(await prepareDockerEnvironment(extensions)).toEqual(state);
  });
  it('pins host-ADB workers to a local immutable image and preserves host control and read-only keys/extensions', async () => {
    const state = await prepareDockerEnvironment(extensions);
    const runner = new DockerFixture(state);
    runner.workerCode = 7;
    expect(
      await runInDocker(
        [
          'device',
          'inspect',
          '--asset',
          'all',
          '--execution',
          'docker',
          '--image',
          'pxv/local',
          '--docker-mode',
          'host-adb',
          '--project-root',
          project,
          '--resource-root',
          '/host/resources',
          '--execution=docker',
          '--image=ignored',
        ],
        project,
        'pxv/local',
        'host-adb',
        extensions,
        runner,
      ),
    ).toBe(7);
    const command = runner.calls.find((call) => call.args.includes('--rm'))?.args ?? [];
    expect(command).toContain(image);
    expect(command).toContain(`type=bind,src=${state.controlRoot},dst=/control`);
    expect(command).toContain(`type=bind,src=${state.adbHome},dst=/adb-home,readonly`);
    expect(command).toContain(`type=bind,src=${extensions},dst=/extensions,readonly`);
    expect(command).toContain('PXV_HOST_ADB_PORT=5037');
    expect(command).toContain('PXV_DOCKER_MODE=host-adb');
    expect(command).not.toContain('/host/resources');
    expect(command).not.toContain('--execution');
    expect(command).not.toContain('--image=ignored');
    expect(command.slice(-2)).toEqual(['--project-root', '/project']);
    expect(runner.calls.some((call) => call.args.includes('start-server'))).toBe(false);
  });
  it('starts an independent persistent direct-USB server and lets workers attach without owning its lifecycle', async () => {
    const state = await prepareDockerEnvironment(extensions);
    const runner = new DockerFixture(state);
    const service = await startDockerAdb('pxv/local', extensions, runner);
    expect(service.port).toBe(5038);
    const start = runner.calls.find((call) => call.args.includes('--detach'))?.args ?? [];
    expect(start).toContain('--entrypoint');
    expect(start).toContain('adb');
    expect(start).toContain('tcp:127.0.0.1:5038');
    expect(start.slice(-2)).toEqual(['nodaemon', 'server']);
    expect(start).toContain(`type=bind,src=${state.adbHome},dst=/adb-home`);
    expect(start).not.toContain('--rm');
    await startDockerAdb('pxv/local', extensions, runner);
    expect(runner.calls.filter((call) => call.args.includes('--detach'))).toHaveLength(1);
    await runInDocker(['device', 'inspect'], project, 'pxv/local', 'direct', extensions, runner);
    const worker = runner.calls.find((call) => call.args.includes('--rm'))?.args ?? [];
    expect(worker).toContain('PXV_HOST_ADB_PORT=5038');
    expect(worker).toContain('PXV_DOCKER_MODE=direct');
    expect(worker).toContain('type=bind,src=/dev/bus/usb,dst=/dev/bus/usb');
    expect(runner.calls.some((call) => call.args.includes('kill-server') || call.args[1] === 'stop')).toBe(
      false,
    );
    expect(await stopDockerAdb(extensions, runner)).toMatchObject({ stopped: true });
    expect(await stopDockerAdb(extensions, runner)).toMatchObject({ stopped: false });
    await startDockerAdb('pxv/local', extensions, runner);
    expect(runner.calls.some((call) => call.args[1] === 'start')).toBe(true);
  });
  it('refuses unknown, changed or stopped sidecars without automatically starting or replacing them', async () => {
    const state = await prepareDockerEnvironment(extensions);
    const runner = new DockerFixture(state);
    await expect(runInDocker([], project, 'pxv/local', 'direct', extensions, runner)).rejects.toThrow(
      /docker-adb-start/,
    );
    runner.container = runner.owned();
    runner.container.Config.Labels['org.pxv.adb-control'] = 'wrong';
    await expect(stopDockerAdb(extensions, runner)).rejects.toThrow(/does not match/);
    expect(runner.calls.some((call) => call.args[1] === 'stop')).toBe(false);
    runner.container = { ...runner.owned(), Image: `sha256:${'c'.repeat(64)}` };
    await expect(startDockerAdb('pxv/local', extensions, runner)).rejects.toThrow(/another image/);
    await expect(runInDocker([], project, 'pxv/local', 'direct', extensions, runner)).rejects.toThrow(
      /same reviewed/,
    );
  });
  it('rejects unsafe Docker CSV paths, symlink key directories, unpinned images and daemon inspection errors', async () => {
    await expect(prepareDockerEnvironment(join(root, 'unsafe,path'))).rejects.toThrow(/CSV/);
    await expect(prepareDockerEnvironment(join(root, 'unsafe\npath'))).rejects.toThrow(/newlines/);
    const state = await prepareDockerEnvironment(extensions);
    const runner = new DockerFixture(state);
    await expect(runInDocker([], 'relative', 'pxv/local', 'host-adb', extensions, runner)).rejects.toThrow(
      /absolute/,
    );
    runner.digest = 'mutable:tag';
    await expect(runInDocker([], project, 'pxv/local', 'host-adb', extensions, runner)).rejects.toThrow(
      /immutable/,
    );
    await expect(runInDocker([], project, '-option', 'host-adb', extensions, runner)).rejects.toThrow(
      /explicit installed/,
    );
    runner.digest = image;
    runner.inspectError = 'permission denied';
    await expect(startDockerAdb('pxv/local', extensions, runner)).rejects.toThrow(/ownership/);
    const linked = join(root, 'linked-extensions');
    await symlink(extensions, linked);
    await expect(prepareDockerEnvironment(linked)).rejects.toThrow(/owned regular/);
  });
  it('retains startup failures for explicit inspection and never kills a sidecar after readiness failure', async () => {
    const state = await prepareDockerEnvironment(extensions);
    const runner = new DockerFixture(state);
    runner.failStart = true;
    await expect(startDockerAdb('pxv/local', extensions, runner)).rejects.toThrow(/could not start/);
    runner.failStart = false;
    runner.failDevices = true;
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20_000);
    await expect(startDockerAdb('pxv/local', extensions, runner)).rejects.toThrow(/did not acknowledge/);
    expect(runner.calls.some((call) => call.args[1] === 'stop')).toBe(false);
  });
});
