import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from '../test-api.js';
import {
  foldLayout,
  validateFoldLayoutMetadata,
  foldHeaderStyle,
} from '../../packages/guides/src/fold-layout.js';
import { imposeFoldPacket } from '../../packages/guides/src/fold-packet.js';

const pt = (mm: number) => (mm * 72) / 25.4;
async function panels(count: number, width = 68): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < count; index++) {
    const page = pdf.addPage([pt(width), pt(100)]);
    page.drawText(`Sentinel panel ${index + 1}`, { x: pt(4), y: pt(70), size: 10 });
  }
  return pdf.save();
}

describe('A4 cut-and-fold imposition', () => {
  it('places actual-size panels in reading order and pads odd groups on separate sheets', async () => {
    const result = await imposeFoldPacket([
      { name: 'ordinary', pdf: await panels(9) },
      { name: 'erasure', pdf: await panels(3) },
    ]);
    const pdf = await PDFDocument.load(result.pdf);
    expect(pdf.getPageCount()).toBe(3);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(pt(297), 5);
      expect(page.getHeight()).toBeCloseTo(pt(210), 5);
    }
    const { placements } = result.manifest;
    expect(result.manifest.panels).toBe(12);
    expect(placements.slice(0, 8).map(({ xMm, yMm }) => [xMm, yMm])).toEqual([
      [12.5, 105],
      [80.5, 105],
      [148.5, 105],
      [216.5, 105],
      [12.5, 5],
      [80.5, 5],
      [148.5, 5],
      [216.5, 5],
    ]);
    expect(placements.map(({ slip }) => slip)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 6, 6, 7]);
    expect(placements[8]).toMatchObject({ sheet: 2, panel: 9, group: 'ordinary' });
    expect(placements[9]).toMatchObject({ sheet: 3, panel: 10, sourcePanel: 1, group: 'erasure' });
    expect(placements.filter(({ sheet }) => sheet === 2)).toHaveLength(1);
    expect(placements.filter(({ sheet }) => sheet === 3)).toHaveLength(3);
  });

  it('rejects empty packets', async () => {
    await expect(imposeFoldPacket([])).rejects.toThrow('nonempty groups');
  });

  it('rejects panels whose physical dimensions would require scaling', async () => {
    await expect(imposeFoldPacket([{ name: 'ordinary', pdf: await panels(1, 69) }])).rejects.toThrow(
      '68 x 100 mm',
    );
  });
});

it('validates build metadata against the immutable layout contract', () => {
  expect(Object.isFrozen(foldLayout)).toBe(true);
  expect(Object.isFrozen(foldLayout.panelMm)).toBe(true);
  expect(() => validateFoldLayoutMetadata(foldLayout)).not.toThrow();
  expect(() => validateFoldLayoutMetadata({ ...foldLayout, panelMm: [69, 100] })).toThrow('panelMm');
  expect(() => validateFoldLayoutMetadata(undefined)).toThrow('Missing fold layout');
});

it('escapes full untrusted identity text and rejects invalid page names', () => {
  const css = foldHeaderStyle('testpage', {
    lines: ['</style><script>literal</script>', 'Zażółć gęślą jaźń'],
    assetField: 'Device asset label',
  });
  expect(css).not.toContain('</style>');
  expect(css).toContain('@top-left{content:');
  expect(css).toContain('@bottom-left{content:');
  expect(() => foldHeaderStyle('bad;page', { lines: [] })).toThrow('Invalid fold page name');
});
