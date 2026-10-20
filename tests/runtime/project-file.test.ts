import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from './../test-api.js';
import { commitProjectFile, hashFile } from '@pxv/runtime';

describe('project configuration revision commits', () => {
  it('honors cancellation after revision checks and before replacement', async () => {
    const root = await mkdtemp('/tmp/pxv-cancel-commit-');
    const path = join(root, 'policy.json');
    await writeFile(path, 'original');
    const controller = new AbortController();
    await expect(
      commitProjectFile({
        path,
        projectId: 'cancel',
        controlRoot: join(root, 'control'),
        expectedSha256: await hashFile(path),
        signal: controller.signal,
        get data() {
          controller.abort(new Error('cancelled before replacement'));
          return 'updated';
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(await readFile(path, 'utf8')).toBe('original');
  });
  it('serializes competing writes and rejects stale revisions without overwriting either source', async () => {
    const root = await mkdtemp('/tmp/pxv-project-commit-');
    const path = join(root, 'project.json');
    const controlRoot = join(root, 'control');
    await writeFile(path, 'reviewed');
    const original = await hashFile(path);
    const commit = (data: string) =>
      commitProjectFile({ path, controlRoot, projectId: 'same', expectedSha256: original, data });
    const results = await Promise.allSettled([commit('first'), commit('second')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(results[0]?.status === 'fulfilled' ? 'first' : 'second');
    const source = join(root, 'policy.json');
    await writeFile(source, 'policy-review');
    const sourceHash = await hashFile(source);
    await writeFile(source, 'policy-changed');
    await expect(
      commitProjectFile({
        path: join(root, 'lock'),
        projectId: 'same',
        controlRoot,
        expectedSha256: undefined,
        expectedSources: [{ path: source, sha256: sourceHash }],
        data: 'stale-lock',
      }),
    ).rejects.toThrow('source changed');
    await expect(readFile(join(root, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await commitProjectFile({
      path: join(root, 'lock'),
      projectId: 'same',
      controlRoot,
      expectedSha256: undefined,
      expectedSources: [{ path: source, sha256: await hashFile(source) }],
      data: 'fresh-lock',
    });
    expect(await readFile(join(root, 'lock'), 'utf8')).toBe('fresh-lock');
  });
  it('rejects invalid revision inputs and propagates unsafe path errors', async () => {
    const root = await mkdtemp('/tmp/pxv-project-commit-');
    const input = {
      path: join(root, 'file'),
      projectId: 'p',
      controlRoot: join(root, 'control'),
      expectedSha256: undefined,
      data: 'x',
    };
    await expect(commitProjectFile({ ...input, expectedSha256: 'invalid' })).rejects.toThrow(
      'Invalid expected',
    );
    await expect(
      commitProjectFile({ ...input, expectedSources: [{ path: root, sha256: 'bad' }] }),
    ).rejects.toThrow('source revision');
    await expect(commitProjectFile({ ...input, path: root })).rejects.toThrow('regular file');
    await symlink('/tmp', input.path);
    await expect(commitProjectFile(input)).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
