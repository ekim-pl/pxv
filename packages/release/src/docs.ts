#!/usr/bin/env node
import { releaseFailure } from './errors.js';
import { marked } from 'marked';
import { chromium, type Page } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { access, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, validateProduct } from '@pxv/contracts';
import { walkPublic } from './candidate.js';

interface DocumentationOptions {
  pdf?: boolean;
  chromiumExecutable?: string;
  browser?: Pick<typeof chromium, 'launch'>;
}
interface GuideBrand {
  brandName: string;
  primary: string;
  secondary: string;
  accent: string;
  fontFamily: string;
  fontAsset?: string;
  logo?: string;
}
const defaultBrand = {
  schemaVersion: 1,
  colors: { primary: '#17324D', secondary: '#2F6873', accent: '#D9952B' },
  fontFamily: 'DejaVu Sans',
};
type GuideKind = 'product' | 'operator' | 'user' | 'b2b' | 'generic';
const printModes = ['office', 'print'] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function publicAsset(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value.startsWith('assets/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid guide brand ${name}`);
  return value;
}

async function loadBrand(root: string, destination: string, productName: string): Promise<GuideBrand> {
  const path = join(root, 'guides/assets/brand.json');
  const input = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const parsed: Record<string, unknown> = input
    ? (JSON.parse(input) as Record<string, unknown>)
    : { ...defaultBrand };
  const brand = validateBrand(parsed, productName);
  for (const asset of [brand.fontAsset, brand.logo]) {
    if (asset) await access(join(destination, asset));
  }
  return brand;
}

function validateBrand(parsed: Record<string, unknown>, productName: string): GuideBrand {
  if (parsed['schemaVersion'] !== 1) throw new Error('Guide brand schemaVersion must be 1');
  const palette = brandPalette(parsed['colors']);
  const brandName = validateBrandName(parsed['brandName'], productName);
  const fontFamily = parsed['fontFamily'];
  if (typeof fontFamily !== 'string' || !/^[\p{L}\p{N} _.-]{1,64}$/u.test(fontFamily.trim()))
    throw new Error('Invalid guide brand fontFamily');
  const fontAsset = publicAsset(parsed['fontAsset'], 'fontAsset');
  const logo = publicAsset(parsed['logo'], 'logo');
  return {
    brandName,
    primary: brandColor(palette, 'primary'),
    secondary: brandColor(palette, 'secondary'),
    accent: brandColor(palette, 'accent'),
    fontFamily: fontFamily.trim(),
    ...(fontAsset ? { fontAsset } : {}),
    ...(logo ? { logo } : {}),
  };
}

function brandPalette(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Guide brand needs three colors');
  return value as Record<string, unknown>;
}

function validateBrandName(value: unknown, productName: string): string {
  const brandName = typeof value === 'string' ? value : productName;
  if (brandName !== productName)
    throw new Error('product.json name and guides/assets/brand.json brandName must match');
  return brandName;
}

function brandColor(palette: Record<string, unknown>, key: string): string {
  const value = palette[key];
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/iu.test(value))
    throw new Error(`Invalid guide brand color: ${key}`);
  return value.toUpperCase();
}

function editionKind(output: string): GuideKind {
  const name = output.slice(output.lastIndexOf('/') + 1);
  if (name.startsWith('product-')) return 'product';
  if (name.startsWith('operator-')) return 'operator';
  if (name.startsWith('user-')) return 'user';
  return name.startsWith('b2b-') ? 'b2b' : 'generic';
}

function coverLabel(kind: GuideKind, locale: string): string {
  const labels = {
    product: ['PRODUCT GUIDE', 'PRZEWODNIK PRODUKTOWY'],
    operator: ['OPERATOR GUIDE', 'PRZEWODNIK OPERATORA'],
    user: ['DEVICE USER GUIDE', 'PRZEWODNIK UŻYTKOWNIKA'],
    b2b: ['BUSINESS FLEET GUIDE', 'PRZEWODNIK FLOTY FIRMOWEJ'],
    generic: ['PRODUCT GUIDE', 'PRZEWODNIK PRODUKTOWY'],
  } as const;
  return labels[kind][locale === 'pl' ? 1 : 0];
}

