#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildDocumentation } from '../../../packages/release/dist/docs.js';
import { parseDocument, validatePolicyDocument } from '../../../packages/contracts/dist/index.js';
import { verifyGuideLinks } from './links.mjs';

/** @typedef {{destination:string,htmlOnly:boolean,render:boolean,chrome?:string,policyFile?:string}} BuildOptions */
/** @typedef {{x0:number,y0:number,x1:number,y1:number}} PageBox */
/** @typedef {{size:'A4'|'A5',width:number,height:number}} GuideFormat */
/** @typedef {{pdfSha256:string,pages:number,pageSize:string,trimBox?:PageBox,bleedBox?:PageBox,embeddedFonts:string,polishGlyphs:string,pageRasters:string[]}} PdfRecord */
/** @typedef {{name:string,sourceSha256:string,templateSha256:string,htmlSha256:string,locale:string,paperSize:'A4'|'A5',office?:PdfRecord,print?:PdfRecord}} Edition */

/** @type {('office'|'print')[]} */
const modes = ['office', 'print'];
/** @param {number} millimeters */
const mmToPoints = (millimeters) => (millimeters * 72) / 25.4;

/** @param {string} name @returns {GuideFormat} */
function guideFormat(name) {
  return /^(?:quickstart|credentials)-/u.test(name)
    ? { size: 'A5', width: 148, height: 210 }
    : { size: 'A4', width: 210, height: 297 };
}

/** @param {string} root @returns {BuildOptions} */
function buildOptions(root) {
  const { values } = parseArgs({
    options: {
      'output-dir': { type: 'string' },
      policy: { type: 'string' },
      chromium: { type: 'string' },
      'html-only': { type: 'boolean' },
      'no-render': { type: 'boolean' },
    },
  });
  const chrome = values.chromium ?? process.env['PXV_CHROMIUM'];
  const htmlOnly = values['html-only'] ?? false;
  if (values.policy && !values['output-dir']) throw Error('Policy booklets require an explicit --output-dir');
  if (!htmlOnly && !chrome) throw Error('Select Chromium explicitly with PXV_CHROMIUM or --chromium');
  return {
    destination: resolve(values['output-dir'] ?? join(root, 'guides')),
    htmlOnly,
    render: !values['no-render'],
    ...(chrome ? { chrome } : {}),
    ...(values.policy ? { policyFile: resolve(values.policy) } : {}),
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
  const count = Number(/^Pages:\s*(\d+)/mu.exec(info)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw Error(`Expected nonempty PDF: ${name}`);
  return count;
}

/** @param {string} text */
function normalizedText(text) {
  return text.normalize('NFKC').replaceAll('\u00ad', '').replace(/\s+/gu, ' ').trim();
}

/** @param {string} html @param {GuideFormat} format */
function expectedSections(html, format) {
  if (format.size !== 'A5') return [];
  const entities = /** @type {Record<string,string>} */ ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  });
  return [...html.matchAll(/<h2(?:\s[^>]*)?>(.*?)<\/h2>/gisu)]
    .map((match) =>
      normalizedText(
        (match[1] ?? '')
          .replace(/<[^>]*>/gu, '')
          .replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => entities[entity] ?? entity),
      ),
    )
    .filter((heading) => /^\d+[.)]?\s/u.test(heading));
}

/** @param {string} name @param {string} pdf @param {number} pages @param {string[]} sections */
function assertPageText(name, pdf, pages, sections) {
  if (sections.length && pages !== sections.length)
    throw Error(`Expected ${sections.length} A5 section pages; received ${pages}: ${name}`);
  for (let page = 1; page <= pages; page++) {
    const text = execFileSync('pdftotext', ['-f', String(page), '-l', String(page), pdf, '-'], {
      encoding: 'utf8',
    });
    if (text.trim().length < 12) throw Error(`Expected readable text on page ${page} of ${name}`);
    const heading = sections[page - 1];
    if (heading && !normalizedText(text).includes(heading))
      throw Error(`Expected A5 section "${heading}" on page ${page}: ${name}`);
  }
}

