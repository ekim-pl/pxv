import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:path';
import type * as TestModule2 from 'node:process';
import type * as TestModule3 from '@pxv/adapters';
import type * as TestModule4 from '../../packages/cli/src/seedvault-command.js';
import type * as TestModule5 from '../../packages/cli/src/seedvault-port.js';
import type * as TestModule6 from '../../packages/cli/src/workflow-port.js';
import type * as TestModule7 from '../contracts/fixtures.js';
import type * as ConnectionModule from '../../packages/engine/src/seedvault-connection.js';
import type * as RuntimeModule from '@pxv/runtime';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;

import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';

import type { SeedvaultInspection, RecoveryObligation } from '@pxv/contracts';
import type { ExecutionContext, SeedvaultWorkflowPort } from '@pxv/engine';
import type * as EngineModule from '@pxv/engine';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';

import type { ApplicationDependencies } from '../../packages/cli/src/dependencies.js';
import { basePolicy } from '../engine/fixtures.js';
import { toPolicyDocument } from '@pxv/contracts';

type SeedvaultExecutionContext = Parameters<SeedvaultWorkflowPort['executeProfile']>[3];

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connections: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  approval: vi.fn(),
}));
vi.mock('@pxv/engine', async (original) => ({
  ...(await original<typeof EngineModule>()),
  connectSeedvaultEndpoint: mocks.connect,
  seedvaultConnections: mocks.connections,
  assertApprovedProject: mocks.approval,
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: mocks.question, close: mocks.close }),
}));
// Module exports are called without a receiver.

const { mkdtemp, mkdir, rm, writeFile } = await importModule<typeof TestModule0>(
  'node:fs/promises',
  import.meta.url,
);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join } = await importModule<typeof TestModule1>('node:path', import.meta.url);
// Module exports are called without a receiver.

const { stdin } = await importModule<typeof TestModule2>('node:process', import.meta.url);
// Module exports are called without a receiver.

const { SeedvaultAdapter } = await importModule<typeof TestModule3>('@pxv/adapters', import.meta.url);
// Module exports are called without a receiver.

const { seedvaultCommand } = await importModule<typeof TestModule4>(
  '../../packages/cli/src/seedvault-command.js',
  import.meta.url,
);
// Module exports are called without a receiver.

const { createSeedvaultPort } = await importModule<typeof TestModule5>(
  '../../packages/cli/src/seedvault-port.js',
  import.meta.url,
);
// Module exports are called without a receiver.

const { createWorkflowPort } = await importModule<typeof TestModule6>(
  '../../packages/cli/src/workflow-port.js',
  import.meta.url,
);
// Module exports are called without a receiver.

const { device, product } = await importModule<typeof TestModule7>(
  '../contracts/fixtures.js',
  import.meta.url,
);
const { createProject, loadProject, saveInventory, writePolicyLock } = await importModule<
  typeof EngineModule
>('@pxv/engine', import.meta.url);
const { connectSeedvaultEndpoint: actualConnect } = await importModule<typeof ConnectionModule>(
  '../../packages/engine/src/seedvault-connection.js',
  import.meta.url,
);
const { SqliteStore, CommandRunner } = await importModule<typeof RuntimeModule>(
  '@pxv/runtime',
  import.meta.url,
);

const target = { device, transport: device.transports[0]! };
const source = {
  profileId: 'owner',
  token: 'abc',
  selector: { resourceId: 'com.stevesoltys.seedvault:id/snapshot', text: 'Owner snapshot' },
  filesSelector: { resourceId: 'com.stevesoltys.seedvault:id/files_snapshot', text: 'Owner files snapshot' },
};
let root: string;
const originalTTY = Object.getOwnPropertyDescriptor(stdin, 'isTTY');

