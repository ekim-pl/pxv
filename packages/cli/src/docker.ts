import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandRunner, hostControlRoot } from '@pxv/runtime';
import type { CommandRunner as Runner } from '@pxv/adapters';

export interface DockerEnvironment {
  controlRoot: string;
  adbHome: string;
  extensionRoot: string;
}
export interface DockerAdbService {
  containerName: string;
  image: string;
  port: 5038;
}
const CONTROL_LABEL = 'org.pxv.adb-control';
const PORT_LABEL = 'org.pxv.adb-port';
const userIdentity = (): string => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
function mountPath(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n,"]/u.test(value))
    throw new Error(
      'Docker bind paths must be absolute and cannot contain CSV delimiters, quotes or newlines',
    );
  return value;
}
async function directory(path: string, create: boolean, privateMode = true): Promise<string> {
  mountPath(path);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Docker environment is unprepared; run host docker-prepare explicitly');
    throw error;
  });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (privateMode && (info.mode & 0o077) !== 0)
  )
    throw new Error(
      'Docker directories must be owned regular directories with private control/key/extension permissions',
    );
  return realpath(path);
}
async function environment(extensionRoot: string, create: boolean): Promise<DockerEnvironment> {
  const controlRoot = await directory(hostControlRoot(), create);
  const adbHome = await directory(join(controlRoot, 'adb-home'), create);
  await directory(join(adbHome, '.android'), create);
  return { controlRoot, adbHome, extensionRoot: await directory(extensionRoot, create) };
}
/** Explicit preparation only; running a read-only worker never initializes host state. */
export async function prepareDockerEnvironment(extensionRoot: string): Promise<DockerEnvironment> {
  return environment(extensionRoot, true);
}
async function immutableImage(image: string, runner: Runner): Promise<string> {
  if (!image || image.startsWith('-') || /[\s\0]/u.test(image))
    throw new Error('Select an explicit installed worker image');
  const result = await runner.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw new Error('Selected Docker image is unavailable locally');
  const resolved = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(resolved))
    throw new Error('Worker image must resolve to an immutable local digest');
  return resolved;
}
function serviceIdentity(state: DockerEnvironment): { name: string; key: string } {
  const key = createHash('sha256').update(state.controlRoot).digest('hex');
  return { name: `pxv-adb-${process.getuid?.() ?? 1000}-${key.slice(0, 12)}`, key };
}
type Container = {
  Image: string;
  Config: { User: string; Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
};
async function inspectService(runner: Runner, state: DockerEnvironment): Promise<Container | undefined> {
  const identity = serviceIdentity(state);
  const result = await runner.run(
    ['docker', 'container', 'inspect', '--format', '{{json .}}', identity.name],
    { check: false, timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    if (/No such (?:object|container)/iu.test(result.stderr)) return undefined;
    throw new Error('Docker ADB service ownership could not be inspected');
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('Docker ADB service inspection is malformed');
  }
  if (!value || typeof value !== 'object') throw new Error('Docker ADB service inspection is malformed');
  const container = value as Partial<Container>;
  if (
    typeof container.Image !== 'string' ||
    typeof container.State?.Running !== 'boolean' ||
    container.Config?.User !== userIdentity() ||
    container.Config.Labels?.[CONTROL_LABEL] !== identity.key ||
    container.Config.Labels[PORT_LABEL] !== '5038' ||
    container.HostConfig?.NetworkMode !== 'host' ||
    !Array.isArray(container.Mounts) ||
    !container.Mounts.some(
      (mount) => mount.Destination === '/adb-home' && mount.Source === state.adbHome && mount.RW === true,
    )
  )
    throw new Error(
      'Existing Docker ADB container does not match this operator control directory; inspect it explicitly',
    );
  return container as Container;
}
async function waitForService(runner: Runner, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    const result = await runner.run(
      ['docker', 'exec', name, 'adb', '-H', '127.0.0.1', '-P', '5038', 'devices'],
      { check: false, timeoutMs: 5000 },
    );
    if (result.code === 0 && result.stdout.startsWith('List of devices attached')) return;
    if (Date.now() >= deadline) break;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Docker ADB server did not acknowledge startup; inspect its retained container logs');
}
/** A persistent foreground server owns ADB keys independently of every device worker. */
export async function startDockerAdb(
  image: string,
  extensionRoot: string,
  runner: Runner = new CommandRunner(),
): Promise<DockerAdbService> {
  const state = await environment(extensionRoot, false);
  const resolved = await immutableImage(image, runner);
  const identity = serviceIdentity(state);
  const existing = await inspectService(runner, state);
  if (existing && existing.Image !== resolved)
    throw new Error(
      'Existing ADB sidecar uses another image; stop and remove that explicitly reviewed container before changing its image',
    );
  if (!existing) {
    const args = [
      'docker',
      'run',
      '--detach',
      '--name',
      identity.name,
      '--network',
      'host',
      '--user',
      userIdentity(),
      '--label',
      `${CONTROL_LABEL}=${identity.key}`,
      '--label',
      `${PORT_LABEL}=5038`,
      '--mount',
      `type=bind,src=${state.adbHome},dst=/adb-home`,
      '--mount',
      'type=bind,src=/dev/bus/usb,dst=/dev/bus/usb',
      '--device-cgroup-rule',
      'c 189:* rmw',
      '--env',
      'HOME=/adb-home',
      '--env',
      'ADB_MDNS_AUTO_CONNECT=0',
      '--entrypoint',
      'adb',
      resolved,
      '-L',
      'tcp:127.0.0.1:5038',
      'nodaemon',
      'server',
    ];
    const started = await runner.run(args, { check: false, timeoutMs: 30_000 });
    if (started.code !== 0)
      throw new Error('Docker ADB sidecar could not start; inspect the selected image and USB access');
  } else if (!existing.State.Running) {
    const started = await runner.run(['docker', 'start', identity.name], { check: false, timeoutMs: 30_000 });
    if (started.code !== 0) throw new Error('The existing owned Docker ADB sidecar could not restart');
  }
  await waitForService(runner, identity.name);
  return { containerName: identity.name, image: resolved, port: 5038 };
}
/** Stop is explicit and limited to the container whose control/key ownership was inspected. */
export async function stopDockerAdb(
  extensionRoot: string,
  runner: Runner = new CommandRunner(),
): Promise<{ containerName: string; stopped: boolean }> {
  const state = await environment(extensionRoot, false);
  const identity = serviceIdentity(state);
  const existing = await inspectService(runner, state);
  if (!existing?.State.Running) return { containerName: identity.name, stopped: false };
  const result = await runner.run(['docker', 'stop', '--time', '10', identity.name], {
    timeoutMs: 30_000,
    check: false,
  });
  if (result.code !== 0) throw new Error('The owned Docker ADB sidecar could not be stopped');
  return { containerName: identity.name, stopped: true };
}
export async function runInDocker(
  args: string[],
  projectRoot: string,
  image: string,
  mode: 'direct' | 'host-adb',
  extensionRoot: string,
  runner: Runner = new CommandRunner(),
): Promise<number> {
  if (mode !== 'direct' && mode !== 'host-adb') throw new Error('Choose direct or host-adb Docker transport');
  const project = await directory(projectRoot, false, false);
  const state = await environment(extensionRoot, false);
  const resolved = await immutableImage(image, runner);
  if (mode === 'direct') {
    const service = await inspectService(runner, state);
    if (!service?.State.Running)
      throw new Error('Direct USB needs the independent ADB sidecar; run host docker-adb-start explicitly');
    if (service.Image !== resolved)
      throw new Error('Direct USB sidecar and worker must use the same reviewed immutable image');
  }
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument) continue;
    if (['--execution', '--image', '--docker-mode', '--project-root', '--resource-root'].includes(argument)) {
      index++;
      continue;
    }
    if (/^--(?:execution|image|docker-mode|project-root|resource-root)=/u.test(argument)) continue;
    filtered.push(argument);
  }
  const options = [
    'run',
    '--rm',
    '-i',
    '--network',
    'host',
    '--user',
    userIdentity(),
    '--mount',
    `type=bind,src=${project},dst=/project`,
    '--mount',
    `type=bind,src=${state.controlRoot},dst=/control`,
    '--mount',
    `type=bind,src=${state.extensionRoot},dst=/extensions,readonly`,
    '--mount',
    `type=bind,src=${state.adbHome},dst=/adb-home,readonly`,
    '--env',
    'HOME=/adb-home',
    '--env',
    'PXV_CONTROL_ROOT=/control',
    '--env',
    'PXV_EXTENSION_ROOT=/extensions',
    '--env',
    `PXV_DOCKER_MODE=${mode}`,
    '--env',
    'PXV_HOST_ADB_HOST=127.0.0.1',
    '--env',
    `PXV_HOST_ADB_PORT=${mode === 'direct' ? 5038 : 5037}`,
    '--env',
    'ADB_MDNS_AUTO_CONNECT=0',
  ];
  if (mode === 'direct')
    options.push(
      '--mount',
      'type=bind,src=/dev/bus/usb,dst=/dev/bus/usb',
      '--device-cgroup-rule',
      'c 189:* rmw',
    );
  const result = await runner.run(
    ['docker', ...options, resolved, ...filtered, '--project-root', '/project'],
    { timeoutMs: 86_400_000, check: false },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}