/** @param {string} name @param {string} info @param {RegExp} pattern */
function box(name, info, pattern) {
  const values = pattern.exec(info);
  if (!values) throw Error(`Missing page box for ${name}`);
  return {
    x0: Number(values[1]),
    y0: Number(values[2]),
    x1: Number(values[3]),
    y1: Number(values[4]),
  };
}

/** @param {string} name @param {string} info */
function pageDimensions(name, info) {
  const size = /^Page size:\s*([\d.]+) x ([\d.]+) pts(?: \(A4\))?/mu.exec(info);
  if (!size) throw Error(`Missing page size for ${name}`);
  return { width: Number(size[1]), height: Number(size[2]) };
}

/** @param {PageBox} actual @param {PageBox} expected @param {string} name */
function assertBox(actual, expected, name) {
  /** @type {(keyof PageBox)[]} */
  const keys = ['x0', 'y0', 'x1', 'y1'];
  for (const key of keys) {
    if (Math.abs(actual[key] - expected[key]) > 1.5) throw Error(`Unexpected ${name} ${key}: ${actual[key]}`);
  }
}

/** @param {string} name @param {string} pdfInfo @param {number} width @param {number} height @param {GuideFormat} format */
function printBoxes(name, pdfInfo, width, height, format) {
  const mediaWidth = format.width + 6;
  const mediaHeight = format.height + 6;
  if (Math.abs(width - mmToPoints(mediaWidth)) > 2 || Math.abs(height - mmToPoints(mediaHeight)) > 2)
    throw Error(`Print media size must be ${mediaWidth} x ${mediaHeight} mm: ${name}`);
  const trim = box(name, pdfInfo, /^TrimBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/mu);
  const bleed = box(name, pdfInfo, /^BleedBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/mu);
  const media = box(name, pdfInfo, /^MediaBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/mu);
  assertBox(
    trim,
    {
      x0: mmToPoints(3),
      y0: mmToPoints(3),
      x1: mmToPoints(format.width + 3),
      y1: mmToPoints(format.height + 3),
    },
    `${name} ${format.size} TrimBox`,
  );
  const expectedMedia = { x0: 0, y0: 0, x1: mmToPoints(mediaWidth), y1: mmToPoints(mediaHeight) };
  assertBox(bleed, expectedMedia, `${name} BleedBox`);
  assertBox(media, expectedMedia, `${name} MediaBox`);
  return { trim, bleed };
}

/** @param {string} name @param {string} pdf @param {string} locale */
function extractedText(name, pdf, locale) {
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  if (text.length < 500 || text.includes('\uFFFD') || /file:\/\/|\/home\/|\/tmp\/pxv-/u.test(text))
    throw Error(`Text integrity or private-path failure: ${name}`);
  if (locale === 'pl' && !/[ąćęłńóśźż]/iu.test(text)) throw Error(`Missing Polish glyphs: ${name}`);
  return text;
}

/** @param {string} name @param {string} pdf @param {string} family */
function embeddedFontNames(name, pdf, family) {
  const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
  const embedded = fonts.split('\n').filter((line) => /\byes\s+yes\s+yes\s+\d+/u.test(line));
  if (!embedded.length) throw Error(`No embedded fonts: ${name}`);
  if (family.replace(/\s+/gu, '') === 'DejaVuSans' && !fonts.includes('DejaVuSans'))
    throw Error(`Guide font missing: ${name}`);
  return [
    ...new Set(embedded.map((line) => (line.trim().split(/\s+/u)[0] ?? '').replace(/^[A-Z]{6}\+/u, ''))),
  ].join(', ');
}

