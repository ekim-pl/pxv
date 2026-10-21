import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from '../test-api.js';
import { digest, requiredAttestations, toPolicyDocument } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, writePolicyLock, WorkflowEngine } from '@pxv/engine';
import { CommandRunner, SqliteStore } from '@pxv/runtime';
import { createMcpServer } from '@pxv/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from '../../packages/cli/src/cli.js';
import { liveAgentBackend } from '../../packages/cli/src/backend.js';
import { basePolicy, MemoryPort, executeWithWitnesses } from '../engine/fixtures.js';
import { device, product, hashB } from '../contracts/fixtures.js';

let root: string, resources: string, projectRoot: string, store: SqliteStore;
let engine: WorkflowEngine, port: MemoryPort, saved: NodeJS.ProcessEnv;
const target = { device, transport: device.transports[0]! };
beforeEach(async () => {
  saved = { ...process.env };
  root = await mkdtemp('/tmp/pxv-evidence-failures-');
  resources = join(root, 'resources');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  const policy = basePolicy();
  policy.profiles[0]!.recipes = [
    {
      schemaVersion: 1,
      id: 'fixture',
      packageId: 'org.example.vpn',
      versionCode: 12,
      signerSha256: hashB,
      buildFingerprint: 'fixture/build',
      steps: [{ action: 'back' }],
      postconditions: [{ resourceId: 'org.example.vpn:id/ready' }],
    },
  ];
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), resources);
  projectRoot = created.root;
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  const project = await loadProject(projectRoot, product, resources);
  await writePolicyLock(project);
  store = await SqliteStore.open(join(projectRoot, 'state/pxv.sqlite3'));
  port = new MemoryPort();
  port.runRecipe = (_target, _user, recipe) =>
    Promise.resolve({
      status: 'measured',
      capability: 'app-setup',
      recipeDigest: digest(recipe),
      postconditions: 1,
    });
  engine = new WorkflowEngine({
    project,
    store,
    port,
    controlRoot: join(root, 'control'),
    artifacts: { snapshot: (artifact) => Promise.resolve(artifact) },
  });
  const prepared = await engine.prepare(target);
  const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Reviewer');
  await executeWithWitnesses(engine, run.id);
  for (const check of requiredAttestations(project.policy)) await engine.attest(target, check, 'Reviewer');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
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
async function mcpFinalizationError(message: string) {
  const server = createMcpServer(liveAgentBackend(projectRoot, resources, 'unused-launcher', true), true);
  const client = new Client({ name: 'evidence-errors', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const result = await client.callTool({
      name: 'finalize_device',
      arguments: { assetId: device.assetId, operator: 'Reviewer', locale: 'en' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(message);
  } finally {
    await client.close();
    await server.close();
  }
}
it('blocks malformed recipe results through actual CLI reports and MCP finalization and disposes request stores', async () => {
  const state = await engine.state(device.assetId),
    reference = state.capabilityEvidence!.find((r) => r.kind === 'recipe')!;
  const proof = (await store.get<Record<string, unknown>>('capability-evidence', reference.evidenceId))!;
  await store.set('capability-evidence', reference.evidenceId, { ...proof, result: {} });
  const command = vi.spyOn(CommandRunner.prototype, 'run'),
    close = vi.spyOn(SqliteStore.prototype, 'close');
  expect(await cli(['device', 'report', '--asset', device.assetId])).toMatchObject([
    { ready: false, missing: ['recipe:admin:fixture'] },
  ]);
  await mcpFinalizationError('recipe:admin:fixture');
  expect(close).toHaveBeenCalledTimes(2);
  expect(command).not.toHaveBeenCalled();
  expect(await store.get('handoff', device.assetId)).toBeUndefined();
});
it('exposes incomplete shutdown in real device/fleet reports and blocks MCP finalization before phone commands', async () => {
  port.failAt = 'finalize';
  await expect(engine.finalize(target, 'Reviewer')).rejects.toThrow('Injected');
  const command = vi.spyOn(CommandRunner.prototype, 'run');
  for (const selection of [
    ['device', 'report', '--asset', device.assetId],
    ['fleet', 'report', '--all'],
  ])
    expect(await cli(selection)).toMatchObject([
      { ready: false, readinessStatus: 'available', missing: ['finalization-inspection'] },
    ]);
  const close = vi.spyOn(SqliteStore.prototype, 'close');
  await mcpFinalizationError('finalization-inspection');
  expect(close).toHaveBeenCalledTimes(1);
  for (const selection of [
    ['device', 'provision', '--asset', device.assetId],
    ['fleet', 'provision', '--all'],
  ])
    await expect(cli(selection)).rejects.toThrow('finalization-inspection');
  expect(close).toHaveBeenCalledTimes(3);
  expect(command).not.toHaveBeenCalled();
  expect(await store.get('handoff', device.assetId)).toBeUndefined();
});
for (const collection of ['capability-evidence', 'plans', 'runs', 'plan-generations'])
  it(`returns real CLI/MCP errors for undecodable ${collection} and closes request stores`, async () => {
    const state = await engine.state(device.assetId);
    const keys: Record<string, string> = {
      'capability-evidence': state.capabilityEvidence![0]!.evidenceId,
      plans: state.planId!,
      runs: (await engine.listRuns()).items[0]!.key,
      'plan-generations': device.assetId,
    };
    const database = new DatabaseSync(join(projectRoot, 'state/pxv.sqlite3'));
    try {
      database
        .prepare('INSERT OR REPLACE INTO records(collection,key,value) VALUES(?,?,?)')
        .run(collection, keys[collection]!, '{malformed');
    } finally {
      database.close();
    }
    const close = vi.spyOn(SqliteStore.prototype, 'close');
    const command = vi.spyOn(CommandRunner.prototype, 'run');
    await expect(cli(['device', 'report', '--asset', device.assetId])).rejects.toThrow(
      `Malformed stored JSON ${collection}`,
    );
    await mcpFinalizationError(`Malformed stored JSON ${collection}`);
    expect(close).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
    expect(await store.get('handoff', device.assetId)).toBeUndefined();
  });
