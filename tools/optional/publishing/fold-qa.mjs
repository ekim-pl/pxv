import { execFileSync } from 'node:child_process';

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
    if (x2 < 12.5) continue; // The 50 mm scale sits in the left sheet margin.
    const left = 12.5 + Math.floor(((x1 + x2) / 2 - 12.5) / 68) * 68;
    const top = (y1 + y2) / 2 < 105 ? 5 : 105;
    // Small tolerances cover Chromium's pixel-to-point rounding and font ascenders.
    if (x1 < left + 3.5 || x2 > left + 64.5 || y1 < top + 3 || y2 > top + 98)
      throw Error('Fold PDF text exceeds the panel margins');
  }
}
