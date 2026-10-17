import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeedvaultAdapter } from '@pxv/adapters';
import type { SeedvaultInspection, RecoveryObligation } from '@pxv/contracts';
import type { ExecutionContext, SeedvaultWorkflowPort } from '@pxv/engine';
import type * as EngineModule from '@pxv/engine';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';
import { seedvaultCommand } from '../../packages/cli/src/seedvault-command.js';
import { createSeedvaultPort } from '../../packages/cli/src/seedvault-port.js';
import { createWorkflowPort } from '../../packages/cli/src/workflow-port.js';
import type { ApplicationDependencies } from '../../packages/cli/src/dependencies.js';
import { device, product } from '../contracts/fixtures.js';
type SeedvaultExecutionContext = Parameters<SeedvaultWorkflowPort['executeProfile']>[3];

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connections: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@pxv/engine', async (original) => ({
  ...(await original<typeof EngineModule>()),
  connectSeedvaultEndpoint: mocks.connect,
  seedvaultConnections: mocks.connections,
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: mocks.question, close: mocks.close }),
}));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalTTY) Object.defineProperty(stdin, 'isTTY', originalTTY);
  else Reflect.deleteProperty(stdin, 'isTTY');
  await rm(root, { recursive: true, force: true });
});

describe('Seedvault command routing', () => {
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