function context(command: string, values: Record<string, unknown> = {}) {
  const engine = {
    controlRoot: '/fixture/control',
    inspectSeedvault: vi.fn().mockResolvedValue({ profiles: [] }),
    seedvaultReport: vi.fn().mockResolvedValue({ status: 'completed' }),
    prepareSeedvault: vi.fn().mockResolvedValue({
      plan: { id: 'plan' },
      reviewSummary: 'exact bytes',
      expiresAt: '2026-10-16T18:00:00Z',
    }),
    submit: vi.fn().mockResolvedValue({ id: 'run' }),
    execute: vi.fn().mockResolvedValue({ id: 'run', status: 'completed' }),
  };
  const output = vi.fn();
  const targets = vi.fn(() => [target]);
  const confirm = vi.fn().mockResolvedValue(true);
  const ctx = {
    product,
    section: 'seedvault',
    command,
    values,
    app: { engine, android: {} },
    project: {},
    targets,
    signal: new AbortController().signal,
    io: { out: vi.fn(), error: vi.fn(), confirm },
    output,
    flag: (name: string) => values[name] === true,
    value: (name: string, fallback?: string) => {
      if (typeof values[name] === 'string') return values[name];
      if (fallback !== undefined) return fallback;
      throw new Error(`--${name} is required`);
    },
  } as unknown as ApplicationCliContext;
  return { ctx, engine, output, targets, confirm };
}
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-seedvault-cli-');
  mocks.connect.mockReset().mockResolvedValue({ connected: true });
  mocks.connections.mockReset().mockResolvedValue([]);
  mocks.question.mockReset().mockResolvedValue('123456');
  mocks.close.mockReset();
  mocks.approval.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalTTY) Object.defineProperty(stdin, 'isTTY', originalTTY);
  else Reflect.deleteProperty(stdin, 'isTTY');
  await rm(root, { recursive: true, force: true });
});