function coverSubtitle(kind: GuideKind, locale: string): string {
  const subtitles = {
    product: ['Product and deployment overview', 'Opis produktu i wdrożenia'],
    operator: ['Technical deployment and operations', 'Wdrożenie techniczne i obsługa'],
    user: ['Everyday use and handoff', 'Codzienne użytkowanie i odbiór'],
    b2b: ['Business decisions and fleet operations', 'Decyzje biznesowe i obsługa floty'],
    generic: ['Product and deployment overview', 'Opis produktu i wdrożenia'],
  } as const;
  return subtitles[kind][locale === 'pl' ? 1 : 0];
}

function guideCover(
  output: string,
  locale: string,
  title: string,
  productName: string,
  version: string,
  brand: GuideBrand,
): string {
  const kind = editionKind(output);
  const image =
    kind === 'generic' ? '' : `<img class="cover-photo" src="assets/photos/cover-${kind}.png" alt="">`;
  const logo = brand.logo ? `<img class="cover-logo" src="${escapeHtml(brand.logo)}" alt="">` : '';
  const draft =
    locale === 'pl'
      ? 'WERSJA ROBOCZA · NIE JEST CERTYFIKATEM URZĄDZENIA'
      : 'QUALIFICATION DRAFT · NOT A DEVICE CERTIFICATE';
  return `<section class="guide-cover">${image}<div class="cover-shade"></div><div class="cover-copy">${logo}<p class="cover-brand">${escapeHtml(productName)}</p><p class="cover-label">${coverLabel(kind, locale)}</p><h1>${title}</h1><p class="cover-subtitle">${coverSubtitle(kind, locale)}</p><p class="cover-meta">${version} · ${locale.toUpperCase()} · ${draft}</p></div></section>`;
}

