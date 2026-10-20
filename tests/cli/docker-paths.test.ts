import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from '../test-api.js';
import { dockerPaths, dockerDestination, mountPath } from '../../packages/cli/src/docker-paths.js';
import { commandPathFlags } from '../../packages/cli/src/command-registry.js';

it('maps only command-specific host paths and mounts explicit external inputs read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-paths-'));
  try {
    const project = join(root, 'project');
    await mkdir(project);
    const external = join(root, 'przegląd review.txt');
    await writeFile(external, 'EXACT');
    const inner = join(project, 'review.txt');
    await writeFile(inner, 'INNER');
    for (const args of [
      ['agent', 'execute', '--review-file', external],
      ['agent', 'execute', `--review-file=${external}`],
      ['inventory', 'import', '--file', external],
      ['project', 'init', '--policy', external],
      ['device', 'attest', '--evidence', external],
      ['extension', 'invoke', '--input-file', external],
      ['extension', 'adapter', '--input-file', external],
    ]) {
      const result = await dockerPaths(args, project);
      expect(result.args).toEqual(args);
      expect(result.mounts).toContain(`type=bind,src=${external},dst=${external},readonly`);
    }
    expect((await dockerPaths(['agent', 'execute', '--review-file', inner], project)).mounts).toEqual([]);
    const fromCaller = await dockerPaths(
      ['agent', 'execute', '--review-file', relative(process.cwd(), external)],
      project,
    );
    expect(fromCaller.args.at(-1)).toBe(external);
    expect(fromCaller.mounts).toContain(`type=bind,src=${external},dst=${external},readonly`);
    const untouched = ['extension', 'guide', '--contribution', 'guide.md'];
    expect((await dockerPaths(untouched, project)).args).toEqual(untouched);
    expect(commandPathFlags(['unknown'])).toEqual({});
    expect(await readFile(external, 'utf8')).toBe('EXACT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('creates private persistent external outputs and rejects unsafe or special mounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pxv-output-paths-'));
  try {
    const project = join(root, 'project');
    await mkdir(project);
    const destination = join(root, 'new', 'wydruk');
    const result = await dockerPaths(['handoff', 'export', '--output', destination], project);
    expect(result.mounts).toContain(`type=bind,src=${destination},dst=${destination}`);
    await writeFile(join(destination, 'handoff.md'), 'persistent');
    expect(await readFile(join(destination, 'handoff.md'), 'utf8')).toBe('persistent');
    expect(
      (await dockerPaths(['project', 'init', '--path', join(root, 'init')], project)).mounts,
    ).toHaveLength(2);
    await expect(dockerPaths(['agent', 'execute', '--review-file', destination], project)).rejects.toThrow(
      'regular file',
    );
    await expect(
      dockerPaths(['handoff', 'export', '--output', join(destination, 'handoff.md')], project),
    ).rejects.toThrow('owned directory');
    const linked = join(root, 'link');
    await symlink(destination, linked);
    await expect(dockerPaths(['handoff', 'export', '--output', linked], project)).rejects.toThrow(
      'owned directory',
    );
    await expect(dockerPaths(['agent', 'execute', '--review-file', linked], project)).rejects.toThrow(
      'regular file',
    );
    await expect(dockerPaths(['agent', 'execute', '--review-file', ''], project)).rejects.toThrow(
      'requires a path',
    );
    await expect(
      dockerPaths(['agent', 'execute', '--review-file', join(root, 'missing')], project),
    ).rejects.toThrow();
    for (const path of ['/project/child', '/control', '/opt/pxv', '/', '/proc', '/usr/bin', '/extensions'])
      expect(() => dockerDestination(path)).toThrow('collides');
    for (const path of ['relative', '/tmp/a,b', '/tmp/a"b', '/tmp/a\nb'])
      expect(() => mountPath(path)).toThrow();
    await expect(dockerPaths(['handoff', 'export', '--output', '/project/unsafe'], project)).rejects.toThrow(
      'collides',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
