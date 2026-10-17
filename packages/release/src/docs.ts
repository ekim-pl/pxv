import { marked } from 'marked';
import { chromium, type Page } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, validatePolicy, validateProduct } from '@pxv/contracts';
import type { ExecutionPolicy } from '@pxv/contracts';
import { walkPublic } from './candidate.js';
import { renderPolicyBooklet } from './booklet.js';
import { guideNavigation, type GuideEdition } from './guide-navigation.js';

interface DocumentationOptions {
  pdf?: boolean;
  chromiumExecutable?: string;
  browser?: Pick<typeof chromium, 'launch'>;
  policy?: unknown;
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
type GuideKind = 'operator' | 'user' | 'quickstart' | 'credentials' | 'generic';
interface GuideFormat {
  size: 'A4' | 'A5';
  width: number;
  height: number;
}
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
  if (name.startsWith('operator-')) return 'operator';
  if (name.startsWith('user-')) return 'user';
  if (name.startsWith('quickstart-')) return 'quickstart';
  if (name.startsWith('credentials-')) return 'credentials';
  return 'generic';
}

function guideFormat(output: string): GuideFormat {
  const kind = editionKind(output);
  return kind === 'quickstart' || kind === 'credentials'
    ? { size: 'A5', width: 148, height: 210 }
    : { size: 'A4', width: 210, height: 297 };
}

function coverLabel(kind: GuideKind, locale: string): string {
  const labels = {
    operator: ['OPERATOR GUIDE', 'PRZEWODNIK OPERATORA'],
    user: ['DEVICE USER GUIDE', 'PRZEWODNIK UŻYTKOWNIKA'],
    quickstart: ['DEVICE QUICK START', 'SZYBKI START'],
    credentials: ['PRIVATE CREDENTIAL INSERT', 'POUFNA KARTA DANYCH DOSTĘPOWYCH'],
    generic: ['GUIDE', 'PRZEWODNIK'],
  } as const;
  return labels[kind][locale === 'pl' ? 1 : 0];
}