function guideStyles(brand: GuideBrand): string {
  const family = `'${escapeHtml(brand.fontFamily)}',sans-serif`;
  const fontFace = brand.fontAsset
    ? `@font-face{font-family:'${escapeHtml(brand.fontFamily)}';src:url('${escapeHtml(brand.fontAsset)}');font-style:normal;font-weight:100 900}`
    : '';
  return `${fontFace}:root{--brand-primary:${brand.primary};--brand-secondary:${brand.secondary};--brand-accent:${brand.accent}}@page{size:A4;margin:0}@page pxvoffice{size:A4;margin:15mm 18mm 25mm}html[data-print-mode="office"]{page:pxvoffice}@page pxvprint{size:216mm 303mm;margin:0}html[data-print-mode="print"]{page:pxvprint}*{box-sizing:border-box}html{font-family:${family};color:#17222d}body{margin:0;font:12px/1.55 ${family};overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:25px;line-height:1.16;margin:0 0 10mm}h2{font-size:17px;line-height:1.25;margin:22px 0 9px;color:var(--brand-primary);break-after:avoid}h3{font-size:13px;color:var(--brand-secondary);break-after:avoid}p{orphans:3;widows:3}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf1f3;padding:10px;break-inside:avoid;font:9px/1.5 'DejaVu Sans Mono',monospace}code{font:10px 'DejaVu Sans Mono',monospace}table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed;margin:8px 0 12px}td,th{padding:6px;border-bottom:1px solid #b5bcc4;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e8eef0;color:var(--brand-primary)}thead{display:table-header-group}a{color:var(--brand-secondary)}li,figure,tr{break-inside:avoid}.guide-content{max-width:800px}.guide-cover{position:relative;overflow:hidden;background:var(--brand-primary);color:white;min-height:340px;margin:0 0 24px}.cover-photo,.cover-shade{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.cover-shade{background:linear-gradient(90deg,rgba(12,28,42,.9),rgba(12,28,42,.24))}.cover-copy{position:absolute;z-index:1;left:8%;right:8%;top:10%;bottom:10%;display:flex;flex-direction:column;justify-content:flex-end}.cover-brand{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.cover-label{font-size:10px;letter-spacing:.14em;color:#fff;margin:0 0 12px}.cover-copy h1{max-width:88%;font-size:31px;margin:0 0 14px;color:white}.cover-subtitle{margin:0 0 20px;font-size:14px}.cover-meta{font-size:9px;letter-spacing:.08em}.cover-logo{position:absolute;top:0;left:0;max-width:42mm;max-height:24mm;object-fit:contain;background:#fff;border-radius:4px;padding:5px}.print-opener{break-before:page;position:relative;width:calc(100% + 36mm);margin:0 -18mm 12mm;padding:18mm 24mm 16mm;background:var(--brand-secondary);color:white}.print-opener::after{content:'';position:absolute;left:0;bottom:0;width:100%;height:4mm;background:var(--brand-accent)}.print-opener h2{font-size:26px;color:white;margin:0}.html-edition{font-size:10px;color:#526374;margin:0 0 16px}@media screen{body{max-width:850px;margin:30px auto;padding:0 20px}.guide-cover{height:58vh;min-height:380px;border-radius:4px}.guide-content{padding:0 6px}}html[data-print-mode="office"] body{font-size:11px;color:#17222d;background:#fff}html[data-print-mode="office"] .guide-cover{height:72mm;min-height:72mm;border-radius:0;margin:0 0 10mm;background:#eef2f4}html[data-print-mode="office"] .cover-photo{height:72mm}html[data-print-mode="office"] .cover-shade{height:72mm;background:linear-gradient(90deg,rgba(12,28,42,.88),rgba(12,28,42,.15))}html[data-print-mode="office"] .cover-copy{top:8mm;bottom:8mm;left:12mm;right:12mm}html[data-print-mode="office"] .cover-copy h1{font-size:21px;max-width:100%;margin:0 0 5mm}html[data-print-mode="office"] .cover-subtitle{font-size:11px;margin:0 0 7mm}html[data-print-mode="office"] .cover-brand{font-size:9px;margin:0 0 6mm}html[data-print-mode="office"] .cover-label{font-size:8px;margin:0 0 5mm}html[data-print-mode="office"] .cover-meta{font-size:8px;margin:0}html[data-print-mode="office"] .cover-logo{max-width:28mm;max-height:14mm}html[data-print-mode="office"] .guide-content{margin:0}html[data-print-mode="office"] .print-opener{break-before:auto;width:auto;margin:18px 0 10px;padding:6px 10px;background:#eef2f4;color:var(--brand-primary);border-left:4px solid var(--brand-accent)}html[data-print-mode="office"] .print-opener h2{font-size:16px;color:var(--brand-primary)}html[data-print-mode="office"] .print-opener::after{display:none}html[data-print-mode="print"] body{background:#f0f4f6;color:#17222d}html[data-print-mode="print"] body::before{content:'';position:fixed;z-index:-1;inset:-18mm;background:linear-gradient(135deg,#f8fafb,#eaf0f2)}html[data-print-mode="print"] .guide-cover{height:303mm;min-height:303mm;width:calc(100% + 36mm);margin:-18mm -18mm 0;break-after:page;border-radius:0}html[data-print-mode="print"] .cover-shade{background:linear-gradient(120deg,rgba(12,28,42,.9),rgba(12,28,42,.22))}html[data-print-mode="print"] .cover-copy{left:24mm;right:24mm;top:26mm;bottom:26mm}html[data-print-mode="print"] .cover-copy h1{font-size:34px;max-width:85%}html[data-print-mode="print"] .cover-subtitle{font-size:16px}html[data-print-mode="print"] .cover-brand{font-size:15px}html[data-print-mode="print"] .cover-label{font-size:11px}html[data-print-mode="print"] .cover-meta{font-size:10px}html[data-print-mode="print"] .cover-logo{max-width:48mm;max-height:26mm}html[data-print-mode="print"] .guide-content{margin:0;padding-bottom:14mm}html[data-print-mode="print"] h2:not(.print-opener){background:#e1eaed;border-left:3mm solid var(--brand-primary);padding:4mm 5mm;margin-top:14mm}html[data-print-mode="print"] h3{border-bottom:1px solid var(--brand-accent);padding-bottom:2mm}html[data-print-mode="print"] th{background:var(--brand-primary);color:white}html[data-print-mode="print"] pre{background:#e1eaed;border-left:2mm solid var(--brand-accent)}html[data-print-mode="print"] .print-opener{width:calc(100% + 36mm);margin:-18mm -18mm 12mm;padding:30mm 24mm 18mm;min-height:115mm;background:linear-gradient(125deg,var(--brand-primary),var(--brand-secondary));color:white;break-before:page}html[data-print-mode="print"] .print-opener h2{color:white;background:transparent;border:0;padding:0;margin:0;font-size:28px}html[data-print-mode="print"] .guide-cover{width:100%;margin:0}html[data-print-mode="print"] .guide-content{max-width:none;padding:18mm;box-decoration-break:clone;-webkit-box-decoration-break:clone}html[data-print-mode="print"] .html-edition{display:none}html[data-print-mode="print"] .guide-content h2.print-opener:first-of-type{break-before:auto}`;
}

