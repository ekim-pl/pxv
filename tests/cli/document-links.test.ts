import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it } from '../test-api.js';
import { CommandRunner } from '@pxv/runtime';
import { documentLinks, placeholderLink } from '../../tools/lib/document-links.mjs';
let root: string;
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-doc-links-');
  for (const directory of [
    'docs',
    'guides/source/markdown',
    'policy-packs',
    'tools/optional',
    'tests/acceptance',
  ])
    await mkdir(join(root, directory), { recursive: true });
  for (const file of [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'guides/README.md',
    'tests/acceptance/README.md',
  ])
    await writeFile(join(root, file), '# Heading\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
for (const source of ['[missing]()', '[missing]( )', '[missing](#)', '![missing]()', '![missing](#)'])
  it(`rejects placeholder destinations in the actual documentation checker: ${source}`, async () => {
    await writeFile(join(root, 'README.md'), '# Heading\n' + source);
    const result = await new CommandRunner().run([process.execPath, resolve('tools/check-docs.mjs')], {
      cwd: root,
      check: false,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('empty or placeholder link destination');
  });
it('preserves valid relative, fragment-only and external links while ignoring code examples', async () => {
  await writeFile(
    join(root, 'README.md'),
    '# Heading\n[local](CONTRIBUTING.md#heading) [fragment](#heading) [external](https://example.org/)\n`[example]()`',
  );
  const result = await new CommandRunner().run([process.execPath, resolve('tools/check-docs.mjs')], {
    cwd: root,
  });
  expect(result.code).toBe(0);
  expect(documentLinks('![image](#heading) `[example]()`')).toEqual(['#heading']);
  expect(placeholderLink('   ')).toBe(true);
  expect(placeholderLink(' # ')).toBe(true);
});