function coverSubtitle(kind: GuideKind, locale: string): string {
  const subtitles = {
    operator: ['Technical deployment and operations', 'Wdrożenie techniczne i obsługa'],
    user: ['Everyday use and handoff', 'Codzienne użytkowanie i odbiór'],
    quickstart: ['Setup, privacy and security', 'Konfiguracja, prywatność i bezpieczeństwo'],
    credentials: ['Keep in a safe place', 'Przechowuj w bezpiecznym miejscu'],
    generic: ['Setup and use', 'Przygotowanie i użytkowanie'],
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
  if (guideFormat(output).size === 'A5')
    return `<section class="guide-cover compact-cover"><div class="cover-copy"><p class="cover-brand">${escapeHtml(productName)}</p><p class="cover-label">${coverLabel(kind, locale)}</p><h1>${title}</h1><p class="cover-meta">${version} · ${locale.toUpperCase()} · A5</p></div></section>`;
  const image =
    kind === 'generic' ? '' : `<img class="cover-photo" src="assets/photos/cover-${kind}.png" alt="">`;
  const logo = brand.logo ? `<img class="cover-logo" src="${escapeHtml(brand.logo)}" alt="">` : '';
  return `<section class="guide-cover">${image}<div class="cover-shade"></div><div class="cover-copy">${logo}<p class="cover-brand">${escapeHtml(productName)}</p><p class="cover-label">${coverLabel(kind, locale)}</p><h1>${title}</h1><p class="cover-subtitle">${coverSubtitle(kind, locale)}</p><p class="cover-meta">${version} · ${locale.toUpperCase()}</p></div></section>`;
}

function guideStyles(brand: GuideBrand): string {
  const family = `'${escapeHtml(brand.fontFamily)}',sans-serif`;
  const fontFace = brand.fontAsset
    ? `@font-face{font-family:'${escapeHtml(brand.fontFamily)}';src:url('${escapeHtml(brand.fontAsset)}');font-style:normal;font-weight:400}`
    : '';
  return `${fontFace}
:root{--brand-primary:${brand.primary};--brand-secondary:${brand.secondary};--brand-accent:${brand.accent}}
@page{size:A4;margin:0}
@page pxvoffice{size:A4;margin:15mm 18mm 20mm}
@page pxvprint{size:216mm 303mm;margin:18mm}
html[data-print-mode="office"]{page:pxvoffice}
html[data-print-mode="print"]{page:pxvprint}
*{box-sizing:border-box}
html{font-family:${family};color:#17222d}
body{margin:0;font:12px/1.45 ${family};overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:25px;line-height:1.18;margin:0 0 10mm}
h2{font-size:17px;line-height:1.25;margin:18px 0 9px;color:var(--brand-primary);break-after:avoid}
h3{font-size:13px;color:var(--brand-secondary);break-after:avoid}
p{orphans:3;widows:3}
img{max-width:100%}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf1f3;padding:10px;break-inside:avoid;font:9px/1.5 monospace}
code{font:10px monospace}
table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed;margin:8px 0 12px}
td,th{padding:6px;border-bottom:1px solid #b5bcc4;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#e8eef0;color:var(--brand-primary)}
thead{display:table-header-group}
a{color:var(--brand-secondary)}
li,figure,tr{break-inside:avoid}
.guide-cover{position:relative;overflow:hidden;background:var(--brand-primary);color:white;min-height:240px;margin:0 0 24px}
.cover-photo,.cover-shade{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cover-shade{background:linear-gradient(90deg,rgba(12,28,42,.94),rgba(12,28,42,.45))}
.cover-copy{position:relative;padding:28px 32px}
.cover-brand{font-size:12px;font-weight:700;letter-spacing:.05em}
.cover-label{font-size:10px;letter-spacing:.1em;margin:0 0 12px}
.cover-copy h1{font-size:29px;margin:0 0 14px;color:white}
.cover-subtitle{margin:0 0 16px;font-size:13px}
.cover-meta{font-size:10px;margin:0}
.cover-logo{max-width:42mm;max-height:20mm;object-fit:contain;background:#fff;padding:5px;margin-bottom:12px}
.html-edition{font-size:10px;color:#526374;margin:0 0 16px}
@media screen{body{max-width:850px;margin:30px auto;padding:0 20px}.guide-content{padding:0 6px}}
html[data-print-mode="office"] body{font-size:11px}
html[data-print-mode="office"] .guide-cover{min-height:0;background:white;color:var(--brand-primary);border-bottom:2px solid var(--brand-primary);margin:0 0 8mm}
html[data-print-mode="office"] .cover-photo,html[data-print-mode="office"] .cover-shade{display:none}
html[data-print-mode="office"] .cover-copy{padding:0 0 6mm}
html[data-print-mode="office"] .cover-copy h1{font-size:23px;color:var(--brand-primary)}
html[data-print-mode="office"] .cover-brand{font-size:10px}
html[data-print-mode="office"] .cover-label{font-size:9px}
html[data-print-mode="office"] .cover-subtitle{font-size:11px}
html[data-print-mode="office"] .cover-logo{max-width:30mm;max-height:14mm;padding:0}
html[data-print-mode="print"] body{font-size:12px}
html[data-print-mode="print"] .guide-cover{min-height:65mm;margin:0 0 10mm;border-bottom:3mm solid var(--brand-accent)}
html[data-print-mode="print"] .cover-copy{padding:9mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .guide-cover{min-height:50mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .cover-copy{padding:6mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .cover-brand{margin:0 0 2mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .cover-label{margin-bottom:2mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .cover-copy h1{margin-bottom:2mm}
html[data-print-mode="print"] body[data-guide-kind="user"] .cover-subtitle{margin-bottom:2mm}
html[data-print-mode="print"] th{background:var(--brand-primary);color:white}
@media print{.html-edition{display:none}}
${a5Styles()}`;
}

function a5Styles(): string {
  return `@page pxva5office{size:148mm 210mm;margin:10mm 10mm 14mm}
@page pxva5print{size:154mm 216mm;margin:13mm 13mm 17mm}
html[data-print-mode="office"] body.guide-a5{page:pxva5office}
html[data-print-mode="print"] body.guide-a5{page:pxva5print}
body.guide-a5,html[data-print-mode] body.guide-a5{font-size:10pt;line-height:1.34;color:#111}
.guide-a5 h1,.guide-a5 h2,.guide-a5 h3,.guide-a5 a{color:#111}
.guide-a5 h2{font-size:14pt;line-height:1.2;margin:0 0 3.5mm}
.guide-a5 h3{font-size:10.5pt;line-height:1.3;margin:4mm 0 2mm}
.guide-a5 p,.guide-a5 ul,.guide-a5 ol{margin:0 0 2.5mm}
.guide-a5 ul,.guide-a5 ol{padding-left:5mm}
.guide-a5 li{margin-bottom:1mm}
.guide-a5 ol{list-style:none;counter-reset:a5-step}
.guide-a5 ol>li{position:relative;counter-increment:a5-step}
.guide-a5 ol>li::before{content:counter(a5-step) ".";position:absolute;left:-5mm;width:3.5mm;text-align:right}
.guide-a5 table{font-size:8.5pt;margin:2mm 0 4mm}
.guide-a5 td,.guide-a5 th,html[data-print-mode] .guide-a5 th{padding:2mm;background:white;color:#111}
.guide-a5 code{font-size:8.8pt}
.guide-a5 pre{font-size:8pt;background:#f1f1f1}
.guide-a5 .guide-cover,html[data-print-mode] .guide-a5 .guide-cover{min-height:0;background:white;color:#111;border:0;margin:0 0 3mm;break-inside:avoid}
.guide-a5 .cover-copy,html[data-print-mode] .guide-a5 .cover-copy{padding:0 0 2mm}
.guide-a5 .cover-brand,html[data-print-mode] .guide-a5 .cover-brand{font-size:8.5pt;line-height:1.15;margin:0 0 1mm}
.guide-a5 .cover-label,html[data-print-mode] .guide-a5 .cover-label{font-size:7pt;line-height:1.2;letter-spacing:.04em;margin:0 0 1mm}
.guide-a5 .cover-copy h1,html[data-print-mode] .guide-a5 .cover-copy h1{font-size:16pt;line-height:1.1;color:#111;margin:0 0 1mm}
.guide-a5 .cover-meta{font-size:7pt;line-height:1.15;margin:0}
.guide-a5 .page-break{break-before:page}
.guide-a5 .a5-page{break-after:page}
.guide-a5 .a5-page:last-child{break-after:auto}
.guide-a5 .write-line{min-height:8mm;margin:0 0 2mm;padding:0 0 4mm;border-bottom:0.3mm dotted #555;break-inside:avoid;font-size:9pt;line-height:1.15}
.guide-a5 .profile-identity{font-size:9pt;line-height:1.25;margin:0 0 2.5mm;break-inside:avoid}
.guide-a5 .credential-warning{border:0.3mm solid #111;padding:2.5mm;margin:0 0 3mm;font-weight:400;break-inside:avoid}
@media screen{body.guide-a5{max-width:148mm}.guide-a5 .page-break{border-top:1px solid #bbb;margin:10mm 0;padding:5mm 0 0}}`;
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
  const cover = guideCover(output, locale, title, productName, version, brand);
  const language = locale === 'pl' ? 'pl' : 'en';
  const context =
    locale === 'pl'
      ? 'Instrukcja ogólna. Stan konkretnego telefonu potwierdza jego raport przekazania.'
      : 'General instructions. Use the handoff report for the status of a specific phone.';
  const sizeClass = guideFormat(output).size === 'A5' ? ' class="guide-a5"' : '';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)} - ${escapeHtml(title.replace(/<[^>]*>/gu, ''))}</title><style>${guideStyles(brand)}</style></head><body data-guide-kind="${editionKind(output)}"${sizeClass}>${cover}<main class="guide-content"><p class="html-edition">${escapeHtml(productName)} | ${version} | ${locale.toUpperCase()} | ${context}</p>${body}</main></body></html>`;
}

function indexLabel(name: string): string {
  const locale = name.endsWith('-pl') ? 'PL' : 'EN';
  const labels: Record<GuideKind, string> = {
    operator: 'Operator',
    user: 'User',
    quickstart: 'A5 recipient quick start',
    credentials: 'A5 private credential insert',
    generic: 'Guide',
  };
  const label = labels[editionKind(name)];
  return `${label} (${locale})`;
}

function guideIndex(
  productName: string,
  version: string,
  brand: GuideBrand,
  editions: string[],
  pdfOutput: boolean,
  policy?: ExecutionPolicy,
): string {
  const rows = editions
    .map((name) => {
      const size = guideFormat(name).size;
      const pdfs = pdfOutput
        ? ` · <a href="${name}-office.pdf">${size} office PDF</a> · <a href="${name}-print.pdf">${size} print PDF + 3 mm bleed</a>`
        : '';
      return `<li>${indexLabel(name)}: <a href="${name}.html">HTML</a>${pdfs} · <a href="source/markdown/${name}.md">Markdown</a></li>`;
    })
    .join('');
  const installation = policy
    ? `<p>A5 booklets describe the intended configuration for policy ${escapeHtml(policy.id)} (${policy.profiles.length} user accounts). This is document configuration, not device acceptance.</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)} ${version} guides</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;color:#17222d}h1{color:${brand.primary}}a{color:${brand.secondary}}li{margin:.8rem 0}small{color:#526374}</style></head><body><h1>${escapeHtml(productName)} ${version} guides</h1><p>Operator and device user guides, A5 recipient quick starts and blank private credential inserts in English and Polish. Use the accepted handoff report for the status of a specific phone.</p><p>PDFs and HTML are generated from the source checkout with <code>pxv guides rebuild</code>. Credential inserts are blank templates; completed copies contain private device information.</p>${installation}<ul>${rows}</ul></body></html>`;
}

