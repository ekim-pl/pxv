#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildDocumentation } from '../../packages/release/dist/docs.js';

/** @typedef {{destination:string,htmlOnly:boolean,render:boolean,chrome?:string}} BuildOptions */
/** @typedef {{name:string,sourceSha256:string,htmlSha256:string,pdfSha256?:string,pages?:number,a4?:boolean,polishGlyphs?:string,embeddedFont?:string,pageRasters?:string[]}} Edition */
/** @param {string} root @returns {BuildOptions} */
function buildOptions(root) {
  const { values } = parseArgs({
    options: {
      'output-dir': { type: 'string' },
      chromium: { type: 'string' },
      'html-only': { type: 'boolean' },
      'no-render': { type: 'boolean' },
    },
  });
  const chrome = values.chromium ?? process.env['PXV_CHROMIUM'];
  const htmlOnly = values['html-only'] ?? false;
  if (!htmlOnly && !chrome) throw Error('Select Chromium explicitly with PXV_CHROMIUM or --chromium');
  return {
    destination: resolve(values['output-dir'] ?? join(root, 'guides')),
    htmlOnly,
    render: !values['no-render'],
    ...(chrome ? { chrome } : {}),
  };
}
/** @param {string} file */
async function hash(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
/** @param {string} name @param {string} info */
function pageCount(name, info) {
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
  return count;
}
/** @param {string} name @param {string} pdf */
function inspectPdf(name, pdf) {
  const pages = pageCount(name, execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }));
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  if (text.length < 1500 || text.includes('\uFFFD') || /file:\/\/|\/home\/|\/tmp\/pxv-/u.test(text))
    throw Error(`Text integrity or private-path failure: ${name}`);
  if (name.endsWith('-pl') && !/[ąćęłńóśźż]/u.test(text)) throw Error(`Missing Polish glyphs: ${name}`);
  const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
  if (!fonts.includes('DejaVuSans')) throw Error(`Guide font missing: ${name}`);
  return { pages, text };
}
/** @param {string} qa @param {string} name @param {string} pdf @param {boolean} render */
async function pageRasters(qa, name, pdf, render) {
  const matches = (/** @type {string} */ file) => file.startsWith(`${name}-page-`) && file.endsWith('.png');
  for (const file of (await readdir(qa)).filter(matches)) await rm(join(qa, file));
  if (!render) return [];
  execFileSync('pdftoppm', ['-r', '65', '-png', pdf, join(qa, `${name}-page`)], { stdio: 'pipe' });
  return (await readdir(qa)).filter(matches).sort();
}
/** @param {string} root @param {string} html @param {string} qa @param {BuildOptions} options @returns {Promise<Edition>} */
async function verifyEdition(root, html, qa, options) {
  const name = html.slice(html.lastIndexOf('/') + 1, -5);
  /** @type {Edition} */
  const record = {
    name,
    sourceSha256: await hash(join(root, 'guides/source/markdown', `${name}.md`)),
    htmlSha256: await hash(html),
  };
  if (options.htmlOnly) return record;
  const pdf = html.slice(0, -5) + '.pdf',
    inspection = inspectPdf(name, pdf);
  await writeFile(join(qa, `${name}.txt`), inspection.text);
  return {
    ...record,
    pdfSha256: await hash(pdf),
    pages: inspection.pages,
    a4: true,
    polishGlyphs: name.endsWith('-pl') ? 'present' : 'not applicable',
    embeddedFont: 'DejaVuSans',
    pageRasters: await pageRasters(qa, name, pdf, options.render),
  };
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = buildOptions(root);
const outputs = await buildDocumentation(root, options.destination, {
  pdf: !options.htmlOnly,
  ...(options.chrome ? { chromiumExecutable: options.chrome } : {}),
});
if (outputs.length !== 6) throw Error('Expected exactly six current guide editions');
const qa = join(options.destination, 'qa');
await mkdir(qa, { recursive: true });
/** @type {Edition[]} */
const editions = [];
for (const html of outputs) editions.push(await verifyEdition(root, html, qa, options));
const manifest = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  kind: 'document QA; not device acceptance',
  renderer: 'Node Markdown/HTML + explicit Chromium + Poppler',
  editions,
};
await writeFile(join(qa, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`${outputs.length} guide editions built in ${options.destination}\n`);
for (const edition of editions) process.stdout.write(`${edition.name}: ${edition.pages ?? 'HTML only'}\n`);
