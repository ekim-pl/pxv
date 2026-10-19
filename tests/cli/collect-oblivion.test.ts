import { beforeEach, afterEach, describe, expect, it, vi } from '../test-api.js';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { toPolicyDocument, validatePhoneRegistryDocument } from '@pxv/contracts';
import {
  createProject,
  saveInventory,
  loadProject,
  WorkflowEngine,
  invalidateRegistryBindings,
  type ProjectContext,
} from '@pxv/engine';
import { readEncryptedRegistry, writeEncryptedRegistry, SqliteStore } from '@pxv/runtime';
import { stdin, stderr } from 'node:process';
import { runCli, type CliIo } from '@pxv/cli';
import { collectOblivionCommand } from '../../packages/cli/src/collect-oblivion-command.js';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';
import { device, observation, policy, product, obligation } from '../contracts/fixtures.js';
import { mockOblivionAndroid, oblivionUsers, syntheticOblivionKey } from '../adapters/oblivion-fixture.js';

let root: string;
let resources: string;
let project: ProjectContext;
let passwordFile: string;
let vault: string;
let originalControl: string | undefined;
let output: string[];
let prompts: string[];
let io: CliIo;
let simulation: ReturnType<typeof mockOblivionAndroid>;
const password = 'synthetic-collection-registry-password';
const live = structuredClone(observation);
live.profiles.push({
  ...structuredClone(observation.profiles[0]!),
  profileId: 'work',
  user: oblivionUsers[1]!,
});
const args = (...values: string[]) => [
  ...values,
  '--json',
  '--project-root',
  project.root,
  '--resource-root',
  resources,
];
const collect = (...extra: string[]) =>
  runCli(
    args(
      'device',
      'collect-oblivion',
      '--asset',
      device.assetId,
      '--passphrase-file',
      passwordFile,
      ...extra,
    ),
    io,
  );
const snapshot = async () =>
  (
    await readEncryptedRegistry(
      vault,
      project.config.id,
      Buffer.from(password),
      validatePhoneRegistryDocument,
    )
  ).value;

beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-oblivion-cli-');
  originalControl = process.env['PXV_CONTROL_ROOT'];
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  resources = join(root, 'resources');
  await mkdir(resources, { mode: 0o700 });
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  const selectedPolicy = structuredClone(policy);
  selectedPolicy.profiles.push({
    ...structuredClone(policy.profiles[0]!),
    id: 'work',
    name: 'Work',
    kind: 'secondary',
  });
  const created = await createProject(
    join(root, 'project'),
    product,
    toPolicyDocument(selectedPolicy),
    resources,
  );
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  project = await loadProject(created.root, product, resources);
  const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
  await store.set('workflow', device.assetId, { observation: live });
  await store.close();
  passwordFile = join(root, 'password');
  vault = join(project.root, 'secrets/phone-registry.pxv');
  await writeFile(passwordFile, password, { mode: 0o600 });
  output = [];
  prompts = [];
  io = {
    out: (value) => output.push(value),
    error: (value) => output.push(value),
    confirm: (message) => {
      prompts.push(message);
      return Promise.resolve(true);
    },
  };
  await runCli(args('registry', 'init', '--passphrase-file', passwordFile), io);
  output.length = 0;
  simulation = mockOblivionAndroid();
  vi.spyOn(WorkflowEngine.prototype, 'observe').mockImplementation(() =>
    Promise.resolve(structuredClone(live)),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalControl === undefined) delete process.env['PXV_CONTROL_ROOT'];
  else process.env['PXV_CONTROL_ROOT'] = originalControl;
  await rm(root, { recursive: true, force: true });
});

