import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from '../test-api.js';
import { retainedHelperPath } from '../../packages/cli/src/retained-helper.js';
import { runInDocker } from '../../packages/cli/src/docker.js';
import { runCli } from '../../packages/cli/src/cli.js';
import {
  parseCommandArguments,
  commandHelp,
  commandPathFlags,
} from '../../packages/cli/src/command-registry.js';
import { product } from '../contracts/fixtures.js';

it('resolves canonical retained helpers while refusing traversal, aliases outside Docker and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-retained-helper-'));
  const prior = process.env['PXV_DOCKER_MODE'];
  try {
    delete process.env['PXV_DOCKER_MODE'];
    await mkdir(join(root, 'state/plans/review'), { recursive: true });
    const helper = join(root, 'state/plans/review/helper.apk');
    await writeFile(helper, 'EXACT');
    expect(await retainedHelperPath(root, helper)).toBe(helper);
    for (const path of [
      'relative.apk',
      helper + '/../helper.apk',
      join(root, 'outside.apk'),
      helper.replace('helper.apk', './helper.apk'),
      '/project/state/plans/review/helper.apk',
    ])
      await expect(retainedHelperPath(root, path)).rejects.toThrow();
    await symlink(helper, join(root, 'state/plans/review/alias.apk'));
    await expect(retainedHelperPath(root, join(root, 'state/plans/review/alias.apk'))).rejects.toThrow(
      'symlinks',
    );
    process.env['PXV_DOCKER_MODE'] = 'host-adb';
    await expect(retainedHelperPath(root, '/project/state/plans/review/helper.apk')).rejects.toThrow();
    expect(await readFile(helper, 'utf8')).toBe('EXACT');
  } finally {
    if (prior === undefined) delete process.env['PXV_DOCKER_MODE'];
    else process.env['PXV_DOCKER_MODE'] = prior;
    await rm(root, { recursive: true, force: true });
  }
});
it('rejects extension install/update Docker flags before resolving paths or starting Docker', async () => {
  const runner = { run: vi.fn(() => Promise.reject(new Error('Unexpected Docker command'))) };
  for (const command of ['install', 'update']) {
    const args = [
      'extension',
      command,
      '--file',
      '/missing.tgz',
      ...(command === 'update' ? ['--extension', 'example'] : []),
    ];
    expect(() => parseCommandArguments(args)).not.toThrow();
    for (const flags of [['--execution', 'docker'], ['--execution=docker']])
      expect(() => parseCommandArguments([...args, ...flags])).toThrow('host execution');
    await expect(
      runInDocker(args, '/missing-project', 'image', 'direct', '/missing-extensions', runner),
    ).rejects.toThrow('host execution');
    expect(commandPathFlags(['extension', command])).toEqual({});
    expect(commandHelp(product, 'test', ['extension', command])).not.toContain('--image');
    expect(commandHelp(product, 'test', ['extension', command])).toContain('local host only');
  }
  expect(runner.run).not.toHaveBeenCalled();
});
it('rejects raw-container extension installation before loading a project or confirming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-container-extension-'));
  const prior = process.env['PXV_DOCKER_MODE'];
  try {
    await writeFile(join(root, 'product.json'), JSON.stringify(product));
    process.env['PXV_DOCKER_MODE'] = 'host-adb';
    const io = { out: vi.fn(), error: vi.fn(), confirm: vi.fn(() => Promise.resolve(true)) };
    for (const command of ['install', 'update'])
      await expect(
        runCli(
          [
            'extension',
            command,
            '--file',
            '/missing.tgz',
            '--resource-root',
            root,
            ...(command === 'update' ? ['--extension', 'example'] : []),
          ],
          io,
        ),
      ).rejects.toThrow('host execution');
    expect(io.confirm).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env['PXV_DOCKER_MODE'];
    else process.env['PXV_DOCKER_MODE'] = prior;
    await rm(root, { recursive: true, force: true });
  }
});
