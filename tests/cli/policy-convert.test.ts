import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertPolicyToV2, verifyResolvedPolicy } from '@pxv/contracts';
import { createProject, loadProject, writePolicyLock, WorkflowEngine } from '@pxv/engine';
import type { ArtifactPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { runCli } from '../../packages/cli/src/cli.js';
import { policy, product } from '../contracts/fixtures.js';
import { MemoryPort } from '../engine/fixtures.js';

describe('explicit non-destructive policy conversion', () => {
  let root: string;
  let resources: string;
  let projectRoot: string;
  let savedControlRoot: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-policy-convert-'));
    savedControlRoot = process.env['PXV_CONTROL_ROOT'];
    process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
    resources = join(root, 'resources');
    await mkdir(resources);
    await writeFile(join(resources, 'product.json'), JSON.stringify(product));
    projectRoot = join(root, 'project');
    await createProject(projectRoot, product, policy, resources);
  });
  afterEach(async () => {
    if (savedControlRoot === undefined) delete process.env['PXV_CONTROL_ROOT'];
    else process.env['PXV_CONTROL_ROOT'] = savedControlRoot;
    await rm(root, { recursive: true, force: true });
  });
  const io = { out: () => {}, error: () => {} };
  const args = (values: string[]) => [...values, '--resource-root', resources, '--project-root', projectRoot];

  it('writes a new v2 file without changing sources or retained historical lock', async () => {
    const project = await loadProject(projectRoot, product, resources);
    await writePolicyLock(project);
    const source = join(projectRoot, 'policy.yaml');
    const marker = join(projectRoot, 'pxv.project.json');
    const lock = join(projectRoot, 'policy.lock.json');
    const before = await Promise.all([source, marker, lock].map((path) => readFile(path, 'utf8')));
    const output = join(projectRoot, 'policy.v2.json');
    expect(await runCli(args(['policy', 'convert', '--output', output]), io)).toBe(0);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(convertPolicyToV2(policy));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await Promise.all([source, marker, lock].map((path) => readFile(path, 'utf8')))).toEqual(before);
    const historical = verifyResolvedPolicy(JSON.parse(before[2]!));
    expect(historical.digest).toBe(project.resolved.digest);

    await writeFile(marker, JSON.stringify({ ...project.config, policyFile: 'policy.v2.json' }));
    const activated = await loadProject(projectRoot, product, resources);
    expect(activated.policy.sourceSchemaVersion).toBe(2);
    expect(activated.resolved.digest).not.toBe(historical.digest);
    expect(await readFile(lock, 'utf8')).toBe(before[2]);
    await writePolicyLock(activated);
    expect(verifyResolvedPolicy(JSON.parse(await readFile(lock, 'utf8'))).digest).toBe(
      activated.resolved.digest,
    );
  });

  it('refuses overwrites and symlink destinations, including the original source', async () => {
    const source = join(projectRoot, 'policy.yaml');
    const before = await readFile(source, 'utf8');
    await expect(runCli(args(['policy', 'convert', '--output', source]), io)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const link = join(projectRoot, 'alias.json');
    await symlink(source, link);
    await expect(runCli(args(['policy', 'convert', '--output', link]), io)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(source, 'utf8')).toBe(before);
  });

  it('retains approved v1 runs but refuses their execution after activating v2', async () => {
    const project = await loadProject(projectRoot, product, resources);
    const port = new MemoryPort();
    await writeFile(
      join(projectRoot, 'inventory.json'),
      JSON.stringify({ schemaVersion: 1, devices: [port.observation.device] }),
    );
    const enrolled = await loadProject(projectRoot, product, resources);
    const store = await SqliteStore.open(join(root, 'migration.sqlite3'));
    const target = { device: port.observation.device, transport: port.observation.device.transports[0]! };
    const artifacts = {
      snapshot: (artifact: Parameters<ArtifactPort['snapshot']>[0]) => Promise.resolve(artifact),
    };
    try {
      const original = new WorkflowEngine({
        project: enrolled,
        store,
        port,
        artifacts,
        controlRoot: join(root, 'control'),
      });
      const prepared = await original.prepare(target);
      const run = await original.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
      const output = join(projectRoot, 'policy.v2.json');
      await runCli(args(['policy', 'convert', '--output', output]), io);
      await writeFile(
        join(projectRoot, 'pxv.project.json'),
        JSON.stringify({ ...project.config, policyFile: 'policy.v2.json' }),
      );
      const activated = await loadProject(projectRoot, product, resources);
      const migrated = new WorkflowEngine({
        project: activated,
        store,
        port,
        artifacts,
        controlRoot: join(root, 'control'),
      });
      await expect(migrated.plan(prepared.plan.id)).rejects.toThrow('prepare a new plan');
      await expect(migrated.execute(run.id)).rejects.toThrow('prepare a new plan');
      expect(await store.get('plans', prepared.plan.id)).toEqual(prepared);
      expect(port.calls).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('preserves v2 authoring format when creating and reloading a project', async () => {
    const document = convertPolicyToV2(policy);
    const another = await createProject(join(root, 'v2-project'), product, document, resources);
    expect(JSON.parse(await readFile(join(another.root, another.config.policyFile), 'utf8'))).toEqual(
      document,
    );
    expect(another.policy.sourceSchemaVersion).toBe(2);
    expect(another.policy.profiles[0]?.packages).toEqual(policy.profiles[0]?.packages);
  });
});
