import { afterEach, beforeEach, describe, expect, it, vi } from '../test-api.js';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCli } from '../../packages/cli/src/arguments.js';
import { guidesRebuildCommand } from '../../packages/cli/src/guide-rebuild-command.js';
import { stdin } from 'node:process';
import { runCli, type CliIo } from '@pxv/cli';
import { toPolicyDocument, validatePhoneRegistryDocument } from '@pxv/contracts';
import {
  containedPath,
  createProject,
  loadProject,
  saveInventory,
  WorkflowEngine,
  type ProjectContext,
} from '@pxv/engine';
import { readEncryptedRegistry, SqliteStore } from '@pxv/runtime';
import { device, observation, policy, product } from '../contracts/fixtures.js';
import { oblivionUsers, syntheticOblivionKey } from '../adapters/oblivion-fixture.js';
import {
  firstNumber,
  secondNumber,
  sessionId,
  mockCollectionAndroid,
  subscriptions,
} from '../adapters/collection-fixture.js';

let root: string;
let resources: string;
let project: ProjectContext;
let passwordFile: string;
let vault: string;
let originalControl: string | undefined;
let output: string[];
let diagnostics: string[];
let prompts: string[];
let io: CliIo;
const password = 'synthetic-three-collector-passphrase';
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
  '--passphrase-file',
  passwordFile,
];
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
  root = await mkdtemp('/tmp/pxv-collectors-cli-');
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
  diagnostics = [];
  prompts = [];
  io = {
    out: (value) => output.push(value),
    error: (value) => diagnostics.push(value),
    confirm: (message) => {
      prompts.push(message);
      return Promise.resolve(true);
    },
  };
  await runCli(args('registry', 'init'), io);
  output.length = 0;
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

for (const name of ['oblivion', 'sessionid', 'simcards'] as const) {
  describe(`shared collect-${name} contract`, () => {
    const collect = (...extra: string[]) =>
      runCli(args('device', `collect-${name}`, '--asset', device.assetId, ...extra), io);
    const marker =
      name === 'oblivion' ? syntheticOblivionKey : name === 'sessionid' ? sessionId : firstNumber;
    const value = async () => {
      const record = (await snapshot()).devices[0]!;
      return name === 'simcards'
        ? record.fields.phoneNumber
        : record.profiles[0]?.fields[
            name === 'oblivion' ? 'oblivionNotificationWipeKey' : 'sessionMessengerId'
          ];
    };
    it('confirms despite --yes, saves encrypted fields and emits one sanitized JSON summary', async () => {
      const simulation = mockCollectionAndroid(name);
      expect(await collect('--yes')).toBe(0);
      const result = JSON.parse(output[0]!) as {
        collector: string;
        saved: boolean;
        revision: number;
        recordRevision: number;
        outcomes: { status: string }[];
      };
      expect(result).toMatchObject({ collector: name, saved: true, revision: 1, recordRevision: 1 });
      expect(result.outcomes.map((entry) => entry.status)).toEqual(['collected', 'collected']);
      expect(output).toHaveLength(1);
      expect(prompts.some((entry) => entry.startsWith('Confirm retention'))).toBe(true);
      expect(await value()).toMatchObject({ state: 'current' });
      expect((await value())?.value).toContain(marker);
      if (name === 'simcards') expect((await value())?.value).toBe(firstNumber + '\n' + secondNumber);
      expect(output.join('\n') + diagnostics.join('\n')).not.toContain(marker);
      expect(simulation.state.current).toBe(0);
      for (const entry of await readdir(root, { recursive: true })) {
        const path = join(root, entry);
        if ((await stat(path)).isFile()) expect((await readFile(path)).includes(marker)).toBe(false);
      }
    });
    it('leaves ciphertext unchanged when retention is cancelled', async () => {
      mockCollectionAndroid(name);
      const before = await readFile(vault);
      io.confirm = (message) => Promise.resolve(!message.startsWith('Confirm retention'));
      await expect(collect('--yes')).rejects.toThrow('cancelled');
      expect(await readFile(vault)).toEqual(before);
      expect(output).toEqual([]);
    });
    it('does not update or prompt when nothing is present', async () => {
      const simulation = mockCollectionAndroid(name);
      if (name === 'simcards') simulation.state.subscriptions = 'Active subscriptions:\nAll subscriptions:\n';
      else simulation.state.absent.add(0).add(10);
      const before = await readFile(vault);
      expect(await collect()).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({ saved: false, revision: 0, recordRevision: 0 });
      expect(prompts).toEqual([]);
      expect(await readFile(vault)).toEqual(before);
    });
    it('rejects fleet selectors, Docker and noninteractive confirmations before device access', async () => {
      const simulation = mockCollectionAndroid(name);
      await expect(collect('--all')).rejects.toThrow();
      await expect(collect('--group', 'pilot')).rejects.toThrow();
      await expect(collect('--execution', 'docker', '--image', 'test')).rejects.toThrow('local host');
      delete io.confirm;
      const saved = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
      try {
        Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
        await expect(collect('--yes')).rejects.toThrow('interactive confirmation');
      } finally {
        if (saved) Object.defineProperty(stdin, 'isTTY', saved);
        else Reflect.deleteProperty(stdin, 'isTTY');
      }
      expect(simulation.shell).not.toHaveBeenCalled();
    });
    it('supports private manual entry, sanitized validation and explicit skips', async () => {
      const simulation = mockCollectionAndroid(name);
      if (name === 'simcards') simulation.state.subscriptions = subscriptions('[masked]', '[masked]');
      else simulation.state.failRead = true;
      const invalid = 'INVALID-PRIVATE-VALUE-DO-NOT-ECHO';
      let attempts = 0;
      io.privateInput = () =>
        Promise.resolve(attempts++ === 0 ? (name === 'oblivion' ? invalid + ' ' : invalid) : marker);
      await collect('--yes');
      expect((await value())?.value).toBe(marker);
      expect((await value())?.source).toContain('private');
      expect(output.join('\n') + diagnostics.join('\n')).not.toContain(invalid);
      expect(output.join('\n') + diagnostics.join('\n')).not.toContain(marker);
      const before = await readFile(vault);
      output.length = 0;
      io.privateInput = () => Promise.resolve(undefined);
      await collect();
      expect(JSON.parse(output[0]!)).toMatchObject({ saved: false });
      expect(await readFile(vault)).toEqual(before);
    });
    it('revalidates app or SIM identity after confirmation and prevents partial commits', async () => {
      const simulation = mockCollectionAndroid(name);
      const before = await readFile(vault);
      io.confirm = (message) => {
        if (message.startsWith('Confirm retention')) {
          if (name === 'simcards') simulation.state.subscriptions = subscriptions().replace('id=2', 'id=4');
          else simulation.state.signer = 'f'.repeat(64);
        }
        return Promise.resolve(true);
      };
      await expect(collect()).rejects.toThrow('Encrypted registry');
      expect(await readFile(vault)).toEqual(before);
      expect(output).toEqual([]);
    });
  });
}