describe('Seedvault command routing', () => {
  it.each(['deleted', 'corrupt', 'replaced', 'changed-and-renewed'])(
    'rechecks real project ownership after the private pairing prompt: %s',
    async (fault) => {
      const code = join(root, 'resources');
      await mkdir(code);
      await writeFile(join(code, 'product.json'), JSON.stringify(product));
      const created = await createProject(
        join(root, 'project'),
        product,
        toPolicyDocument(basePolicy()),
        code,
      );
      await saveInventory(created, { schemaVersion: 1, devices: [device] });
      const project = await loadProject(created.root, product, code);
      await writePolicyLock(project);
      const store = await SqliteStore.open(join(root, 'state.sqlite'));
      const lock = join(project.root, 'policy.lock.json');
      mocks.approval.mockImplementation(async () => {
        // This real preflight precedes the mocked terminal question.
        const { assertApprovedProject } = await import('../../packages/engine/src/policy-lock.js');
        await assertApprovedProject(project);
      });
      mocks.connect.mockImplementation(actualConnect);
      mocks.question.mockImplementation(async () => {
        if (fault === 'deleted') await rm(lock);
        else if (fault === 'corrupt') await writeFile(lock, '{invalid');
        else if (fault === 'replaced')
          await writeFile(lock, JSON.stringify({ ...project.resolved, digest: 'a'.repeat(64) }));
        else {
          await writeFile(
            join(project.root, project.config.policyFile),
            JSON.stringify(toPolicyDocument({ ...project.policy, name: 'Changed baseline' })),
          );
          await writePolicyLock(await loadProject(project.root, product, code));
        }
        return '123456';
      });
      Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true });
      const command = vi.spyOn(CommandRunner.prototype, 'run');
      const f = context('connect', {
        endpoint: '192.0.2.10:39111',
        'pair-endpoint': '192.0.2.10:39112',
        yes: true,
      });
      f.ctx.project = project;
      f.ctx.app = {
        ...f.ctx.app,
        store,
        engine: { ...f.ctx.app.engine, controlRoot: join(root, 'control') },
      } as ApplicationCliContext['app'];
      try {
        await expect(seedvaultCommand(f.ctx)).rejects.toThrow(
          fault === 'changed-and-renewed' ? 'Project source changed' : 'explicitly renew policy lock',
        );
        expect(mocks.question).toHaveBeenCalledTimes(1);
        expect(command).not.toHaveBeenCalled();
        expect(await store.entries('seedvault-connections')).toEqual([]);
      } finally {
        await store.close();
      }
    },
  );
  it('checks approval before dry-run output or requesting a private pairing code', async () => {
    mocks.approval.mockRejectedValue(new Error('Policy lock is missing'));
    for (const flags of [
      { endpoint: '192.0.2.10:39111', 'dry-run': true },
      { endpoint: '192.0.2.10:39111', 'pair-endpoint': '192.0.2.10:39112', yes: true },
    ])
      await expect(seedvaultCommand(context('connect', flags).ctx)).rejects.toThrow('Policy lock is missing');
    expect(mocks.question).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('keeps historical reports accessible while refusing new optional recovery operations', async () => {
    const backup = context('backup');
    backup.ctx.product = { ...product, features: { extensions: false, seedvault: false } };
    await expect(seedvaultCommand(backup.ctx)).rejects.toThrow('optional experimental recovery');
    expect(backup.engine.prepareSeedvault).not.toHaveBeenCalled();
    const report = context('report', { run: 'retained-run' });
    report.ctx.product = backup.ctx.product;
    expect(await seedvaultCommand(report.ctx)).toBe(0);
    expect(report.engine.seedvaultReport).toHaveBeenCalledWith('retained-run');
  });
  it('reports exact runs without requiring device selection and inspects a selected device', async () => {
    const report = context('report', { run: 'recorded-run' });
    expect(await seedvaultCommand(report.ctx)).toBe(0);
    expect(report.engine.seedvaultReport).toHaveBeenCalledWith('recorded-run');
    expect(report.targets).not.toHaveBeenCalled();
    const inspect = context('inspect');
    expect(await seedvaultCommand(inspect.ctx)).toBe(0);
    expect(inspect.engine.inspectSeedvault).toHaveBeenCalledWith(target, inspect.ctx.signal);
  });
  it('rejects unknown commands and fleet, group or ambiguous device selection', async () => {
    await expect(seedvaultCommand(context('unknown').ctx)).rejects.toThrow('Choose seedvault');
    for (const values of [{ all: true }, { group: 'fleet' }])
      await expect(seedvaultCommand(context('inspect', values).ctx)).rejects.toThrow('exact device');
    const f = context('inspect');
    f.targets.mockReturnValue([]);
    await expect(seedvaultCommand(f.ctx)).rejects.toThrow('one enrolled');
  });
  it('prepares one structured review, submits its unchanged bytes, and uses returned status', async () => {
    const dry = context('backup', { 'dry-run': true });
    expect(await seedvaultCommand(dry.ctx)).toBe(0);
    expect(dry.engine.prepareSeedvault).toHaveBeenCalledWith(target, { operation: 'backup' }, dry.ctx.signal);
    expect(dry.engine.submit).not.toHaveBeenCalled();
    const f = context('backup', { operator: 'Owner' });
    f.engine.execute.mockResolvedValue({ id: 'run', status: 'pending' });
    expect(await seedvaultCommand(f.ctx)).toBe(4);
    expect(f.engine.submit).toHaveBeenCalledWith('plan', 'exact bytes', 'Owner');
    expect(f.engine.execute).toHaveBeenCalledWith('run', f.ctx.signal);
    f.confirm.mockResolvedValue(false);
    await expect(seedvaultCommand(f.ctx)).rejects.toThrow('Cancelled');
    const defaults = context('backup', { yes: true });
    vi.stubEnv('USER', undefined);
    expect(await seedvaultCommand(defaults.ctx)).toBe(0);
    expect(defaults.engine.submit).toHaveBeenCalledWith('plan', 'exact bytes', 'owner');
  });
  it('validates request documents and source mappings without silently changing operation', async () => {
    const file = join(root, 'request.json');
    await writeFile(file, JSON.stringify({ operation: 'restore', sources: [source] }));
    const restore = context('restore', { file, 'dry-run': true });
    expect(await seedvaultCommand(restore.ctx)).toBe(0);
    expect(restore.engine.prepareSeedvault).toHaveBeenCalledWith(
      target,
      { operation: 'restore', sources: [source] },
      restore.ctx.signal,
    );
    await expect(seedvaultCommand(context('backup', { file }).ctx)).rejects.toThrow('differs');
    await writeFile(file, '[]');
    await expect(seedvaultCommand(context('backup', { file }).ctx)).rejects.toThrow('object');
    await expect(seedvaultCommand(context('restore').ctx)).rejects.toThrow('explicit');
  });
  it('loads externally reviewed adapter pins and resolves acceptance relative to that file', async () => {
    const selector = { resourceId: 'com.stevesoltys.seedvault:id/status' };
    const completion = {
      apps: selector,
      files: selector,
      idle: selector,
      finalized: selector,
      generation: selector,
      fileGeneration: selector,
    };
    const adapter = {
      schemaVersion: 1,
      id: 'fixture-only',
      buildFingerprint: 'fixture/build',
      package: { packageId: 'com.stevesoltys.seedvault', versionCode: 123, signerSha256: 'a'.repeat(64) },
      acceptance: { path: 'acceptance.json', sha256: 'b'.repeat(64) },
      activities: ['.settings.SettingsActivity'],
      restoreSourceResourceId: selector.resourceId,
      restoreFileSourceResourceId: selector.resourceId,
      backup: {
        steps: [
          { action: 'start-backup', selector },
          { action: 'observe-files-running', selector },
        ],
        completion,
      },
      restore: {
        steps: [
          { action: 'select-source' },
          { action: 'start-restore', selector },
          { action: 'select-file-source' },
          { action: 'start-files-restore', selector },
          { action: 'observe-files-running', selector },
        ],
        completion,
      },
    };
    const file = join(root, 'adapter.json');
    await writeFile(file, JSON.stringify(adapter));
    const f = context('backup', { 'seedvault-adapter': file, 'dry-run': true });
    expect(await seedvaultCommand(f.ctx)).toBe(0);
    expect(f.engine.prepareSeedvault.mock.calls[0]?.[1]).toMatchObject({
      adapter: { acceptance: { path: join(root, 'acceptance.json') } },
    });
  });
});

