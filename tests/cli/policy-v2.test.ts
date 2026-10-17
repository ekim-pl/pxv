import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toPolicyDocument, verifyResolvedPolicy } from '@pxv/contracts';
import { createProject, loadProject, writePolicyLock } from '@pxv/engine';
import { runCli } from '../../packages/cli/src/cli.js';
import { policy, product } from '../contracts/fixtures.js';

describe('v2-only policy projects', () => {
  let root: string;
  let resources: string;
  let projectRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-policy-v2-'));
    resources = join(root, 'resources');
    await mkdir(resources);
    await writeFile(join(resources, 'product.json'), JSON.stringify(product));
    projectRoot = join(root, 'project');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const io = { out: () => {}, error: () => {} };
  const args = (values: string[]) => [
    ...values,
    '--json',
    '--resource-root',
    resources,
    '--project-root',
    projectRoot,
  ];
  const legacyPolicy = () => ({ ...policy, schemaVersion: 1 });

  it('rejects v1 project initialization before creating project files', async () => {
    const source = join(root, 'legacy.json');
    const contents = JSON.stringify(legacyPolicy());
    await writeFile(source, contents);
    const before = await readdir(root);
    await expect(
      runCli(args(['project', 'init', '--path', projectRoot, '--policy', source]), io),
    ).rejects.toThrow('schemaVersion');
    await expect(access(projectRoot)).rejects.toThrow();
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(source, 'utf8')).toBe(contents);
  });

  it('rejects a retained v1 source without changing the project or its lock', async () => {
    const project = await createProject(projectRoot, product, toPolicyDocument(policy), resources);
    await writePolicyLock(project);
    const source = join(projectRoot, project.config.policyFile);
    await writeFile(source, JSON.stringify(legacyPolicy()));
    const paths = [source, join(projectRoot, 'pxv.project.json'), join(projectRoot, 'policy.lock.json')];
    const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    const files = await readdir(projectRoot);
    await expect(loadProject(projectRoot, product, resources)).rejects.toThrow('schemaVersion');
    await expect(runCli(args(['policy', 'validate']), io)).rejects.toThrow('schemaVersion');
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
    expect(await readdir(projectRoot)).toEqual(files);
  });

  it('rejects the removed convert command and never creates its output', async () => {
    const project = await createProject(projectRoot, product, toPolicyDocument(policy), resources);
    const source = join(projectRoot, project.config.policyFile);
    const before = await readFile(source, 'utf8');
    const output = join(root, 'converted.json');
    await expect(runCli(args(['policy', 'convert', '--output', output]), io)).rejects.toThrow(
      'Unknown policy command',
    );
    await expect(access(output)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe(before);
  });

  it('preserves authored v2 through creation, reload, validation and locking', async () => {
    const document = toPolicyDocument(policy);
    const project = await createProject(projectRoot, product, document, resources);
    const source = join(projectRoot, project.config.policyFile);
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(document);
    expect(await runCli(args(['policy', 'validate']), io)).toBe(0);
    expect(await runCli(args(['policy', 'lock', '--yes']), io)).toBe(0);
    const reloaded = await loadProject(projectRoot, product, resources);
    expect(reloaded.policy.schemaVersion).toBe(2);
    expect(reloaded.policy.profiles[0]?.packages).toEqual(policy.profiles[0]?.packages);
    const lock = verifyResolvedPolicy(
      JSON.parse(await readFile(join(projectRoot, 'policy.lock.json'), 'utf8')),
    );
    expect(lock.policy).toEqual(reloaded.policy);
    expect(lock.digest).toBe(reloaded.resolved.digest);
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(document);
  });
});
