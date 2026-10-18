import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from './../test-api.js';
import { toPolicyDocument, verifyResolvedPolicy } from '@pxv/contracts';
import { createProject, loadProject, writePolicyLock } from '@pxv/engine';
import { runCli } from '../../packages/cli/src/cli.js';
import { policy, product } from '../contracts/fixtures.js';

describe('policy projects', () => {
  let root: string;
  let resources: string;
  let projectRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-policy-project-'));
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
  const invalidPolicy = () => ({ ...toPolicyDocument(policy), unexpected: true });

  it('rejects invalid project initialization before creating project files', async () => {
    const source = join(root, 'invalid.json');
    const contents = JSON.stringify(invalidPolicy());
    await writeFile(source, contents);
    const before = await readdir(root);
    await expect(
      runCli(args(['project', 'init', '--path', projectRoot, '--policy', source]), io),
    ).rejects.toThrow('unexpected');
    await expect(access(projectRoot)).rejects.toThrow();
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(source, 'utf8')).toBe(contents);
  });

  it('rejects an invalid authored source without changing the project or its lock', async () => {
    const project = await createProject(projectRoot, product, toPolicyDocument(policy), resources);
    await writePolicyLock(project);
    const source = join(projectRoot, project.config.policyFile);
    await writeFile(source, JSON.stringify(invalidPolicy()));
    const paths = [source, join(projectRoot, 'pxv.project.json'), join(projectRoot, 'policy.lock.json')];
    const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    const files = await readdir(projectRoot);
    await expect(loadProject(projectRoot, product, resources)).rejects.toThrow('unexpected');
    await expect(runCli(args(['policy', 'validate']), io)).rejects.toThrow('unexpected');
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
    expect(await readdir(projectRoot)).toEqual(files);
  });

  it('preserves authored input through creation, reload, validation and locking', async () => {
    const document = toPolicyDocument(policy);
    const project = await createProject(projectRoot, product, document, resources);
    const source = join(projectRoot, project.config.policyFile);
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(document);
    expect(await runCli(args(['policy', 'validate']), io)).toBe(0);
    expect(await runCli(args(['policy', 'lock', '--yes']), io)).toBe(0);
    const reloaded = await loadProject(projectRoot, product, resources);
    expect(reloaded.policy).not.toHaveProperty('schemaVersion');
    expect(reloaded.policy).not.toHaveProperty('version');
    expect(reloaded.policy.profiles[0]?.packages).toEqual(policy.profiles[0]?.packages);
    const lock = verifyResolvedPolicy(
      JSON.parse(await readFile(join(projectRoot, 'policy.lock.json'), 'utf8')),
    );
    expect(lock.policy).toEqual(reloaded.policy);
    expect(lock.digest).toBe(reloaded.resolved.digest);
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(document);
  });
});