describe('wireless connection commands', () => {
  const endpoint = '192.0.2.10:39222';
  it('reviews connection without mutation, enforces serial and validates disconnect input', async () => {
    expect(await seedvaultCommand(context('connections').ctx)).toBe(0);
    expect(mocks.connections).toHaveBeenCalled();
    expect(await seedvaultCommand(context('connect', { endpoint, 'dry-run': true }).ctx)).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
    await expect(seedvaultCommand(context('connect', { endpoint, serial: 'WRONG' }).ctx)).rejects.toThrow(
      'serial',
    );
    await expect(
      seedvaultCommand(context('disconnect', { endpoint, 'pair-endpoint': 'phone:39223' }).ctx),
    ).rejects.toThrow('cannot pair');
    expect(await seedvaultCommand(context('connect', { endpoint, yes: true }).ctx)).toBe(0);
    expect(mocks.connect.mock.calls[0]?.[2]).toEqual({ endpoint, disconnect: false });
    expect(await seedvaultCommand(context('disconnect', { endpoint, serial: 'PIXEL1' }).ctx)).toBe(0);
    expect(mocks.connect.mock.calls[1]?.[2]).toEqual({ endpoint, disconnect: true });
    await expect(seedvaultCommand(context('disconnect', { endpoint, run: 'prior' }).ctx)).rejects.toThrow(
      'requires disconnect',
    );
    await expect(
      seedvaultCommand(context('connect', { endpoint, run: 'prior', inspected: true }).ctx),
    ).rejects.toThrow('requires disconnect');
    expect(
      await seedvaultCommand(
        context('disconnect', { endpoint, run: 'prior', inspected: true, yes: true }).ctx,
      ),
    ).toBe(0);
    expect(mocks.connect.mock.calls[2]?.[2]).toMatchObject({
      endpoint,
      disconnect: true,
      recoverOperationId: 'prior',
    });
  });
  it('takes pairing code only from the terminal, never from flags or the public output', async () => {
    Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
    const f = context('connect', { endpoint, 'pair-endpoint': 'phone:39223', yes: true });
    await expect(seedvaultCommand(f.ctx)).rejects.toThrow('privately in a terminal');
    Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
    expect(await seedvaultCommand(f.ctx)).toBe(0);
    expect(mocks.connect.mock.calls[0]?.[2]).toEqual({
      endpoint,
      disconnect: false,
      pairEndpoint: 'phone:39223',
      pairingCode: '123456',
    });
    expect(JSON.stringify(f.output.mock.calls)).not.toContain('123456');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

it('lazily delegates adapter inspection and execution through the typed port', async () => {
  const inspection: SeedvaultInspection = {
    deviceSerial: 'PIXEL1',
    osFingerprint: 'build',
    foregroundUserId: 0,
    profiles: [],
    unsupportedUsers: [],
  };
  const inspect = vi.spyOn(SeedvaultAdapter.prototype, 'inspect').mockResolvedValue(inspection);
  const execute = vi
    .spyOn(SeedvaultAdapter.prototype, 'executeProfile')
    .mockResolvedValue({ status: 'manual-pending', instructions: 'unlock' });
  const port = createSeedvaultPort({ android: {} } as ApplicationDependencies);
  expect(inspect).not.toHaveBeenCalled();
  const profile = {
    profileId: 'owner',
    user: { userId: 0, serialNo: 0, name: 'Owner' },
    package: { packageId: 'com.stevesoltys.seedvault', versionCode: 1, signerSha256: 'a'.repeat(64) },
    backup: { enabled: true, transportPackage: 'com.stevesoltys.seedvault' },
    unlocked: true,
  };
  const request = { operation: 'backup' as const };
  const options = {} as SeedvaultExecutionContext;
  expect(await port.inspect(target, { profiles: [] } as never)).toEqual(inspection);
  expect(await port.executeProfile(target, profile, request, options)).toMatchObject({
    status: 'manual-pending',
  });
  expect(execute).toHaveBeenCalledWith(target, profile, request, options);
});
it('routes owned Seedvault cleanup through its typed adapter and preserves cleanup failures', async () => {
  const cleanup = vi.spyOn(SeedvaultAdapter.prototype, 'cleanup').mockResolvedValue(undefined);
  const fallback = vi.fn();
  const port = createWorkflowPort({ android: { cleanup: fallback } } as unknown as ApplicationDependencies);
  const options = { operationId: 'root:seedvault' } as ExecutionContext & { operationId: string };
  const obligation: RecoveryObligation = {
    schemaVersion: 1,
    id: 'resource',
    operationId: 'root',
    ownerOperationId: 'root:seedvault',
    deviceSerial: device.canonicalSerial,
    kind: 'seedvault-job',
    resource: 'seedvault:0',
    payload: {},
    status: 'pending',
  };
  await port.cleanup!(target, obligation, options);
  expect(cleanup).toHaveBeenCalledWith(target, obligation, options);
  cleanup.mockRejectedValueOnce(new Error('remote work remains'));
  await expect(
    port.cleanup!(target, { ...obligation, kind: 'seedvault-foreground' }, options),
  ).rejects.toThrow('remote work remains');
  expect(fallback).not.toHaveBeenCalled();
});

type SeedvaultAdapter = InstanceType<typeof SeedvaultAdapter>;
