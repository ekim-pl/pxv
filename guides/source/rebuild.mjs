#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildDocumentation } from '../../packages/release/dist/docs.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let destination = join(root, 'guides');
let htmlOnly = false;
let render = true;
let chrome = process.env['PXV_CHROMIUM'];
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--output-dir') {
    if (!process.argv[index + 1]) throw Error('Missing output directory');
    destination = resolve(process.argv[++index]);
  } else if (argument === '--chromium') {
    if (!process.argv[index + 1]) throw Error('Missing Chromium executable');
    chrome = process.argv[++index];
  } else if (argument === '--html-only') htmlOnly = true;
  else if (argument === '--no-render') render = false;
  else throw Error(`Unknown build option: ${argument}`);
}
if (!htmlOnly && !chrome) throw Error('Select Chromium explicitly with PXV_CHROMIUM or --chromium');
const outputs = await buildDocumentation(root, destination, {
  pdf: !htmlOnly,
  ...(chrome ? { chromiumExecutable: chrome } : {}),
});
if (outputs.length !== 6) throw Error('Expected exactly six current guide editions');
const qa = join(destination, 'qa');
await mkdir(qa, { recursive: true });
const manifest = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  kind: 'document QA; not device acceptance',
  renderer: 'Node Markdown/HTML + explicit Chromium + Poppler',
  editions: [],
};
for (const html of outputs) {
  const name = html.slice(html.lastIndexOf('/') + 1, -5);
  const source = join(root, 'guides/source/markdown', `${name}.md`);
  const record = {
    name,
    sourceSha256: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    htmlSha256: createHash('sha256')
      .update(await readFile(html))
      .digest('hex'),
  };
  if (!htmlOnly) {
    const pdf = html.slice(0, -5) + '.pdf';
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    const count = Number(/Pages:\s*(\d+)/u.exec(info)?.[1]);
    const dimensions = /Page size:\s*([\d.]+) x ([\d.]+) pts \(A4\)/u.exec(info);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      !dimensions ||
      Math.abs(Number(dimensions[1]) - 595.28) > 2 ||
      Math.abs(Number(dimensions[2]) - 841.89) > 2
    )
      throw Error(`Expected nonempty A4 PDF: ${name}`);
    const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
    if (text.length < 1500 || text.includes('\uFFFD') || /file:\/\/|\/home\/|\/tmp\/pxv-/u.test(text))
      throw Error(`Text integrity or private-path failure: ${name}`);
    if (name.endsWith('-pl') && !/[ąćęłńóśźż]/u.test(text)) throw Error(`Missing Polish glyphs: ${name}`);
    const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
    if (!fonts.includes('DejaVuSans')) throw Error(`Guide font missing: ${name}`);
    await writeFile(join(qa, `${name}.txt`), text);
    if (render) {
      execFileSync('pdftoppm', ['-r', '65', '-png', pdf, join(qa, `${name}-page`)], { stdio: 'pipe' });
    }
    Object.assign(record, {
      pdfSha256: createHash('sha256')
        .update(await readFile(pdf))
        .digest('hex'),
      pages: count,
      a4: true,
      polishGlyphs: name.endsWith('-pl') ? 'present' : 'not applicable',
      embeddedFont: 'DejaVuSans',
      pageRasters: render
        ? (await readdir(qa))
            .filter((file) => file.startsWith(`${name}-page-`) && file.endsWith('.png'))
            .sort()
        : [],
    });
  }
  manifest.editions.push(record);
}
await writeFile(join(qa, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`${outputs.length} guide editions built in ${destination}\n`);
for (const edition of manifest.editions)
  process.stdout.write(`${edition.name}: ${edition.pages ?? 'HTML only'}\n`);
