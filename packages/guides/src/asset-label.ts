import { join, extname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { CommandRunner, readBounded, writeRegistryPrivateFile, writeRegistryPrivatePair } from '@pxv/runtime';
import {
  escapePrint as escape,
  normalizePrintPdf,
  printDocument,
  printLocale,
  renderPrivatePdf,
  withPrivatePrint,
  type PrivatePrintOptions,
} from './private-print.js';

export interface AssetLabelInput {
  assetId: string;
  canonicalSerial: string;
  month: string;
}
interface AssetLabelWriteOptions extends PrivatePrintOptions {
  pdftoppmExecutable?: string;
}

/** Resolve the machine-local month once; renderers receive a deterministic YYYYMM value. */
export function assetLabelMonth(override?: string, now = new Date()): string {
  const month =
    override ?? `${String(now.getFullYear()).padStart(4, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!/^[0-9]{4}(?:0[1-9]|1[0-2])$/u.test(month))
    throw new Error('Label date must be YYYYMM with month 01-12');
  return month;
}

const labels = {
  en: ['Asset', 'Serial', 'Date'],
  pl: ['Zasób', 'Seryjny', 'Data'],
};
const styles = `
@page{size:40mm 15mm;margin:0}
*{box-sizing:border-box}
body{margin:0;color:#000;background:#fff;font:7pt/3.5mm 'DejaVu Sans Mono',monospace}
.label{width:40mm;height:15mm;padding:2mm;display:flex;flex-direction:column;justify-content:center}
.line{white-space:pre;flex:none}
`;
const measure = `
(() => {
  const label = document.querySelector('.label');
  const lines = [...label.children];
  const available = label.clientWidth - 2 * parseFloat(getComputedStyle(label).paddingLeft);
  const fits = lines.every(line => {
    const range = document.createRange();
    range.selectNodeContents(line);
    return range.getBoundingClientRect().width <= available;
  });
  document.title = fits && label.scrollHeight <= label.clientHeight ? 'PXV_LAYOUT_OK' : 'PXV_LAYOUT_ERROR';
})();`;

export function renderAssetLabel(input: AssetLabelInput, options: { locale?: 'en' | 'pl' } = {}): string {
  const locale = printLocale(options.locale);
  assetLabelMonth(input.month);
  for (const text of [input.assetId, input.canonicalSerial])
    if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text))
      throw new Error('Invalid asset label identity');
  const body = [input.assetId, input.canonicalSerial, input.month]
    .map((text, index) => `<div class="line">${labels[locale][index]}: ${escape(text)}</div>`)
    .join('');
  return printDocument(locale, styles, `<section class="label">${body}</section>`, measure);
}

async function rasterizeLabel(
  directory: string,
  pdf: Buffer,
  options: AssetLabelWriteOptions,
): Promise<Buffer> {
  const source = join(directory, 'label.pdf');
  await writeRegistryPrivateFile(source, pdf);
  const result = await (options.runtime ?? new CommandRunner()).run(
    [
      options.pdftoppmExecutable ?? 'pdftoppm',
      '-r',
      '300',
      '-singlefile',
      '-png',
      source,
      join(directory, 'label'),
    ],
    { timeoutMs: 30_000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: directory } },
  );
  if (result.code !== 0) throw new Error('Label rasterization failed');
  const png = await readBounded(join(directory, 'label.png'), 32 * 1024 * 1024);
  await validateLabelPng(png);
  return png;
}

async function validateLabelPng(png: Buffer): Promise<void> {
  if (
    png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    png.length < 33 ||
    png.readUInt32BE(16) !== 473 ||
    png.readUInt32BE(20) !== 178
  )
    throw new Error('Invalid label PNG');
  const image = await (await PDFDocument.create()).embedPng(png);
  if (image.width !== 473 || image.height !== 178) throw new Error('Invalid label image');
}

export async function writeAssetLabel(
  input: AssetLabelInput,
  destination: string,
  options: AssetLabelWriteOptions,
): Promise<void> {
  let raw: Buffer | undefined;
  let pdf: Buffer | undefined;
  let png: Buffer | undefined;
  try {
    if (extname(destination)) throw new Error('Label output must be an extensionless basename');
    await withPrivatePrint(async (directory) => {
      raw = await renderPrivatePdf(directory, renderAssetLabel(input, options), options);
      pdf = await normalizePrintPdf(raw, [40, 15], true);
      png = await rasterizeLabel(directory, pdf, options);
      await writeRegistryPrivatePair(
        { path: destination + '.pdf', bytes: pdf },
        { path: destination + '.png', bytes: png },
      );
    });
  } catch {
    throw new Error(
      'Private asset label export failed; check content fits 40 x 15 mm, new private destinations, local Chromium and Poppler',
    );
  } finally {
    raw?.fill(0);
    pdf?.fill(0);
    png?.fill(0);
  }
}