async function setPrintPageBoxes(path: string, format: GuideFormat): Promise<void> {
  const document = await PDFDocument.load(await readFile(path));
  const millimeters = (value: number): number => (value * 72) / 25.4;
  const bleed = millimeters(3);
  const trimWidth = millimeters(format.width);
  const trimHeight = millimeters(format.height);
  const mediaWidth = format.width + 6;
  const mediaHeight = format.height + 6;
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    if (Math.abs(width - millimeters(mediaWidth)) > 2 || Math.abs(height - millimeters(mediaHeight)) > 2)
      throw new Error(`Print renderer did not produce a ${mediaWidth} x ${mediaHeight} mm page`);
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
      const format = guideFormat(output);
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
        if (mode === 'office') await renderOfficePdf(page, pdf, productName, brand, format);
        else await renderPrintPdf(page, pdf, productName, brand, format);
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

function footerOptions(productName: string, brand: GuideBrand, format: GuideFormat) {
  const color = format.size === 'A5' ? '#333333' : brand.secondary;
  const padding = format.size === 'A5' ? 10 : 18;
  return {
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="font-family:Arial,sans-serif;font-size:8px;color:${color};width:100%;padding:0 ${padding}mm;display:flex;justify-content:space-between"><span>${escapeHtml(productName)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  };
}

async function renderOfficePdf(
  page: Page,
  path: string,
  productName: string,
  brand: GuideBrand,
  format: GuideFormat,
): Promise<void> {
  await page.pdf({
    path,
    printBackground: true,
    preferCSSPageSize: true,
    ...footerOptions(productName, brand, format),
  });
}

async function renderPrintPdf(
  page: Page,
  path: string,
  productName: string,
  brand: GuideBrand,
  format: GuideFormat,
): Promise<void> {
  await page.pdf({
    path,
    width: `${format.width + 6}mm`,
    height: `${format.height + 6}mm`,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    printBackground: true,
    preferCSSPageSize: false,
    ...footerOptions(productName, brand, format),
  });
  try {
    await setPrintPageBoxes(path, format);
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
  const policy = options.policy === undefined ? undefined : validatePolicy(options.policy);
  if (policy) await ensureSeparatePolicyDestination(root, destination);
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
    assets,
    options.pdf ?? false,
    policy,
  );
  const editions = outputs.map((path) => path.slice(path.lastIndexOf('/') + 1, -5));
  await writeFile(
    join(destination, 'index.html'),
    guideIndex(product.name, product.upstreamVersion, brand, editions, options.pdf ?? false, policy),
  );
  if (options.pdf) await renderGuidePdfs(outputs, destination, options, product.name, brand);
  return outputs;
}

async function prospectiveRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await prospectiveRealpath(parent), basename(path));
  }
}

