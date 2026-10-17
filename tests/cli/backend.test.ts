import { toPolicyDocument } from '@pxv/contracts';
import { ChildProcess } from 'node:child_process';
import type * as RuntimeModule from '@pxv/runtime';
import type * as ChildProcessModule from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, loadProject, saveInventory, WorkflowEngine } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { createMcpServer } from '@pxv/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agentCommand } from '../../packages/cli/src/run-command.js';
import type { ApplicationCliContext } from '../../packages/cli/src/arguments.js';
import { agentBackend, liveAgentBackend } from '../../packages/cli/src/backend.js';
import * as Context from '../../packages/cli/src/context.js';
import { ExtensionManager } from '@pxv/extensions';
import { resolvePolicy, type ExtensionLock } from '@pxv/contracts';
import { MemoryPort, basePolicy } from '../engine/fixtures.js';
import { device, policy as setupPolicy, product } from '../contracts/fixtures.js';

const { detachedSpawn } = vi.hoisted(() => ({ detachedSpawn: vi.fn<typeof ChildProcessModule.spawn>() }));
type RunPage = Awaited<ReturnType<WorkflowEngine['listRuns']>>;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: new Proxy(actual.spawn, {
      apply(target, receiver, args: Parameters<typeof actual.spawn>) {
        if (Array.isArray(args[1]) && args[1][1] === 'internal-worker') return detachedSpawn(...args);
        return Reflect.apply<unknown, Parameters<typeof actual.spawn>, ReturnType<typeof actual.spawn>>(
          target,
          receiver,
          args,
        );
      },
    }),
  };
});
vi.mock('@pxv/runtime', async (original) => {
  const actual = await original<typeof RuntimeModule>();
  return {
    ...actual,
    commitProjectFile: vi.fn((input: RuntimeModule.ProjectFileCommit) =>
      actual.atomicWritePrivate(input.path, input.data),
    ),
  };
});
vi.mock('../../packages/cli/src/host.js', () => ({
  inspectHost: () => Promise.resolve({ supported: true }),
}));

