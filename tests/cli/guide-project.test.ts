import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { createProject } from '@pxv/engine';
import { toPolicyDocument } from '@pxv/contracts';
import { parseCli } from '../../packages/cli/src/arguments.js';
import { guidesRebuildCommand } from '../../packages/cli/src/guide-rebuild-command.js';
import { policy, product } from '../contracts/fixtures.js';

let root: string;
let projectRoot: string;
const metadata = { projectName: 'Zażółć <Fleet>', support: { name: 'Local support', phone: '+48 123' } };
const io = { out: () => undefined, error: () => undefined };
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-project-guides-');
  const project = await createProject(join(root, 'project'), product, toPolicyDocument(policy));
  projectRoot = project.root;
  await writeFile(
    join(projectRoot, 'pxv.project.json'),
    JSON.stringify({ ...project.config, insertMetadata: metadata }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const args = (...extra: string[]) => [
  'guides',
  'rebuild',
  '--project-root',
  projectRoot,
  '--html-only',
  '--output-dir',
  join(root, 'output'),
  ...extra,
];

for (const failure of [undefined, 'build', 'publishing'] as const) {
  it(`projects only insert metadata without opening registry storage and cleans up after ${failure ?? 'success'}`, async () => {
    let metadataPath = '';
    let calls = 0;
    const context = await parseCli(args(), io);
    const work = guidesRebuildCommand(context, {
      execute: async (_command, forwarded) => {
        calls++;
        if (calls === 1 && failure === 'build') throw new Error('build failed');
        if (calls === 1) return;
        expect(forwarded).toContain(join(projectRoot, 'policy.json'));
        metadataPath = forwarded[forwarded.indexOf('--insert-metadata-file') + 1]!;
        expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toEqual(metadata);
        expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
        expect((await stat(join(metadataPath, '..'))).mode & 0o777).toBe(0o700);
        expect(forwarded).not.toContain(join(projectRoot, 'pxv.project.json'));
        if (failure === 'publishing') throw new Error('publishing failed');
      },
    });
    if (failure) await expect(work).rejects.toThrow(failure + ' failed');
    else expect(await work).toBe(0);
    if (metadataPath) await expect(access(metadataPath)).rejects.toThrow();
    await expect(access(join(projectRoot, 'state/pxv.sqlite3'))).rejects.toThrow();
    await expect(access(join(projectRoot, 'secrets/phone-registry.pxv'))).rejects.toThrow();
  });
}

it('rejects project/policy conflicts and missing or authoritative output directories before launching tools', async () => {
  const variants = [
    [...args(), '--policy', 'policy-packs/single-simple/policy.json'],
    ['guides', 'rebuild', '--project-root', projectRoot, '--html-only'],
    [...args(), '--output-dir', 'guides'],
  ];
  for (const values of variants) {
    let calls = 0;
    await expect(
      guidesRebuildCommand(await parseCli(values, io), {
        execute: () => {
          calls++;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  }
});

it('runs the project-specific blank pipeline in both languages without initializing storage', async () => {
  await guidesRebuildCommand(await parseCli(args(), io));
  for (const locale of ['en', 'pl']) {
    const markdown = await readFile(join(root, `output/source/markdown/credentials-${locale}.md`), 'utf8');
    const html = await readFile(join(root, `output/credentials-${locale}.html`), 'utf8');
    for (const content of [markdown, html]) {
      expect(content).toContain('Zażółć &lt;Fleet&gt;');
      expect(content).toContain('Local support: +48 123');
      expect(content).not.toContain(product.support.email);
    }
  }
  await expect(access(join(projectRoot, 'state/pxv.sqlite3'))).rejects.toThrow();
});
