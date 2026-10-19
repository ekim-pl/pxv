import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

const pt = (mm: number): number => (mm * 72) / 25.4;
export interface FoldPlacement {
  group: string;
  sheet: number;
  slip: number;
  panel: number;
  sourcePanel: number;
  xMm: number;
  yMm: number;
}
export interface FoldManifest {
  sheetSizeMm: [number, number];
  panelSizeMm: [number, number];
  slipSizeMm: [number, number];
  sheets: number;
  panels: number;
  placements: FoldPlacement[];
}

/** Groups always start on fresh sheets. Coordinates use the PDF bottom-left origin. */
export async function imposeFoldPacket(
  groups: { name: string; pdf: Uint8Array }[],
): Promise<{ pdf: Uint8Array; manifest: FoldManifest }> {
  if (!groups.length) throw new Error('Fold packet requires nonempty groups');
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const manifest: FoldManifest = {
    sheetSizeMm: [297, 210],
    panelSizeMm: [68, 100],
    slipSizeMm: [136, 100],
    sheets: 0,
    panels: 0,
    placements: [],
  };
  let slipOffset = 0;
  for (const group of groups) slipOffset += await imposeGroup(output, group, manifest, font, slipOffset);
  return { pdf: await output.save(), manifest };
}

async function imposeGroup(
  output: PDFDocument,
  group: { name: string; pdf: Uint8Array },
  manifest: FoldManifest,
  font: PDFFont,
  slipOffset: number,
): Promise<number> {
  const source = await PDFDocument.load(group.pdf);
  const pages = source.getPages();
  if (!pages.length) throw new Error('Fold packet requires nonempty groups');
  validatePanels(pages);
  // copyPages also supports otherwise-empty panels used in renderer fixtures.
  const copied = await output.copyPages(
    source,
    pages.map((_, index) => index),
  );
  for (let start = 0; start < copied.length; start += 8) {
    const sheet = output.addPage([pt(297), pt(210)]);
    manifest.sheets++;
    for (let slot = 0; slot < 8; slot++) {
      const x = 12.5 + (slot % 4) * 68;
      const y = slot < 4 ? 105 : 5;
      const panel = copied[start + slot];
      if (!panel) continue;
      // Embed a copied page without changing its physical scale.
      if (panel.node.Contents()) {
        const embedded = await output.embedPage(panel);
        sheet.drawPage(embedded, { x: pt(x), y: pt(y), width: pt(68), height: pt(100) });
      }
      const slip = slipOffset + Math.floor((start + slot) / 2) + 1;
      const number = manifest.panels + 1;
      sheet.drawText(`${group.name} | Slip ${slip} | Panel ${number}`, {
        x: pt(x + 4),
        y: pt(y + 3),
        size: 8,
        font,
      });
      manifest.placements.push({
        group: group.name,
        sheet: manifest.sheets,
        slip,
        panel: number,
        sourcePanel: start + slot + 1,
        xMm: x,
        yMm: y,
      });
      manifest.panels++;
    }
    drawMarks(sheet, font);
  }
  return Math.ceil(pages.length / 2);
}

function validatePanels(pages: PDFPage[]): void {
  for (const page of pages) {
    if (Math.abs(page.getWidth() - pt(68)) > 1 || Math.abs(page.getHeight() - pt(100)) > 1)
      throw new Error('Fold packet source panels must be 68 x 100 mm');
  }
}

function drawMarks(sheet: PDFPage, font: PDFFont): void {
  const line = (x1: number, y1: number, x2: number, y2: number, fold = false) =>
    sheet.drawLine({
      start: { x: pt(x1), y: pt(y1) },
      end: { x: pt(x2), y: pt(y2) },
      thickness: 0.3,
      color: rgb(0.35, 0.35, 0.35),
      ...(fold ? { dashArray: [2, 2] } : {}),
    });
  for (const x of [12.5, 148.5, 284.5]) line(x, 5, x, 205);
  for (const y of [5, 105, 205]) line(12.5, y, 284.5, y);
  for (const x of [80.5, 216.5]) line(x, 5, x, 205, true);
  // Side margin keeps the scale check clear of every cut slip.
  line(6, 20, 6, 70);
  line(5, 20, 7, 20);
  line(5, 70, 7, 70);
  sheet.drawText('50 mm', { x: pt(10), y: pt(38), size: 8, font, rotate: degrees(90) });
}

/** Shared compact print geometry. Panel footer space is reserved for imposition labels. */
export const foldPanelStyles = `
@page{size:68mm 100mm;margin:4mm 4mm 10mm}
*{box-sizing:border-box}
body{font:10pt/1.3 'DejaVu Sans',sans-serif;color:#111;margin:0;overflow-wrap:anywhere}
h1,h2{font-size:11pt;line-height:1.2;margin:0 0 2mm;color:#111}
h3{font-size:10pt;line-height:1.2;margin:2mm 0 1mm;color:#111}
p,ul,ol{margin:0 0 2mm}ul,ol{padding-left:5mm}li{margin:0 0 1mm}
p{orphans:2;widows:2}a{color:#111}pre{font:10pt/1.3 monospace;white-space:pre-wrap;margin:1mm 0;overflow-wrap:anywhere}
.fold-section{width:100%;border-collapse:collapse;table-layout:fixed;break-before:page;margin:0;font:inherit}
.fold-section:first-child{break-before:auto}
.fold-section thead{display:table-header-group}
.fold-section th,.fold-section td{border:0;background:white;color:#111;padding:0;text-align:left;font:inherit;overflow-wrap:anywhere}
.fold-section th{padding-bottom:2mm}
.fold-section .continuation{font-size:8pt;font-weight:normal}
.fold-section tr{break-inside:auto}
.write-line{min-height:8mm;padding-bottom:8mm;border-bottom:.2mm dotted #555;margin:0 0 2mm;break-inside:avoid;font-size:10pt;line-height:1.2}
.profile-identity{font-size:10pt}
.credential-warning,aside{border:.3mm solid #111;padding:2mm;margin:0 0 2mm}
.state{font-size:8pt;font-weight:bold}
@media print{.html-edition{display:none}}
`;

export function foldPrintingInstructions(locale: 'en' | 'pl'): string {
  return locale === 'pl'
    ? 'Drukuj A4 poziomo, jednostronnie, w skali 100% (rozmiar rzeczywisty). Sprawdź odcinek 50 mm. Tnij linie ciągłe; złóż linie przerywane, drukiem do środka. Ułóż według numerów kart i paneli. Rozmiar po złożeniu: 68 × 100 mm. Karty wymazania zapieczętuj oddzielnie.'
    : 'Print A4 landscape, single-sided, at actual size / 100%. Check the 50 mm scale. Cut solid lines; fold dashed lines with printing inside. Stack by slip and panel number. Folded size: 68 × 100 mm. Seal erasure slips separately.';
}