it('collects multiple privately entered SIM numbers when the subscription format is unsupported', async () => {
  const simulation = mockCollectionAndroid('simcards');
  simulation.state.subscriptions = 'Unsupported subscription format';
  const entries = [firstNumber, secondNumber, undefined];
  io.privateInput = () => Promise.resolve(entries.shift());
  await runCli(args('device', 'collect-simcards', '--asset', device.assetId), io);
  expect((await snapshot()).devices[0]?.fields.phoneNumber?.value).toBe(firstNumber + '\n' + secondNumber);
  expect(output.join('\n') + diagnostics.join('\n')).not.toContain(firstNumber);
});

describe('collected registry values in both private insert entry points', () => {
  it('exports collected values in EN/PL and forwards only public policy options to guide publishing', async (test) => {
    const chromium = process.env['PXV_CHROMIUM'];
    if (!chromium) {
      test.skip('Set PXV_CHROMIUM for real private PDF integration');
      return;
    }
    for (const name of ['oblivion', 'sessionid', 'simcards'] as const) {
      mockCollectionAndroid(name);
      await runCli(args('device', `collect-${name}`, '--asset', device.assetId), io);
      vi.restoreAllMocks();
      vi.spyOn(WorkflowEngine.prototype, 'observe').mockImplementation(() =>
        Promise.resolve(structuredClone(live)),
      );
    }
    const saved = (await snapshot()).devices[0]!;
    expect(saved.revision).toBe(3);
    expect(saved.fields.phoneNumber?.value).toBe(firstNumber + '\n' + secondNumber);
    expect(saved.profiles[0]?.fields.sessionMessengerId?.value).toBe(sessionId);
    expect(saved.profiles[0]?.fields.oblivionNotificationWipeKey?.value).toContain(syntheticOblivionKey);
    const metadata = {
      projectName: 'Flota Zażółć',
      support: { name: 'Project Support', phone: '+48 123 456' },
    };
    await writeFile(
      join(project.root, 'pxv.project.json'),
      JSON.stringify({ ...project.config, insertMetadata: metadata }),
    );
    const standalone = join(project.root, 'secrets', 'standalone.pdf');
    await runCli(
      args(
        'registry',
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        standalone,
        '--chromium',
        chromium,
      ),
      io,
    );
    const calls: string[][] = [];
    const guideOutput = join(root, 'shared-guides');
    const privateOutput = join(project.root, 'secrets', 'guide-insert.pdf');
    const context = await parseCli(
      args(
        'guides',
        'rebuild',
        '--asset',
        device.assetId,
        '--private-insert-output',
        privateOutput,
        '--output-dir',
        guideOutput,
        '--chromium',
        chromium,
        '--locale',
        'pl',
      ),
      io,
    );
    await guidesRebuildCommand(context, {
      execute: (_command, forwarded) => {
        calls.push(forwarded);
        return Promise.resolve();
      },
    });
    expect(calls[1]).toContain(await containedPath(project.root, project.config.policyFile));
    for (const privateArgument of [
      '--private-insert-output',
      '--passphrase-file',
      '--asset',
      '--locale',
      privateOutput,
      passwordFile,
    ])
      expect(calls[1]).not.toContain(privateArgument);
    for (const path of [standalone, privateOutput]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' }).replace(/\s+/gu, '');
      for (const marker of [firstNumber, secondNumber, sessionId, syntheticOblivionKey + '-0'])
        expect(text).toContain(marker);
      expect(text).toContain(metadata.projectName.replace(/\s/gu, ''));
      expect(text).toContain('ProjectSupport:+48123456');
      expect(text).not.toContain(product.support.email);
    }
    const publicText = output.join('\n') + diagnostics.join('\n') + JSON.stringify(calls);
    for (const marker of [firstNumber, sessionId, syntheticOblivionKey])
      expect(publicText).not.toContain(marker);
  }, 60_000);

  it('rejects missing private-build requirements and public output destinations before publishing', async () => {
    const base = [
      'guides',
      'rebuild',
      '--private-insert-output',
      join(project.root, 'secrets', 'insert.pdf'),
      '--asset',
      device.assetId,
      '--output-dir',
      join(root, 'guides'),
      '--chromium',
      '/local/chromium',
    ];
    const execute = vi.fn(() => Promise.resolve());
    const invalid = [
      [...base, '--policy', join(project.root, project.config.policyFile)],
      [...base, '--html-only'],
      [...base, '--locale', 'de'],
      base.filter((value, index) => value !== '--asset' && base[index - 1] !== '--asset'),
      base.filter((value, index) => value !== '--output-dir' && base[index - 1] !== '--output-dir'),
      base.map((value) =>
        value === join(project.root, 'secrets', 'insert.pdf') ? join(root, 'guides', 'private.pdf') : value,
      ),
    ];
    for (const input of invalid) {
      const context = await parseCli(args(...input), io);
      await expect(guidesRebuildCommand(context, { execute })).rejects.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects every private guide scope and path guard before starting the publisher', async () => {
    const base = await parseCli(
      args(
        'guides',
        'rebuild',
        '--asset',
        device.assetId,
        '--private-insert-output',
        join(project.root, 'secrets/insert.pdf'),
        '--output-dir',
        join(root, 'guides'),
        '--chromium',
        '/local/chromium',
      ),
      io,
    );
    const alias = join(root, 'shared-alias');
    await symlink(join(project.root, 'secrets'), alias);
    const blocker = join(root, 'regular-file');
    await writeFile(blocker, 'not a directory');
    const invalid: Record<string, unknown>[] = [
      { all: true },
      { group: 'pilot' },
      { execution: 'docker' },
      { asset: 'not-enrolled' },
      { 'private-insert-output': join(root, 'private.txt') },
      { 'private-insert-output': join(project.root, 'public.pdf') },
      { 'private-insert-output': join(resources, 'private.pdf') },
      { 'output-dir': alias },
      { 'private-insert-output': join(blocker, 'private.pdf') },
      { 'project-root': undefined },
      { chromium: '' },
    ];
    const savedChromium = process.env['PXV_CHROMIUM'];
    delete process.env['PXV_CHROMIUM'];
    const published: Record<string, unknown>[] = [];
    try {
      for (const patch of invalid) {
        const values = { ...base.values, ...patch };
        const context = {
          ...base,
          values,
          flag: (name: Parameters<typeof base.flag>[0]) => values[name] === true,
          value: (name: Parameters<typeof base.value>[0], fallback?: string) =>
            typeof values[name] === 'string' ? values[name] : (fallback ?? ''),
        };
        const execute = vi.fn(() => Promise.resolve());
        await expect(guidesRebuildCommand(context, { execute })).rejects.toThrow();
        if (execute.mock.calls.length) published.push(patch);
      }
      expect(published).toEqual([]);
      for (const name of ['asset', 'passphrase-file', 'locale']) {
        const values = { [name]: 'unexpected-private-option' };
        const execute = vi.fn(() => Promise.resolve());
        await expect(guidesRebuildCommand({ ...base, values }, { execute })).rejects.toThrow(
          'require --private-insert-output',
        );
        expect(execute).not.toHaveBeenCalled();
      }
      const execute = vi.fn(() => Promise.resolve());
      await expect(guidesRebuildCommand({ ...base, dockerMode: 'direct' }, { execute })).rejects.toThrow(
        'local host',
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (savedChromium === undefined) delete process.env['PXV_CHROMIUM'];
      else process.env['PXV_CHROMIUM'] = savedChromium;
    }
  });
});
