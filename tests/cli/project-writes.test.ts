import { toPolicyDocument } from '@pxv/contracts';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createProject } from '@pxv/engine';
import { ExtensionManager } from '@pxv/extensions';
import type { ExtensionLock, PolicyDocument } from '@pxv/contracts';
import { runCli } from '../../packages/cli/src/cli.js';
import { policy, product } from '../contracts/fixtures.js';
let root: string;
let resources: string;
let projectRoot: string;
let saved: NodeJS.ProcessEnv;
const lock: ExtensionLock = {
  id: '@vendor/fleet',
  version: '0.1.0',
  integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
  apiVersion: 1,
  entry: 'index.js',
  installPath: 'a'.repeat(64),
};
function contribution(_lock: ExtensionLock, kind: 'policyPacks', _path: string): Promise<PolicyDocument>;
function contribution(_lock: ExtensionLock, kind: 'guides', _path: string): Promise<string>;
function contribution(
  _lock: ExtensionLock,
  kind: 'policyPacks' | 'guides',
): Promise<PolicyDocument | string> {
  return Promise.resolve(kind === 'policyPacks' ? toPolicyDocument(policy) : '# Guide');
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-config-write-'));
  saved = { ...process.env };
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  resources = join(root, 'resources');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  projectRoot = join(root, 'project');
  await createProject(projectRoot, product, toPolicyDocument(policy));
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});
const args = (values: string[]) => [...values, '--resource-root', resources, '--project-root', projectRoot];
const io = { out: () => {}, error: () => {} };
describe('reviewed project file commits', () => {
  it('preserves a concurrent config edit during extension acquisition', async () => {
    const configPath = join(projectRoot, 'pxv.project.json');
    const before = await readFile(configPath, 'utf8');
    const changed = {
      ...(JSON.parse(before) as Record<string, unknown>),
      extensions: [{ ...lock, id: '@vendor/concurrent' }],
    };
    vi.spyOn(ExtensionManager.prototype, 'install').mockImplementation(async () => {
      await writeFile(configPath, JSON.stringify(changed));
      return lock;
    });
    await expect(runCli(args(['extension', 'install', '--file', 'unused.tgz', '--yes']), io)).rejects.toThrow(
      'Project file changed',
    );
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(changed);
  });
  it('preserves a concurrent policy edit while a contribution awaits explicit review', async () => {
    const configPath = join(projectRoot, 'pxv.project.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, extensions: [lock] }));
    vi.spyOn(ExtensionManager.prototype, 'readContribution').mockImplementation(contribution);
    const changed = JSON.stringify(toPolicyDocument({ ...policy, name: 'Concurrent reviewed policy' }));
    await expect(
      runCli(args(['extension', 'policy', '--extension', lock.id, '--contribution', 'policy.json']), {
        ...io,
        confirm: async () => {
          await writeFile(join(projectRoot, 'policy.yaml'), changed);
          return true;
        },
      }),
    ).rejects.toThrow('Project file changed');
    expect(await readFile(join(projectRoot, 'policy.yaml'), 'utf8')).toBe(changed);
  });
  it('rejects a stale policy target when project selection changes during review', async () => {
    const configPath = join(projectRoot, 'pxv.project.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const pinned = { ...config, extensions: [lock] };
    await writeFile(configPath, JSON.stringify(pinned));
    const before = await readFile(join(projectRoot, 'policy.yaml'), 'utf8');
    vi.spyOn(ExtensionManager.prototype, 'readContribution').mockImplementation(contribution);
    await expect(
      runCli(args(['extension', 'policy', '--extension', lock.id, '--contribution', 'policy.json']), {
        ...io,
        confirm: async () => {
          await writeFile(configPath, JSON.stringify({ ...pinned, policyFile: 'other.yaml' }));
          return true;
        },
      }),
    ).rejects.toThrow('Project source changed');
    expect(await readFile(join(projectRoot, 'policy.yaml'), 'utf8')).toBe(before);
  });

  it('bounds external extension input before invocation or application initialization', async () => {
    const configPath = join(projectRoot, 'pxv.project.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, extensions: [lock] }));
    const invoke = vi.spyOn(ExtensionManager.prototype, 'invoke');
    const file = join(root, 'oversized.json');
    await writeFile(file, JSON.stringify({ text: 'ą'.repeat(600_000) }));
    await expect(
      runCli(
        args([
          'extension',
          'invoke',
          '--extension',
          lock.id,
          '--command',
          'review',
          '--input-file',
          file,
          '--asset',
          'all',
        ]),
        io,
      ),
    ).rejects.toThrow('bounded read');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('commits a new exact extension lock without device mutation', async () => {
    const path = join(projectRoot, 'pxv.project.json');
    vi.spyOn(ExtensionManager.prototype, 'install').mockResolvedValue(lock);
    expect(await runCli(args(['extension', 'install', '--file', 'unused.tgz', '--yes']), io)).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ extensions: [lock] });
  });
});
