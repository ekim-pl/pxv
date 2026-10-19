import { execFileSync } from 'node:child_process';
import { foldLayout } from '../../../packages/guides/dist/index.js';

/** Verify every printed word stays within its panel, including reserved footer space.
 * @param {string} pdf */
export function assertFoldPanelBounds(pdf) {
  const xml = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' });
  const pattern = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/gu;
  for (const word of xml.matchAll(pattern)) {
    const x1 = (Number(word[1]) * 25.4) / 72;
    const y1 = (Number(word[2]) * 25.4) / 72;
    const x2 = (Number(word[3]) * 25.4) / 72;
    const y2 = (Number(word[4]) * 25.4) / 72;
    if (x2 < foldLayout.marginsMm[0]) continue; // The 50 mm scale sits in the left sheet margin.
    const left =
      foldLayout.marginsMm[0] +
      Math.floor(((x1 + x2) / 2 - foldLayout.marginsMm[0]) / foldLayout.panelMm[0]) * foldLayout.panelMm[0];
    const top =
      foldLayout.marginsMm[1] +
      Math.floor(((y1 + y2) / 2 - foldLayout.marginsMm[1]) / foldLayout.panelMm[1]) * foldLayout.panelMm[1];
    // Small tolerances cover Chromium's pixel-to-point rounding and font ascenders.
    if (
      x1 < left + foldLayout.content.sideMm - 0.5 ||
      x2 > left + foldLayout.panelMm[0] - foldLayout.content.sideMm + 0.5 ||
      y1 < top + foldLayout.content.topMm - 1 ||
      y2 > top + foldLayout.panelMm[1] - 2
    )
      throw Error('Fold PDF text exceeds the panel margins');
  }
}
