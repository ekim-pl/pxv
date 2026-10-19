import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { foldLayout } from './fold-layout.js';

const pt = (mm: number): number => (mm * 72) / 25.4;
interface FoldGroup {
  name: string;
  pdf: Uint8Array;
  /** Optional populated identity, drawn once in the top margin of each A4 sheet. */
  sheetHeader?: string;
}

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
  groups: FoldGroup[],
): Promise<{ pdf: Uint8Array; manifest: FoldManifest }> {
  if (!groups.length) throw new Error('Fold packet requires nonempty groups');
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const manifest: FoldManifest = {
    sheetSizeMm: [...foldLayout.sheetMm],
    panelSizeMm: [...foldLayout.panelMm],
    slipSizeMm: [...foldLayout.slipMm],
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
  group: FoldGroup,
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
  // Courier keeps even the maximum 128-character asset ID readable within the sheet margin.
  const headerFont = group.sheetHeader ? await output.embedFont(StandardFonts.Courier) : font;
  const perSheet = foldLayout.grid.columns * foldLayout.grid.rows;
  for (let start = 0; start < copied.length; start += perSheet) {
    const sheet = output.addPage([pt(foldLayout.sheetMm[0]), pt(foldLayout.sheetMm[1])]);
    manifest.sheets++;
    if (group.sheetHeader) {
      sheet.drawText(group.sheetHeader, {
        x: pt(foldLayout.marginsMm[0]),
        y: pt(foldLayout.sheetMm[1] - 3.5),
        size: foldLayout.typography.metadataPt,
        font: headerFont,
      });
    }
    for (let slot = 0; slot < perSheet; slot++) {
      const x = foldLayout.marginsMm[0] + (slot % foldLayout.grid.columns) * foldLayout.panelMm[0];
      const y =
        foldLayout.sheetMm[1] -
        foldLayout.marginsMm[1] -
        (Math.floor(slot / foldLayout.grid.columns) + 1) * foldLayout.panelMm[1];
      const panel = copied[start + slot];
      if (!panel) continue;
      // Embed a copied page without changing its physical scale.
      if (panel.node.Contents()) {
        const embedded = await output.embedPage(panel);
        sheet.drawPage(embedded, {
          x: pt(x),
          y: pt(y),
          width: pt(foldLayout.panelMm[0]),
          height: pt(foldLayout.panelMm[1]),
        });
      }
      const slip = slipOffset + Math.floor((start + slot) / foldLayout.grid.panelsPerSlip) + 1;
      const number = manifest.panels + 1;
      sheet.drawText(`${group.name} | Slip ${slip} | Panel ${number}`, {
        x: pt(x + foldLayout.content.sideMm),
        y: pt(y + 3),
        size: foldLayout.typography.metadataPt,
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
  return Math.ceil(pages.length / foldLayout.grid.panelsPerSlip);
}

function validatePanels(pages: PDFPage[]): void {
  for (const page of pages) {
    if (
      Math.abs(page.getWidth() - pt(foldLayout.panelMm[0])) > 1 ||
      Math.abs(page.getHeight() - pt(foldLayout.panelMm[1])) > 1
    )
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
  const [mx, my] = foldLayout.marginsMm;
  const [sw, sh] = foldLayout.sheetMm;
  const [pw, ph] = foldLayout.panelMm;
  const slipsAcross = foldLayout.grid.columns / foldLayout.grid.panelsPerSlip;
  for (let i = 0; i <= slipsAcross; i++)
    line(mx + i * foldLayout.slipMm[0], my, mx + i * foldLayout.slipMm[0], sh - my);
  for (let i = 0; i <= foldLayout.grid.rows; i++) line(mx, my + i * ph, sw - mx, my + i * ph);
  for (let i = 0; i < slipsAcross; i++)
    line(mx + pw + i * foldLayout.slipMm[0], my, mx + pw + i * foldLayout.slipMm[0], sh - my, true);
  const scale = foldLayout.scale;
  line(scale.xMm, scale.yMm, scale.xMm, scale.yMm + scale.lengthMm);
  line(scale.xMm - 1, scale.yMm, scale.xMm + 1, scale.yMm);
  line(scale.xMm - 1, scale.yMm + scale.lengthMm, scale.xMm + 1, scale.yMm + scale.lengthMm);
  sheet.drawText(`${scale.lengthMm} mm`, {
    x: pt(scale.labelXMm),
    y: pt(scale.labelYMm),
    size: foldLayout.typography.metadataPt,
    font,
    rotate: degrees(90),
  });
}

/** Shared compact print geometry. Panel footer space is reserved for imposition labels. */
export const foldPanelStyles = `
@page{size:${foldLayout.panelMm[0]}mm ${foldLayout.panelMm[1]}mm;margin:${foldLayout.content.topMm}mm ${foldLayout.content.sideMm}mm ${foldLayout.content.bottomMm}mm}
*{box-sizing:border-box}
body{font:${foldLayout.typography.bodyPt}pt/1.3 'DejaVu Sans',sans-serif;color:#111;margin:0;overflow-wrap:anywhere}
h1,h2{font-size:11pt;line-height:1.2;margin:0 0 2mm;color:#111}
h3{font-size:${foldLayout.typography.bodyPt}pt;line-height:1.2;margin:2mm 0 1mm;color:#111}
p,ul,ol{margin:0 0 2mm}ul,ol{padding-left:5mm}li{margin:0 0 1mm}
p{orphans:2;widows:2}a{color:#111}pre{font:${foldLayout.typography.bodyPt}pt/1.3 monospace;white-space:pre-wrap;margin:1mm 0;overflow-wrap:anywhere}
.fold-section{break-before:page;margin:0;font:inherit}
.fold-section .continuation{font-size:${foldLayout.typography.metadataPt}pt;font-weight:normal}
@media print{.fold-section>h2,.fold-section>.continuation{display:none}}
.write-line{min-height:${foldLayout.content.writingMm}mm;padding-bottom:${foldLayout.content.writingMm}mm;border-bottom:.2mm dotted #555;margin:0 0 2mm;break-inside:avoid;font-size:${foldLayout.typography.bodyPt}pt;line-height:1.2}
.profile-identity{font-size:${foldLayout.typography.bodyPt}pt}
.credential-warning,aside{border:.3mm solid #111;padding:2mm;margin:0 0 2mm}
.state{font-size:${foldLayout.typography.metadataPt}pt;font-weight:bold}
@media print{.html-edition{display:none}}
`;

export function foldPrintingInstructions(locale: 'en' | 'pl'): string {
  return locale === 'pl'
    ? `Drukuj A4 poziomo, jednostronnie, w skali 100% (rozmiar rzeczywisty). Sprawdź odcinek ${foldLayout.scale.lengthMm} mm. Tnij linie ciągłe; złóż linie przerywane, drukiem do środka. Ułóż według numerów kart i paneli. Rozmiar po złożeniu: ${foldLayout.panelMm[0]} × ${foldLayout.panelMm[1]} mm. Karty wymazania zapieczętuj oddzielnie.`
    : `Print A4 landscape, single-sided, at actual size / 100%. Check the ${foldLayout.scale.lengthMm} mm scale. Cut solid lines; fold dashed lines with printing inside. Stack by slip and panel number. Folded size: ${foldLayout.panelMm[0]} × ${foldLayout.panelMm[1]} mm. Seal erasure slips separately.`;
}