function guideHtml(
  productName: string,
  version: string,
  locale: string,
  rendered: string,
  brand: GuideBrand,
  output: string,
): string {
  const heading = /<h1(?:\s[^>]*)?>(.*?)<\/h1>/isu.exec(rendered);
  const title = heading?.[1] ?? escapeHtml(productName);
  const body = heading ? rendered.replace(heading[0], '') : rendered;
  const content = body.replace(
    /<!--\s*print:opener\s*-->\s*<h2>(.*?)<\/h2>/gsu,
    '<h2 class="print-opener">$1</h2>',
  );
  const cover = guideCover(output, locale, title, productName, version, brand);
  const language = locale === 'pl' ? 'pl' : 'en';
  const draft =
    locale === 'pl'
      ? 'Wersja do kwalifikacji - nie jest certyfikatem urządzenia'
      : 'Qualification draft - not a device certificate';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)} - ${escapeHtml(title.replace(/<[^>]*>/gu, ''))}</title><style>${guideStyles(brand)}</style></head><body>${cover}<main class="guide-content"><p class="html-edition">${escapeHtml(productName)} | ${version} | ${locale.toUpperCase()} | ${draft}</p>${content}</main></body></html>`;
}

function indexLabel(name: string): string {
  const locale = name.endsWith('-pl') ? 'PL' : 'EN';
  const labels = { product: 'Product', operator: 'Operator', user: 'User', b2b: 'Business fleet' };
  const label = labels[editionKind(name) as Exclude<GuideKind, 'generic'>] ?? 'Guide';
  return `${label} (${locale})`;
}

function guideIndex(
  productName: string,
  version: string,
  brand: GuideBrand,
  editions: string[],
  pdfOutput: boolean,
): string {
  const rows = editions
    .map((name) => {
      const pdfs = pdfOutput
        ? ` · <a href="${name}-office.pdf">Office PDF</a> · <a href="${name}-print.pdf">Print PDF</a>`
        : '';
      return `<li>${indexLabel(name)}: <a href="${name}.html">HTML</a>${pdfs} · <a href="source/markdown/${name}.md">Markdown</a></li>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)} ${version} guides</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;color:#17222d}h1{color:${brand.primary}}a{color:${brand.secondary}}li{margin:.8rem 0}small{color:#526374}</style></head><body><h1>${escapeHtml(productName)} ${version} guides</h1><p>Four guide types in English and Polish. General qualification drafts; these guides are not device certificates. Read the accepted handoff record for a specific phone.</p><p>PDFs and HTML are generated from the source checkout with <code>pxv guides rebuild</code>.</p><ul>${rows}</ul></body></html>`;
}

async function setPrintPageBoxes(path: string): Promise<void> {
  const document = await PDFDocument.load(await readFile(path));
  const millimeters = (value: number): number => (value * 72) / 25.4;
  const bleed = millimeters(3);
  const trimWidth = millimeters(210);
  const trimHeight = millimeters(297);
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    if (Math.abs(width - millimeters(216)) > 2 || Math.abs(height - millimeters(303)) > 2)
      throw new Error('Print renderer did not produce a 216 x 303 mm page');
    page.setCropBox(0, 0, width, height);
    page.setBleedBox(0, 0, width, height);
    page.setTrimBox(bleed, bleed, trimWidth, trimHeight);
    page.setArtBox(bleed, bleed, trimWidth, trimHeight);
  }
  await writeFile(path, await document.save());
}