/** @param {string} name @param {string} pdf @param {'office'|'print'} mode @param {string} locale @param {string} family @param {GuideFormat} format @param {string[]} sections */
function inspectPdf(name, pdf, mode, locale, family, format, sections) {
  const info = execFileSync('pdfinfo', ['-box', pdf], { encoding: 'utf8' });
  const pages = pageCount(name, info);
  assertPageText(name, pdf, pages, sections);
  const { width, height } = pageDimensions(name, info);
  let boxes;
  if (mode === 'office') {
    if (Math.abs(width - mmToPoints(format.width)) > 2 || Math.abs(height - mmToPoints(format.height)) > 2)
      throw Error(`Office PDF is not ${format.size}: ${name}`);
  } else boxes = printBoxes(name, info, width, height, format);
  const text = extractedText(name, pdf, locale);
  const fonts = embeddedFontNames(name, pdf, family);
  return {
    pages,
    pageSize: `${width.toFixed(2)} x ${height.toFixed(2)} pt`,
    ...(boxes ? { trimBox: boxes.trim, bleedBox: boxes.bleed } : {}),
    embeddedFonts: fonts,
    text,
  };
}

/** @param {string} qa @param {string} edition @param {'office'|'print'} mode @param {string} pdf @param {boolean} render */
async function pageRasters(qa, edition, mode, pdf, render) {
  const prefix = `${edition}-${mode}-page-`;
  const matches = (/** @type {string} */ file) => file.startsWith(prefix) && file.endsWith('.png');
  for (const file of (await readdir(qa)).filter(matches)) await rm(join(qa, file));
  if (!render) return [];
  execFileSync('pdftoppm', ['-r', '65', '-png', pdf, join(qa, `${edition}-${mode}-page`)], { stdio: 'pipe' });
  return (await readdir(qa)).filter(matches).sort();
}

/** @param {boolean} render @param {string[]} rasters @param {number} pages @param {string} name */
function assertRasterCount(render, rasters, pages, name) {
  if (render && rasters.length !== pages) throw Error(`Expected one page raster for each ${name} PDF page`);
}

/** @param {string} name @param {string} locale @param {GuideFormat} format @param {string} html */
function assertEditionHtml(name, locale, format, html) {
  const cover =
    format.size === 'A5' ? '<section class="guide-cover compact-cover">' : '<section class="guide-cover">';
  if (!html.includes(`<html lang="${locale}">`) || !html.includes(cover))
    throw Error(`HTML locale or cover missing: ${name}`);
  if (format.size === 'A5' && html.includes('<img class="cover-photo"'))
    throw Error(`A5 insert must use a compact cover: ${name}`);
}

/** @param {string} root @param {string} html @param {string} qa @param {BuildOptions} options @returns {Promise<Edition>} */
async function verifyEdition(root, html, qa, options) {
  const name = html.slice(html.lastIndexOf('/') + 1, -5);
  const locale = name.endsWith('-pl') ? 'pl' : 'en';
  const format = guideFormat(name);
  const htmlSource = await readFile(html, 'utf8');
  assertEditionHtml(name, locale, format, htmlSource);
  const sections = expectedSections(htmlSource, format);
  /** @type {Edition} */
  const record = {
    name,
    sourceSha256: await hash(join(options.destination, 'source/markdown', `${name}.md`)),
    templateSha256: await hash(join(root, 'guides/source/markdown', `${name}.md`)),
    htmlSha256: await hash(html),
    locale,
    paperSize: format.size,
  };
  if (options.htmlOnly) return record;
  const theme = /** @type {{fontFamily:string}} */ (
    JSON.parse(await readFile(join(root, 'guides/assets/brand.json'), 'utf8'))
  );
  const family = theme.fontFamily;
  for (const mode of modes) {
    const pdf = html.slice(0, -5) + `-${mode}.pdf`;
    const inspection = inspectPdf(`${name}-${mode}`, pdf, mode, locale, family, format, sections);
    await writeFile(join(qa, `${name}-${mode}.txt`), inspection.text);
    const rasters = await pageRasters(qa, name, mode, pdf, options.render);
    assertRasterCount(options.render, rasters, inspection.pages, `${name}-${mode}`);
    record[mode] = {
      pdfSha256: await hash(pdf),
      pages: inspection.pages,
      pageSize: inspection.pageSize,
      ...(inspection.trimBox && inspection.bleedBox
        ? { trimBox: inspection.trimBox, bleedBox: inspection.bleedBox }
        : {}),
      embeddedFonts: inspection.embeddedFonts,
      polishGlyphs: locale === 'pl' ? 'present' : 'not applicable',
      pageRasters: rasters,
    };
  }
  return record;
}