describe('opt-in Oblivion collection command', () => {
  it('collects all enrolled profiles, confirms explicitly and retains only encrypted keys on disk', async () => {
    expect(await collect('--yes')).toBe(0);
    expect(prompts).toHaveLength(3);
    const saved = await snapshot();
    expect(
      saved.devices[0]?.profiles.map((entry) => entry.fields.oblivionNotificationWipeKey?.value),
    ).toEqual([syntheticOblivionKey + '-0', syntheticOblivionKey + '-10']);
    expect(saved.devices[0]?.profiles[0]?.fields.oblivionNotificationWipeKey?.state).toBe('current');
    expect(output.join('\n')).not.toContain(syntheticOblivionKey);
    expect(simulation.state.current).toBe(0);
    await assertPrivateArtifacts();
  });

  it('preserves prior ciphertext and confirms despite --yes when the operator declines retention', async () => {
    const before = await readFile(vault);
    io.confirm = (message) => {
      prompts.push(message);
      return Promise.resolve(!message.startsWith('Confirm retention'));
    };
    await expect(collect('--yes')).rejects.toThrow('cancelled');
    expect(prompts).toHaveLength(3);
    expect(await readFile(vault)).toEqual(before);
    expect(simulation.state.current).toBe(0);
    expect(output.join('\n')).not.toContain(syntheticOblivionKey);
  });

  it('merges repeated collection without losing previous values or encrypted history', async () => {
    expect(
      await runCli(
        args(
          'device',
          'collect-oblivion',
          '--asset',
          device.assetId,
          '--passphrase-file',
          passwordFile,
        ).filter((value) => value !== '--json'),
        io,
      ),
    ).toBe(0);
    simulation.state.absent.add(10);
    expect(await collect()).toBe(0);
    const saved = await snapshot();
    expect(saved.revision).toBe(2);
    expect(saved.history).toHaveLength(2);
    expect(saved.devices[0]?.profiles[1]).toEqual(saved.history[0]?.record.profiles[1]);
    expect(output.join('\n')).toContain('not-present');
  });

  it('aborts without a commit when the signer or enrolled Android identity changes', async () => {
    const before = await readFile(vault);
    simulation.state.signer = 'f'.repeat(64);
    await expect(collect()).rejects.toThrow('collection failed');
    expect(await readFile(vault)).toEqual(before);
    simulation.state.users[0]!.serialNo = 99;
    await expect(collect()).rejects.toThrow();
    expect(await readFile(vault)).toEqual(before);
    await assertPrivateArtifacts();
  });

  it('retains a recoverable foreground obligation on failure and supports device recover', async () => {
    simulation.state.failRestore = true;
    const before = await readFile(vault);
    await expect(collect()).rejects.toThrow('requires inspection');
    expect(await readFile(vault)).toEqual(before);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    const obligations = await store.get<{ operationId: string; status: string }[]>(
      'obligations',
      device.canonicalSerial,
    );
    await store.close();
    const pending = obligations?.find((entry) => entry.status === 'pending');
    expect(pending).toBeDefined();
    simulation.state.failRestore = false;
    expect(
      await runCli(
        args(
          'device',
          'recover',
          '--asset',
          device.assetId,
          '--run',
          pending!.operationId,
          '--inspected',
          '--yes',
        ),
        io,
      ),
    ).toBe(0);
    expect(simulation.state.current).toBe(0);
    await assertPrivateArtifacts();
  });

  it('rejects fleet selection and Docker before opening a device or registry', async () => {
    await expect(collect('--all')).rejects.toThrow();
    await expect(collect('--group', 'pilot')).rejects.toThrow();
    await expect(collect('--execution', 'docker', '--image', 'test')).rejects.toThrow('local host');
    expect(simulation.shell).not.toHaveBeenCalled();
  });

  it('does not write when no enrolled profile has the app', async () => {
    const before = await readFile(vault);
    simulation.state.absent.add(0).add(10);
    expect(await collect()).toBe(0);
    expect(prompts).toEqual([]);
    expect(await readFile(vault)).toEqual(before);
  });

  it('requires current complete enrolled profile observations', async () => {
    const before = await readFile(vault);
    vi.spyOn(WorkflowEngine.prototype, 'observe').mockResolvedValue({
      ...live,
      profiles: [live.profiles[0]!],
    });
    await expect(collect()).rejects.toThrow('Every enrolled policy profile');
    const changed = structuredClone(live);
    changed.profiles[0]!.user.serialNo++;
    vi.spyOn(WorkflowEngine.prototype, 'observe').mockResolvedValue(changed);
    await expect(collect()).rejects.toThrow('Current enrolled Android profile');
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    await store.delete('workflow', device.assetId);
    await store.close();
    await expect(collect()).rejects.toThrow('Current enrolled Android profile');
    expect(await readFile(vault)).toEqual(before);
  });

  it('refuses another operation’s unresolved resources before inspecting profiles', async () => {
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    await store.set('obligations', device.canonicalSerial, [
      { ...obligation, deviceSerial: device.canonicalSerial },
    ]);
    await store.close();
    await expect(collect()).rejects.toThrow('unresolved recovery');
    expect(simulation.shell).not.toHaveBeenCalled();
  });

  it('rechecks app identity and registry generation after the retention confirmation', async () => {
    const before = await readFile(vault);
    io.confirm = (message) => {
      if (message.startsWith('Confirm retention')) simulation.state.signer = 'f'.repeat(64);
      return Promise.resolve(true);
    };
    await expect(collect()).rejects.toThrow('Encrypted registry');
    expect(await readFile(vault)).toEqual(before);
    simulation.state.signer = 'cc7ea11578ca4339997b0473118ec8c83ed6046834a7b684acf08b174e21ea98';
    io.confirm = async (message) => {
      if (message.startsWith('Confirm retention')) {
        const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
        try {
          await invalidateRegistryBindings(store, device);
        } finally {
          await store.close();
        }
      }
      return true;
    };
    await expect(collect()).rejects.toThrow('Encrypted registry');
    expect(await readFile(vault)).toEqual(before);
  });

  it('refuses noninteractive capture even with --yes and requires both terminal streams', async () => {
    delete io.confirm;
    const savedInput = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
    const savedOutput = Object.getOwnPropertyDescriptor(stderr, 'isTTY');
    try {
      Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
      await expect(collect('--yes')).rejects.toThrow('interactive confirmation');
      Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(stderr, 'isTTY', { value: false, configurable: true });
      await expect(collect('--yes')).rejects.toThrow('interactive confirmation');
    } finally {
      if (savedInput) Object.defineProperty(stdin, 'isTTY', savedInput);
      else Reflect.deleteProperty(stdin, 'isTTY');
      if (savedOutput) Object.defineProperty(stderr, 'isTTY', savedOutput);
      else Reflect.deleteProperty(stderr, 'isTTY');
    }
    expect(simulation.shell).not.toHaveBeenCalled();
  });

  it('refuses cross-project plaintext even inside an authenticated envelope', async () => {
    const current = await readEncryptedRegistry(
      vault,
      project.config.id,
      Buffer.from(password),
      validatePhoneRegistryDocument,
    );
    await writeEncryptedRegistry(
      vault,
      project.config.id,
      Buffer.from(password),
      { ...current.value, projectId: 'different-project' },
      current.revision,
    );
    await expect(collect()).rejects.toThrow('Registry project identity');
    expect(simulation.shell).not.toHaveBeenCalled();
  });

  it('defends exact Pixel and local-host scope even when called outside the CLI parser', async () => {
    const context = {
      section: 'device',
      values: {},
      flag: () => false,
      value: () => 'host',
    } as unknown as ApplicationCliContext;
    const target = { device, transport: device.transports[0]! };
    await expect(collectOblivionCommand({ ...context, section: 'fleet' }, target)).rejects.toThrow(
      'exact enrolled Pixel',
    );
    await expect(collectOblivionCommand({ ...context, flag: () => true }, target)).rejects.toThrow(
      'exact enrolled Pixel',
    );
    await expect(collectOblivionCommand({ ...context, values: { group: 'pilot' } }, target)).rejects.toThrow(
      'exact enrolled Pixel',
    );
    await expect(
      collectOblivionCommand(context, { ...target, device: { ...device, kind: 'emulator' } }),
    ).rejects.toThrow('exact enrolled Pixel');
    await expect(collectOblivionCommand({ ...context, dockerMode: 'direct' }, target)).rejects.toThrow(
      'local host',
    );
    await expect(collectOblivionCommand({ ...context, value: () => 'docker' }, target)).rejects.toThrow(
      'local host',
    );
  });
});

async function assertPrivateArtifacts() {
  for (const base of [join(root, 'control'), project.root]) {
    for (const entry of await readdir(base, { recursive: true })) {
      const path = join(base, entry);
      if (!(await stat(path)).isFile()) continue;
      expect((await readFile(path)).includes(syntheticOblivionKey)).toBe(false);
      expect(path).not.toMatch(/\.(?:png|jpe?g)$/i);
    }
  }
}
