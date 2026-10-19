/** The physical print contract. Build metadata describes this layout; it does not configure it. */
export const foldLayout = Object.freeze({
  sheetMm: Object.freeze([297, 210] as const),
  panelMm: Object.freeze([68, 100] as const),
  slipMm: Object.freeze([136, 100] as const),
  marginsMm: Object.freeze([12.5, 5] as const),
  grid: Object.freeze({ columns: 4, rows: 2, panelsPerSlip: 2 }),
  content: Object.freeze({ sideMm: 4, topMm: 4, bottomMm: 10, writingMm: 8 }),
  typography: Object.freeze({ bodyPt: 10, metadataPt: 8, headerLineMm: 3.3, headerColumns: 32 }),
  scale: Object.freeze({ xMm: 6, yMm: 20, lengthMm: 50, labelXMm: 10, labelYMm: 38 }),
});

function foldLayoutMetadata() {
  return {
    sheetMm: [...foldLayout.sheetMm],
    panelMm: [...foldLayout.panelMm],
    slipMm: [...foldLayout.slipMm],
    marginsMm: [...foldLayout.marginsMm],
  };
}

/** Reject apparent configuration changes which would otherwise silently be ignored. */
export function validateFoldLayoutMetadata(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Missing fold layout metadata');
  const fields = value as Record<string, unknown>;
  for (const [key, dimensions] of Object.entries(foldLayoutMetadata())) {
    if (JSON.stringify(fields[key]) !== JSON.stringify(dimensions))
      throw new Error(`Fold layout metadata differs from the shared layout: ${key}`);
  }
}

function headerLines(value: string): string[] {
  const width = foldLayout.typography.headerColumns;
  const pending = Array.from(value.replace(/\s+/gu, ' ').trim());
  const result: string[] = [];
  while (pending.length > width) {
    const space = pending.slice(0, width + 1).lastIndexOf(' ');
    const end = space > 0 ? space : width;
    result.push(pending.splice(0, end).join(''));
    if (pending[0] === ' ') pending.shift();
  }
  if (pending.length) result.push(pending.join(''));
  return result;
}

function writingLines(label: string): string[] {
  const blanks = Math.ceil(foldLayout.content.writingMm / foldLayout.typography.headerLineMm) - 1;
  return [...headerLines(label), ...Array<string>(blanks).fill(''), '_'.repeat(30)];
}

function cssText(lines: string[]): string {
  return lines
    .map((line) => Array.from(line, (char) => `\\${char.codePointAt(0)!.toString(16)} `).join(''))
    .join('\\A ');
}

/** Native margin boxes repeat regardless of the height limits on repeating table headings. */
export function foldHeaderStyle(
  name: string,
  options: {
    lines: string[];
    profileField?: string;
    assetField?: string;
  },
): string {
  if (!/^[a-z][a-z0-9]*$/iu.test(name)) throw new Error('Invalid fold page name');
  const { content, typography, panelMm } = foldLayout;
  const lines = options.lines.flatMap(headerLines);
  if (options.profileField) lines.push(...writingLines(options.profileField));
  const top = lines.length ? lines.length * typography.headerLineMm + 2 * content.topMm : content.topMm;
  const asset = options.assetField ? writingLines(options.assetField) : [];
  const bottom =
    content.bottomMm + asset.length * typography.headerLineMm + (asset.length ? content.topMm : 0);
  if (top + bottom > panelMm[1] - 12) throw new Error('Fold identity exceeds panel capacity');
  const font = `font:${typography.metadataPt}pt/${typography.headerLineMm}mm 'DejaVu Sans Mono',monospace;white-space:pre`;
  return `@page ${name}{size:${panelMm[0]}mm ${panelMm[1]}mm;margin:${top}mm ${content.sideMm}mm ${bottom}mm;@top-left{content:"${cssText(lines)}";${font};vertical-align:middle}@bottom-left{content:"${cssText(asset)}";${font};vertical-align:bottom;padding-bottom:${content.bottomMm}mm}}`;
}