describe('MCP/CLI backend ports and detached execution', () => {
  let root = '';
  let store: SqliteStore;
  let engine: WorkflowEngine;
  let resourceRoot: string;
  let saved: NodeJS.ProcessEnv;
  const live = (selected = engine) => {
    vi.spyOn(Context, 'application').mockResolvedValue({
      engine: selected,
      store: { close: () => Promise.resolve() },
    } as unknown as Awaited<ReturnType<typeof Context.application>>);
    return liveAgentBackend(selected.project.root, resourceRoot, 'launcher.js', true);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-backend-'));
    resourceRoot = join(root, 'resources');
    await mkdir(join(resourceRoot, 'guides/source/markdown'), { recursive: true });
    await writeFile(join(resourceRoot, 'guides/source/markdown/operator-en.md'), 'operator instructions');
    await writeFile(join(resourceRoot, 'guides/source/markdown/user-en.md'), 'recipient instructions');
    const project = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    await saveInventory(project, { schemaVersion: 1, devices: [device] });
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    engine = new WorkflowEngine({
      project: await loadProject(project.root, product),
      store,
      port: new MemoryPort(),
      artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
      controlRoot: join(root, 'control'),
    });
    saved = { ...process.env };
    detachedSpawn.mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = saved;
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('uses real engine selection, preparation, event cursors, cancellation and bundled guides', async () => {
    const backend = live();
    expect(await backend.inspectHost()).toEqual({ supported: true });
    const listed = JSON.stringify(await backend.listDevices());
    expect(listed).toContain('all');
    expect(listed).not.toContain('PIXEL1');
    expect(JSON.stringify(await backend.inspectDevice('all'))).not.toContain('PIXEL1');
    await expect(backend.inspectDevice('unknown')).rejects.toThrow('empty');
    const prepared = (await backend.prepareOperation('all', 'create-users')) as {
      planId: string;
      reviewSummary: string;
    };
    const run = await engine.submit(prepared.planId, prepared.reviewSummary, 'operator');
    await engine.event(run.id, 'fixture', { path: '/private', serial: 'PIXEL1' });
    const status = JSON.stringify(await backend.getRun(run.id, 0));
    expect(status).toContain('fixture');
    expect(status).not.toContain('/private');
    expect(status).not.toContain('PIXEL1');
    expect(JSON.stringify(await backend.listRuns())).toContain(run.id);
    expect(await backend.cancelRun(run.id)).toEqual({ requested: true, runId: run.id });
    expect(await store.get('cancellation', run.id)).toEqual({ requested: true });
    expect(await backend.guide('operator')).toBe('operator instructions');
    expect(await backend.guide('recipient')).toBe('recipient instructions');
  });

  it('requires explicit mutation capability', async () => {
    const backend = agentBackend(engine, resourceRoot, 'launcher.js', false);
    await expect(backend.executePlan('plan', 'review', 'operator')).rejects.toThrow('disabled');
    await expect(backend.cancelRun('run')).rejects.toThrow('mutations enabled');
    expect(detachedSpawn).not.toHaveBeenCalled();
    for (const action of [
      () => backend.attestDevice('all', 'operator_signoff', 'Alice'),
      () => backend.finalizeDevice('all', 'Alice', 'pl'),
      () => backend.confirmCustody('all', 'Recipient', true),
      () => backend.recoverDevice('all', 'run', true),
      () =>
        backend.recordLifecycle({
          assetId: 'all',
          type: 'maintenance',
          note: 'Visit',
          operator: 'Alice',
          confirmedErasure: false,
        }),
      () => backend.refreshReview('run'),
      () => backend.extensionInstall({ tarball: '/tmp/ext.tgz' }, true),
      () => backend.extensionUpdate('private', { package: '@private/pkg', version: '1.0.0' }, true),
      () => backend.extensionRemove('private', true),
      () => backend.extensionPolicy('private', 'policy.json', true),
      () => backend.extensionAdapter('all', 'private', 'adapter.js', {}),
      () => backend.extensionCommand('all', 'private', 'command', {}),
    ])
      await expect(action()).rejects.toThrow('disabled');
  });

  it('traverses more than 1000 retained runs through the CLI command and MCP protocol without omissions', async () => {
    const count = 1005;
    for (let index = 0; index < count; index++) {
      const id = `retained-${String(index).padStart(4, '0')}`;
      await store.set('runs', id, {
        id,
        planId: 'unavailable-plan',
        status: 'completed',
        operator: 'Operator',
        createdAt: '2026-10-17T10:00:00Z',
      });
    }
    const cliIds: string[] = [];
    let cursor: string | null = null;
    do {
      const values = { limit: '600', ...(cursor ? { cursor } : {}) };
      let page!: RunPage;
      const context = {
        command: 'runs',
        app: { engine },
        values,
        value: (key: keyof typeof values) => values[key],
        output: (value: RunPage) => {
          page = value;
        },
      } as unknown as ApplicationCliContext;
      expect(await agentCommand(context)).toBe(0);
      cliIds.push(...page.items.map((item) => item.key));
      cursor = page.nextCursor;
    } while (cursor);
    expect(cliIds).toHaveLength(count);
    expect(new Set(cliIds).size).toBe(count);

    const server = createMcpServer(agentBackend(engine, resourceRoot, 'launcher.js', false));
    const client = new Client({ name: 'paged-runs', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const mcpIds: string[] = [];
    try {
      do {
        const result = await client.callTool({
          name: 'list_runs',
          arguments: { limit: 700, ...(cursor ? { cursor } : {}) },
        });
        const content = result.content as { type: string; text: string }[];
        const page = JSON.parse(content[0]!.text) as RunPage;
        mcpIds.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor;
      } while (cursor);
      expect(mcpIds).toEqual(cliIds);
      expect(new Set(mcpIds).size).toBe(count);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('opens retained cancellation and inspected recovery without loading optional extension code', async () => {
    const backend = live();
    const recover = vi
      .spyOn(engine, 'recover')
      .mockResolvedValue({ operationId: 'retained-run', resolved: 0 });
    await store.set('runs', 'retained-run', {
      id: 'retained-run',
      planId: 'retained-plan',
      status: 'running',
      createdAt: '2026-10-17T10:00:00Z',
      operator: 'Operator',
    });
    await backend.cancelRun('retained-run');
    expect(Context.application).toHaveBeenLastCalledWith(engine.project.root, resourceRoot, false, true);
    expect(await store.get('cancellation', 'retained-run')).toEqual({ requested: true });
    await backend.recoverDevice(device.assetId, 'retained-run', true);
    expect(Context.application).toHaveBeenLastCalledWith(engine.project.root, resourceRoot, false, true);
    expect(recover).toHaveBeenCalledWith(expect.anything(), 'retained-run');
  });

  it('refuses optional extension mutations in the core product before loading trusted code', async () => {
    const core = new WorkflowEngine({
      project: {
        ...engine.project,
        product: { ...engine.project.product, features: { extensions: false, seedvault: false } },
      },
      store,
      port: engine.port,
      artifacts: engine.artifacts,
      controlRoot: engine.controlRoot,
    });
    const install = vi.spyOn(ExtensionManager.prototype, 'install');
    const backend = agentBackend(core, resourceRoot, 'launcher.js', true);
    const actions = [
      () => backend.extensionInstall({ tarball: '/not-read.tgz' }, true),
      () => backend.extensionUpdate('private', { package: '@private/pkg', version: '1.0.0' }, true),
      () => backend.extensionPolicy('private', 'policy.json', true),
      () => backend.extensionAdapter('all', 'private', 'adapter.js', {}),
      () => backend.extensionCommand('all', 'private', 'command', {}),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow('outside this core product');
    expect(install).not.toHaveBeenCalled();
    expect(await store.entries('runs')).toEqual([]);
  });

  it('uses shared engine gates for checks, handoff, custody, lifecycle and typed recovery', async () => {
    const backend = live();
    const prepared = await engine.prepare({ device, transport: { kind: 'usb', serial: 'PIXEL1' } });
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    await engine.execute(run.id);
    for (const check of ['operator_signoff', 'recipient_acceptance', 'verified_boot'])
      await backend.attestDevice('all', check, 'Alice');
    expect(await backend.finalizeDevice('all', 'Alice', 'pl')).toMatchObject({
      outcome: 'ready-for-handoff',
      locale: 'pl',
    });
    await expect(backend.confirmCustody('all', 'Recipient', false)).rejects.toThrow();
    expect(await backend.confirmCustody('all', 'Recipient', true)).toMatchObject({
      outcome: 'completed-custody',
    });
    await expect(backend.recoverDevice('all', 'old-operation', false)).rejects.toThrow('review confirmation');
    expect(await backend.recoverDevice('all', 'old-operation', true)).toMatchObject({ resolved: 0 });
    expect(
      await backend.recordLifecycle({
        assetId: 'all',
        type: 'maintenance',
        operator: 'Alice',
        note: 'Fresh visit',
        confirmedErasure: false,
      }),
    ).toMatchObject({ type: 'maintenance' });
    await expect(engine.state('all')).rejects.toThrow('Fresh provisioning');
  });

  it('prepares fresh reviews through the backend without executing them', async () => {
    const project = await createProject(join(root, 'setup'), product, toPolicyDocument(setupPolicy));
    await saveInventory(project, { schemaVersion: 1, devices: [device] });
    const setup = new WorkflowEngine({
      project: await loadProject(project.root, product),
      store,
      port: new MemoryPort(),
      artifacts: engine.artifacts,
      controlRoot: join(root, 'control'),
    });
    const prepared = await setup.prepare({ device, transport: { kind: 'usb', serial: 'PIXEL1' } });
    const run = await setup.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
    await setup.execute(run.id);
    const backend = live(setup);
    const result = (await backend.refreshReview(run.id)) as { planId: string; reviewSummary: string };
    expect(typeof (result as { planId: string }).planId).toBe('string');
    expect(typeof (result as { reviewSummary: string }).reviewSummary).toBe('string');
    expect(await store.get('runs', run.id)).toMatchObject({ status: 'superseded' });
    expect(await backend.getRun(run.id, 0)).toMatchObject({
      run: {
        supersededBy: result.planId,
        nextSteps: [
          {
            kind: 'review-refreshed-plan',
            command: ['agent', 'execute', '--plan', result.planId, '--help'],
          },
        ],
      },
    });
    const replacement = await setup.submit(result.planId, result.reviewSummary, 'Alice');
    expect(replacement.id).not.toBe(result.planId);
    expect(await backend.getRun(run.id, 0)).toMatchObject({
      run: {
        nextSteps: [
          { kind: 'follow-superseding-run', command: ['agent', 'status', '--run', replacement.id] },
        ],
      },
    });
    expect(detachedSpawn).not.toHaveBeenCalled();
  });

  it('updates explicit extension locks, reads declared contributions and reviews adapter actions', async () => {
    const lock: ExtensionLock = {
      id: '@private/fleet',
      version: '0.1.0',
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
      apiVersion: 1,
      entry: 'index.js',
      installPath: 'a'.repeat(64),
    };
    const next = { ...lock, version: '0.2.0' };
    const config = { ...engine.project.config, extensions: [lock] };
    const project = {
      ...engine.project,
      config,
      resolved: resolvePolicy(engine.project.policy, config, product, engine.project.resolved.engineDigest),
    };
    const extended = new WorkflowEngine({
      project,
      store,
      port: engine.port,
      artifacts: engine.artifacts,
      controlRoot: join(root, 'control'),
    });
    const backend = live(extended);
    vi.spyOn(ExtensionManager.prototype, 'list').mockResolvedValue([lock]);
    vi.spyOn(ExtensionManager.prototype, 'inspect').mockResolvedValue({
      schemaVersion: 1,
      id: lock.id,
      version: lock.version,
      apiVersion: 1,
      entry: 'index.js',
      contributions: {
        commands: ['review'],
        policyPacks: ['policy.json'],
        guides: ['guide.md'],
        adapters: ['adapter.js'],
      },
    });
    const install = vi.spyOn(ExtensionManager.prototype, 'install').mockResolvedValue(lock);
    const update = vi.spyOn(ExtensionManager.prototype, 'update').mockResolvedValue(next);
    const contribution = vi
      .spyOn(ExtensionManager.prototype, 'readContribution')
      .mockImplementation(
        (_lock, kind) =>
          Promise.resolve(kind === 'guides' ? '# Guide' : toPolicyDocument(basePolicy())) as ReturnType<
            ExtensionManager['readContribution']
          >,
      );
    vi.spyOn(ExtensionManager.prototype, 'invokeAdapter').mockResolvedValue([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review integration' },
    ]);
    vi.spyOn(ExtensionManager.prototype, 'invoke').mockResolvedValue([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review command' },
    ]);
    expect(await backend.extensionList()).toEqual([expect.objectContaining({ id: lock.id })]);
    expect(await backend.extensionInspect(lock.id)).toMatchObject({ id: lock.id });
    await expect(backend.extensionInspect('missing')).rejects.toThrow('not pinned');
    await expect(backend.extensionInstall({ tarball: '/tmp/ext.tgz' }, false)).rejects.toThrow(
      'review confirmation',
    );
    expect(await backend.extensionInstall({ tarball: '/tmp/ext.tgz' }, true)).toMatchObject({ id: lock.id });
    expect(install).toHaveBeenCalledWith({ tarball: '/tmp/ext.tgz' });
    expect(
      await backend.extensionUpdate(
        lock.id,
        { package: lock.id, version: '0.2.0' },
        true,
        'https://registry.example',
      ),
    ).toMatchObject({ version: '0.2.0' });
    expect(update).toHaveBeenCalledWith(lock, { package: lock.id, version: '0.2.0' });
    expect(
      JSON.parse(await readFile(join(project.root, 'pxv.project.json'), 'utf8')) as unknown,
    ).toMatchObject({ extensions: [next] });
    expect(await backend.extensionGuide(lock.id, 'guide.md')).toBe('# Guide');
    expect(await backend.extensionPolicy(lock.id, 'policy.json', true)).toMatchObject({
      selectedPolicy: 'fixture',
    });
    expect(contribution).toHaveBeenCalledWith(lock, 'policyPacks', 'policy.json');
    for (const action of [
      () => backend.extensionAdapter('all', lock.id, 'adapter.js', {}),
      () => backend.extensionCommand('all', lock.id, 'review', {}),
    ])
      expect(typeof ((await action()) as { planId: string }).planId).toBe('string');
    expect(detachedSpawn).not.toHaveBeenCalled();
    expect(await backend.extensionRemove(lock.id, true)).toEqual({
      removedFromProject: lock.id,
      retainedInSharedStore: true,
    });
    expect(
      JSON.parse(await readFile(join(project.root, 'pxv.project.json'), 'utf8')) as unknown,
    ).toMatchObject({ extensions: [] });
  });

  it('reloads policy and closes per-tool application stores in a long-lived MCP backend', async () => {
    const close = vi.fn(() => Promise.resolve());
    const application = vi.spyOn(Context, 'application').mockImplementation(
      async () =>
        ({
          engine: new WorkflowEngine({
            project: await loadProject(engine.project.root, product),
            store,
            port: engine.port,
            artifacts: engine.artifacts,
            controlRoot: join(root, 'control'),
          }),
          store: { close },
        }) as unknown as Awaited<ReturnType<typeof Context.application>>,
    );
    const live = liveAgentBackend(engine.project.root, resourceRoot, 'launcher.js', true);
    const prepared = (await live.prepareOperation('all', 'provision')) as {
      planId: string;
      reviewSummary: string;
    };
    const changed = basePolicy();
    changed.name = 'Externally changed policy';
    await writeFile(
      join(engine.project.root, engine.project.config.policyFile),
      JSON.stringify(toPolicyDocument(changed)),
    );
    await expect(live.executePlan(prepared.planId, prepared.reviewSummary, 'Alice')).rejects.toThrow(
      'Project policy',
    );
    expect(application).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('launches one acknowledged detached worker and forwards only approved host configuration', async () => {
    const prepared = await engine.prepare({
      device,
      transport: device.transports[0] ?? { kind: 'usb', serial: 'PIXEL1' },
    });
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'operator');
    process.env['PXV_REGISTRY_TOKEN'] = 'private-registry-sentinel';
    process.env['PXV_TOOL_ADB'] = '/approved/adb';
    process.env['PXV_DOCKER_MODE'] = 'host-adb';
    const unref = vi.fn();
    detachedSpawn.mockImplementation(() => {
      const child = new ChildProcess();
      child.unref = unref;
      queueMicrotask(() => {
        child.emit('message', null);
        child.emit('message', { type: 'wrong' });
        child.emit('message', { type: 'ready', runId: run.id });
      });
      return child;
    });
    const backend = agentBackend(engine, resourceRoot, '/installed/main.js', true);
    expect(await backend.executePlan(prepared.plan.id, prepared.reviewSummary, 'operator')).toMatchObject({
      id: run.id,
    });
    await backend.executePlan(prepared.plan.id, prepared.reviewSummary, 'operator');
    expect(detachedSpawn).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledOnce();
    const options = detachedSpawn.mock.calls[0]?.[2];
    expect(options?.env?.['PXV_TOOL_ADB']).toBe('/approved/adb');
    expect(options?.env?.['PXV_DOCKER_MODE']).toBe('host-adb');
    expect(options?.env?.['PXV_REGISTRY_TOKEN']).toBeUndefined();
    expect(options?.detached).toBe(true);
  });

  it('resumes intentional pending manual checkpoints and never launches terminal runs', async () => {
    const prepared = await engine.prepare({ device, transport: { kind: 'usb', serial: 'PIXEL1' } });
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'operator');
    await store.set('runs', run.id, {
      ...run,
      status: 'pending',
      manualGate: 'normal_credentials',
      cursor: 0,
    });
    detachedSpawn.mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('message', { type: 'ready', runId: run.id }));
      return child;
    });
    const backend = agentBackend(engine, resourceRoot, 'launcher.js', true);
    await backend.executePlan(prepared.plan.id, prepared.reviewSummary, 'operator');
    expect(detachedSpawn).toHaveBeenCalledOnce();
    await store.set('runs', run.id, { ...run, status: 'needs-inspection' });
    await backend.executePlan(prepared.plan.id, prepared.reviewSummary, 'operator');
    expect(detachedSpawn).toHaveBeenCalledOnce();
  });

  it.each(['exit', 'error'])(
    'preserves an inspection barrier when worker startup fails by %s',
    async (failure) => {
      const prepared = await engine.prepare({ device, transport: { kind: 'usb', serial: 'PIXEL1' } });
      const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'operator');
      detachedSpawn.mockImplementation(() => {
        const child = new ChildProcess();
        queueMicrotask(() => child.emit(failure, failure === 'error' ? new Error('startup failure') : 1));
        return child;
      });
      const backend = agentBackend(engine, resourceRoot, 'launcher.js', true);
      await expect(
        backend.executePlan(prepared.plan.id, prepared.reviewSummary, 'operator'),
      ).rejects.toThrow();
      expect(await store.get('runs', run.id)).toMatchObject({ status: 'needs-inspection' });
    },
  );

  it('terminates a worker that never acknowledges startup and preserves its inspection barrier', async () => {
    const prepared = await engine.prepare({ device, transport: { kind: 'usb', serial: 'PIXEL1' } });
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'operator');
    const killed = vi.fn();
    detachedSpawn.mockImplementation(() => {
      const child = new ChildProcess();
      child.kill = killed;
      return child;
    });
    vi.useFakeTimers();
    try {
      const pending = agentBackend(engine, resourceRoot, 'launcher.js', true).executePlan(
        prepared.plan.id,
        prepared.reviewSummary,
        'operator',
      );
      const rejected = expect(pending).rejects.toThrow('did not acknowledge');
      await vi.waitFor(() => expect(detachedSpawn).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(killed).toHaveBeenCalledWith('SIGTERM');
      expect(await store.get('runs', run.id)).toMatchObject({ status: 'needs-inspection' });
    } finally {
      vi.useRealTimers();
    }
  });
});
