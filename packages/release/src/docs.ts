#!/usr/bin/env node
import { marked } from 'marked';
import { chromium } from 'playwright';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, validateProduct } from '@pxv/contracts';
import { walkPublic } from './candidate.js';

export async function buildDocumentation(
  sourceRoot: string,
  outputRoot: string,
  options: { pdf?: boolean; chromiumExecutable?: string } = {},
): Promise<string[]> {
  const root = resolve(sourceRoot);
  const destination = resolve(outputRoot);
  const product = validateProduct(parseDocument(await readFile(join(root, 'product.json'), 'utf8')));
  const paths = await walkPublic(root, 'guides/source/markdown', new Set(['.md']));
  if (!paths.length) throw new Error('No public guide sources found');
  await mkdir(destination, { recursive: true });
  for (const path of await walkPublic(root, 'guides/assets')) {
    const output = join(destination, path.slice('guides/'.length));
    await mkdir(dirname(output), { recursive: true });
    if (resolve(join(root, path)) !== resolve(output)) await copyFile(join(root, path), output);
  }
  const outputs: string[] = [];
  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8');
    const locale = /(?:^|[._/-])pl(?:[._/-]|$)/u.test(path) ? 'pl' : 'en';
    const rendered = (await marked.parse(source, { async: true }))
      .replaceAll('src="../../assets/', 'src="assets/')
      .replace(/(<a\b[^>]*?)\s+href="(?!https?:|mailto:|#)[^"]*"([^>]*>)/gu, '$1$2');
    const draft =
      locale === 'pl'
        ? 'Wersja do kwalifikacji - dokument nie jest certyfikatem urządzenia'
        : 'Qualification draft - this document is not a device certificate';
    const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:"><title>${product.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</title><style>@font-face{font-family:GuideSans;src:url('assets/fonts/DejaVuSans.ttf')}@font-face{font-family:GuideSans;src:url('assets/fonts/DejaVuSans-Bold.ttf');font-weight:700}@font-face{font-family:GuideMono;src:url('assets/fonts/DejaVuSansMono.ttf')}@page{size:A4;margin:20mm 18mm}body{font:12px/1.55 GuideSans,sans-serif;color:#17222d;max-width:800px;margin:auto;overflow-wrap:anywhere}h1{font-size:25px;line-height:1.2;margin:0 0 22px}h2{font-size:17px;margin:24px 0 10px}h3{font-size:13px}h1,h2,h3{break-after:avoid}p{orphans:3;widows:3}img{max-width:100%;max-height:85mm;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f5;padding:10px;break-inside:avoid;font:9px/1.5 GuideMono,monospace}code{font:10px GuideMono,monospace}table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed}td,th{padding:6px;border-bottom:1px solid #b5bcc4;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf2f5}thead{display:table-header-group}a{color:#185b85}li,figure,tr{break-inside:avoid}.edition{font-size:8px;letter-spacing:.03em;color:#526374;border-bottom:1px solid #b5bcc4;padding-bottom:10px;margin-bottom:22px}</style></head><body><div class="edition">${product.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;')} | ${product.upstreamVersion} | ${locale.toUpperCase()}<br>${draft}</div>${rendered}</body></html>`;
    const output = join(destination, path.slice('guides/source/markdown/'.length).replace(/\.md$/u, '.html'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, html);
    outputs.push(output);
  }
  if (options.pdf) {
    const browser = await chromium.launch({
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
        await page.evaluate(() => {
          for (const anchor of document.querySelectorAll('a')) {
            if (!/^(https?:|mailto:|#)/u.test(anchor.getAttribute('href') ?? ''))
              anchor.removeAttribute('href');
          }
        });
        await page.pdf({
          path: output.slice(0, -extname(output).length) + '.pdf',
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate:
            '<div style="font-family:Arial,sans-serif;font-size:8px;color:#526374;width:100%;padding:0 18mm;display:flex;justify-content:space-between"><span>pxv 0.1.0 | Qualification draft</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
        });
      }
      await context.close();
    } finally {
      await browser.close();
    }
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
      process.stderr.write(`${error instanceof Error ? error.message : 'Documentation build failed'}\n`);
      process.exitCode = 1;
    });
}