/** @param {string} destination @param {string} productName */
async function verifyIndex(destination, productName) {
  const index = await readFile(join(destination, 'index.html'), 'utf8');
  if (!index.includes(`<h1>${productName}`))
    throw Error('Guide index does not use the current product brand');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const options = buildOptions(root);
const policy = options.policyFile
  ? validatePolicyDocument(parseDocument(await readFile(options.policyFile, 'utf8')))
  : undefined;
const configuration = /** @type {{editions:string[]}} */ (
  JSON.parse(await readFile(join(root, 'guides/source/build-manifest.json'), 'utf8'))
);
const editionNames = configuration.editions;
if (
  !Array.isArray(editionNames) ||
  !editionNames.length ||
  editionNames.some((name) => typeof name !== 'string' || !/^[a-z]+-(?:en|pl)$/u.test(name)) ||
  new Set(editionNames).size !== editionNames.length
)
  throw Error('Invalid configured guide edition list');
editionNames.sort();
const outputs = await buildDocumentation(root, options.destination, {
  pdf: !options.htmlOnly,
  ...(options.chrome ? { chromiumExecutable: options.chrome } : {}),
  ...(policy ? { policy } : {}),
});
if (outputs.length !== editionNames.length)
  throw Error(`Expected ${editionNames.length} configured guide editions; received ${outputs.length}`);
const names = outputs.map((path) => path.slice(path.lastIndexOf('/') + 1, -5)).sort();
if (names.join(',') !== editionNames.join(','))
  throw Error('Guide edition list does not match the current EN/PL sources');
const product = /** @type {{name:string,upstreamVersion:string}} */ (
  JSON.parse(await readFile(join(root, 'product.json'), 'utf8'))
);
await verifyIndex(options.destination, product.name);
await verifyGuideLinks(options.destination, [join(options.destination, 'index.html'), ...outputs]);
const qa = join(options.destination, 'qa');
await mkdir(qa, { recursive: true });
/** @type {Edition[]} */
const editions = [];
for (const html of outputs) editions.push(await verifyEdition(root, html, qa, options));
const manifest = {
  schemaVersion: 2,
  engineVersion: product.upstreamVersion,
  kind: 'document QA; not device acceptance',
  renderer: 'Node Markdown/HTML + explicit Chromium + pdf-lib page boxes + Poppler',
  ...(policy
    ? {
        installation: {
          policyId: policy.id,

          profileCount: policy.profiles.length,
        },
      }
    : {}),
  outputCount: outputs.length * (options.htmlOnly ? 1 : 3),
  formats: options.htmlOnly
    ? ['HTML']
    : [
        'HTML',
        ...new Set(
          editions.flatMap(({ paperSize }) => [
            `${paperSize} office PDF`,
            `${paperSize} print PDF with ${paperSize} TrimBox and 3 mm bleed`,
          ]),
        ),
      ],
  editions,
};
await writeFile(join(qa, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`${outputs.length} guide editions built in ${options.destination}\n`);
for (const edition of editions)
  process.stdout.write(
    `${edition.name}: ${edition.office?.pages ?? 'HTML only'} office pages, ${edition.print?.pages ?? 'HTML only'} print pages\n`,
  );