async function ensureSeparatePolicyDestination(root: string, destination: string): Promise<void> {
  const authoritative = join(root, 'guides');
  if (destination === authoritative || destination.startsWith(`${authoritative}${sep}`))
    throw new Error('Policy booklets require an output directory outside the authoritative guides directory');
  const [guides, output] = await Promise.all([
    prospectiveRealpath(authoritative),
    prospectiveRealpath(destination),
  ]);
  if (output === guides || output.startsWith(`${guides}${sep}`))
    throw new Error('Policy booklets require an output directory outside the authoritative guides directory');
  await ensureIndependentOutputFiles(destination);
}

async function ensureIndependentOutputFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Policy output must not contain symbolic links');
    const path = join(directory, entry.name);
    if (entry.isFile() && (await lstat(path)).nlink > 1)
      throw new Error('Policy output must not contain hardlinked files');
    if (entry.isDirectory()) await ensureIndependentOutputFiles(path);
  }
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
  assets: string[],
  pdfOutput: boolean,
  policy?: ExecutionPolicy,
): Promise<string[]> {
  const editions: GuideEdition[] = [];
  for (const path of paths) {
    let source = await readFile(join(root, path), 'utf8');
    const locale = /(?:^|[._/-])pl(?:[._/-]|$)/u.test(path) ? 'pl' : 'en';
    const kind = editionKind(path);
    if (policy && (kind === 'quickstart' || kind === 'credentials')) {
      source = renderPolicyBooklet(source, kind, policy, locale);
      await writeFile(join(destination, path.slice('guides/'.length)), source);
    }
    const rendered = (await marked.parse(source, { async: true })).replaceAll(
      'src="../../assets/',
      'src="assets/',
    );
    const html = guideHtml(productName, version, locale, rendered, brand, path);
    const outputPath = path.slice('guides/source/markdown/'.length).replace(/\.md$/u, '.html');
    editions.push({ sourcePath: path, outputPath, html });
  }
  const publicFiles = [...assets, ...paths].map((path) => path.slice('guides/'.length));
  publicFiles.push('index.html');
  if (pdfOutput)
    for (const edition of editions)
      for (const mode of printModes) publicFiles.push(edition.outputPath.replace(/\.html$/u, `-${mode}.pdf`));
  const outputs: string[] = [];
  for (const edition of guideNavigation(editions, publicFiles)) {
    const output = join(destination, edition.outputPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, edition.html);
    outputs.push(output);
  }
  return outputs;
}