async function renderGuidePdfs(
  outputs: string[],
  destination: string,
  options: DocumentationOptions,
  productName: string,
  brand: GuideBrand,
): Promise<void> {
  const browser = await (options.browser ?? chromium).launch({
    ...(options.chromiumExecutable ? { executablePath: options.chromiumExecutable } : {}),
    headless: true,
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'file:') {
        const path = resolve(fileURLToPath(url));
        if (path.startsWith(`${destination}${sep}`)) {
          await route.continue();
          return;
        }
      }
      await route.abort();
    });
    const page = await context.newPage();
    for (const output of outputs) {
      await page.goto(pathToFileURL(output).href, { waitUntil: 'load' });
      await page.evaluate(async () => {
        for (const anchor of document.querySelectorAll('a')) {
          if (!/^(https?:|mailto:|#)/u.test(anchor.getAttribute('href') ?? ''))
            anchor.removeAttribute('href');
        }
        await document.fonts.ready;
      });
      for (const mode of printModes) {
        await page.evaluate((selected) => {
          document.documentElement.dataset['printMode'] = selected;
        }, mode);
        const pdf = output.slice(0, -extname(output).length) + `-${mode}.pdf`;
        if (mode === 'office') await renderOfficePdf(page, pdf, productName, brand);
        else await renderPrintPdf(page, pdf);
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

async function renderOfficePdf(
  page: Page,
  path: string,
  productName: string,
  brand: GuideBrand,
): Promise<void> {
  await page.pdf({
    path,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="font-family:Arial,sans-serif;font-size:8px;color:${brand.secondary};width:100%;padding:0 18mm;display:flex;justify-content:space-between"><span>${escapeHtml(productName)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
}

async function renderPrintPdf(page: Page, path: string): Promise<void> {
  await page.pdf({
    path,
    width: '216mm',
    height: '303mm',
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: false,
  });
  try {
    await setPrintPageBoxes(path);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

export async function buildDocumentation(
  sourceRoot: string,
  outputRoot: string,
  options: DocumentationOptions = {},
): Promise<string[]> {
  const root = resolve(sourceRoot);
  const destination = resolve(outputRoot);
  const product = validateProduct(parseDocument(await readFile(join(root, 'product.json'), 'utf8')));
  const paths = await walkPublic(root, 'guides/source/markdown', new Set(['.md']));
  if (!paths.length) throw new Error('No public guide sources found');
  await mkdir(destination, { recursive: true });
  const assets = await walkPublic(root, 'guides/assets');
  await copyGuideFiles(root, destination, [...assets, ...paths]);
  const brand = await loadBrand(root, destination, product.name);
  const outputs = await renderGuideHtmlSources(
    root,
    destination,
    paths,
    product.name,
    product.upstreamVersion,
    brand,
  );
  const editions = outputs.map((path) => path.slice(path.lastIndexOf('/') + 1, -5));
  await writeFile(
    join(destination, 'index.html'),
    guideIndex(product.name, product.upstreamVersion, brand, editions, options.pdf ?? false),
  );
  if (options.pdf) await renderGuidePdfs(outputs, destination, options, product.name, brand);
  return outputs;
}

async function copyGuideFiles(root: string, destination: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const output = join(destination, path.slice('guides/'.length));
    await mkdir(dirname(output), { recursive: true });
    if (resolve(join(root, path)) !== resolve(output)) await copyFile(join(root, path), output);
  }
}

async function renderGuideHtmlSources(
  root: string,
  destination: string,
  paths: string[],
  productName: string,
  version: string,
  brand: GuideBrand,
): Promise<string[]> {
  const outputs: string[] = [];
  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8');
    const locale = /(?:^|[._/-])pl(?:[._/-]|$)/u.test(path) ? 'pl' : 'en';
    const rendered = (await marked.parse(source, { async: true }))
      .replaceAll('src="../../assets/', 'src="assets/')
      .replace(/(<a\b[^>]*?)\s+href="(?!https?:|mailto:|#)[^"]*"([^>]*>)/gu, '$1$2');
    const html = guideHtml(productName, version, locale, rendered, brand, path);
    const output = join(destination, path.slice('guides/source/markdown/'.length).replace(/\.md$/u, '.html'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, html);
    outputs.push(output);
  }
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chromiumExecutable = process.env['PXV_CHROMIUM'];
  buildDocumentation(process.cwd(), resolve('dist/guides'), {
    pdf: !process.argv.includes('--html-only'),
    ...(chromiumExecutable ? { chromiumExecutable } : {}),
  })
    .then((outputs) => {
      process.stdout.write(`${outputs.join('\n')}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${releaseFailure(error, 'Documentation build failed')}\n`);
      process.exitCode = 1;
    });
}
