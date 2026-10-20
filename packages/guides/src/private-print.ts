import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { CommandRunner, readBounded, writeRegistryPrivateFile, type Runtime } from '@pxv/runtime';

export interface PrivatePrintOptions {
  locale?: 'en' | 'pl';
  chromiumExecutable: string;
  runtime?: Runtime;
}

export function printLocale(locale: string = 'en'): 'en' | 'pl' {
  if (locale !== 'en' && locale !== 'pl') throw new Error('Unsupported print locale');
  return locale;
}

export function escapePrint(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

/** Only this fixed layout program may execute; all supplied data is escaped text. */
export function printDocument(locale: 'en' | 'pl', css: string, body: string, script: string): string {
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>PXV_LAYOUT_PENDING</title><style>${css}</style></head><body>${body}<script>${script}</script></body></html>`;
}

/** Chromium rounds custom paper sizes; normalize boxes after verifying the intended layout. */
export async function normalizePrintPdf(
  bytes: Uint8Array,
  sizeMm: readonly [number, number],
  single: boolean,
): Promise<Buffer> {
  const document = await PDFDocument.load(bytes);
  const pages = document.getPages();
  if (document.getTitle() !== 'PXV_LAYOUT_OK' || !pages.length || (single && pages.length !== 1))
    throw new Error('Print layout did not fit');
  const [width, height] = sizeMm.map((mm) => (mm * 72) / 25.4) as [number, number];
  for (const page of pages) {
    if (Math.abs(page.getWidth() - width) > 1 || Math.abs(page.getHeight() - height) > 1)
      throw new Error('Unexpected print dimensions');
    page.setSize(width, height);
  }
  document.setTitle('Device box insert');
  return Buffer.from(await document.save());
}

export async function renderPrivatePdf(
  temporary: string,
  html: string,
  options: PrivatePrintOptions,
): Promise<Buffer> {
  if (!options.chromiumExecutable) throw new Error('Local Chromium is required');
  const source = join(temporary, 'print.html');
  const output = join(temporary, 'print.pdf');
  await writeRegistryPrivateFile(source, Buffer.from(html));
  const result = await (options.runtime ?? new CommandRunner()).run(
    [
      options.chromiumExecutable,
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--user-data-dir=' + join(temporary, 'profile'),
      '--no-pdf-header-footer',
      '--print-to-pdf=' + output,
      pathToFileURL(source).href,
    ],
    { timeoutMs: 30_000, env: { PATH: '/usr/bin:/bin', HOME: temporary } },
  );
  if (result.code !== 0) throw new Error('Local rendering failed');
  return readBounded(output, 32 * 1024 * 1024);
}

export async function withPrivatePrint<T>(render: (directory: string) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), 'pxv-private-print-'));
  try {
    return await render(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
