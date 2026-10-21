import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { requiredAttestations, toPolicyDocument } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, writePolicyLock, WorkflowEngine } from '@pxv/engine';
import { CommandRunner, SqliteStore } from '@pxv/runtime';
import { createMcpServer } from '@pxv/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from '../../packages/cli/src/cli.js';
import { liveAgentBackend } from '../../packages/cli/src/backend.js';
import { basePolicy, MemoryPort, executeWithWitnesses } from '../engine/fixtures.js';
import { device, product } from '../contracts/fixtures.js';
let root: string, resources: string, projectRoot: string, runId: string, extensions: string;
let saved: NodeJS.ProcessEnv;
beforeEach(async () => {
  saved = { ...process.env };
  root = await mkdtemp('/tmp/pxv-offline-evidence-');
  resources = join(root, 'resources');
  extensions = join(root, 'extensions');
  await mkdir(resources);
  const descriptor = { ...product, features: { extensions: true, seedvault: false } };
  await writeFile(join(resources, 'product.json'), JSON.stringify(descriptor));
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  process.env['PXV_EXTENSION_ROOT'] = extensions;
  delete process.env['PXV_DOCKER_MODE'];
  const created = await createProject(
    join(root, 'project'),
    descriptor,
    toPolicyDocument(basePolicy()),
    resources,
  );
  projectRoot = created.root;
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  await writeFile(
    join(projectRoot, 'pxv.project.json'),
    JSON.stringify({
      ...created.config,
      extensions: [
        {
          id: '@private/fleet',
          version: '0.1.0',
          integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
          apiVersion: 1,
          entry: 'index.js',
          installPath: 'a'.repeat(64),
        },
      ],
    }),
  );
  const project = await loadProject(projectRoot, descriptor, resources);
  await writePolicyLock(project);
  const store = await SqliteStore.open(join(projectRoot, 'state/pxv.sqlite3'));
  try {
    const engine = new WorkflowEngine({
      project,
      store,
      port: new MemoryPort(),
      controlRoot: join(root, 'control'),
      artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
    });
    const target = { device, transport: device.transports[0]! };
    const plan = await engine.prepare(target);
    const run = await engine.submit(plan.plan.id, plan.reviewSummary, 'Reviewer');
    runId = run.id;
    await executeWithWitnesses(engine, runId);
    for (const check of requiredAttestations(project.policy)) await engine.attest(target, check, 'Reviewer');
    await engine.finalize(target, 'Reviewer');
  } finally {
    await store.close();
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});
async function cli(args: string[]) {
  const output: string[] = [];
  await runCli([...args, '--project-root', projectRoot, '--resource-root', resources, '--json'], {
    out: (value) => output.push(value),
    error: () => {},
  });
  return JSON.parse(output.at(-1)!) as unknown;
}
async function corruptExtension() {
  const directory = join(extensions, 'a'.repeat(64));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{invalid manifest');
}
for (const extension of ['missing', 'corrupt']) {
  it(`keeps real CLI history, custody, lifecycle, cancellation and recovery available with ${extension} extension files`, async () => {
    if (extension === 'corrupt') await corruptExtension();
    const command = vi.spyOn(CommandRunner.prototype, 'run');
    expect(await cli(['agent', 'status', '--run', runId])).toMatchObject({
      run: { id: runId, status: 'pending' },
    });
    expect(
      await cli([
        'handoff',
        'accept',
        '--asset',
        device.assetId,
        '--recipient',
        'Recipient',
        '--debugging-off',
        '--yes',
      ]),
    ).toMatchObject({ outcome: 'completed-custody' });
    expect(await cli(['agent', 'status', '--run', runId])).toMatchObject({
      run: { status: 'completed', nextSteps: [] },
    });
    await cli(['agent', 'cancel', '--run', runId]);
    await cli(['device', 'recover', '--asset', device.assetId, '--run', runId, '--inspected', '--yes']);
    await cli([
      'lifecycle',
      'maintenance',
      '--asset',
      device.assetId,
      '--operator',
      'Reviewer',
      '--note',
      'Visit',
      '--yes',
    ]);
    const reports = await cli(['device', 'report', '--asset', device.assetId]);
    expect(reports).toMatchObject([
      {
        readinessStatus: 'unavailable',
        readinessUnavailableReason: 'missing-workflow',
        run: { status: 'completed', nextSteps: [] },
      },
    ]);
    await expect(cli(['device', 'plan', '--asset', device.assetId])).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });
  it(`keeps real MCP history and offline tools available with ${extension} extension files`, async () => {
    if (extension === 'corrupt') await corruptExtension();
    const server = createMcpServer(liveAgentBackend(projectRoot, resources, 'unused-launcher', true), true);
    const client = new Client({ name: 'offline-evidence', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text) as unknown;
    };
    try {
      expect(await call('get_run', { runId })).toMatchObject({ run: { status: 'pending' } });
      await call('confirm_custody', { assetId: device.assetId, recipient: 'Recipient', debuggingOff: true });
      expect(await call('list_runs', {})).toMatchObject({
        items: [{ value: { status: 'completed', nextSteps: [] } }],
      });
      await call('cancel_run', { runId });
      await call('recover_device', { assetId: device.assetId, runId, inspected: true });
      await call('record_lifecycle', {
        assetId: device.assetId,
        type: 'maintenance',
        operator: 'Reviewer',
        note: 'Visit',
      });
      expect(await call('get_run', { runId })).toMatchObject({ run: { status: 'completed', nextSteps: [] } });
      const blocked = await client.callTool({
        name: 'prepare_operation',
        arguments: { assetId: device.assetId, operation: 'provision' },
      });
      expect(blocked.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
it('keeps offline mutation authorization independent of extension verification', async () => {
  const backend = liveAgentBackend(projectRoot, resources, 'unused-launcher', false);
  await expect(backend.confirmCustody(device.assetId, 'Recipient', true)).rejects.toThrow('mutations');
  await expect(
    backend.recordLifecycle({
      assetId: device.assetId,
      type: 'maintenance',
      operator: 'Reviewer',
      note: 'Visit',
      confirmedErasure: false,
    }),
  ).rejects.toThrow('mutations');
});
