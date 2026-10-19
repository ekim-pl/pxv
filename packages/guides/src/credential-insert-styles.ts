import { foldPanelStyles } from './fold-packet.js';
import { foldLayout } from './fold-layout.js';

export const credentialInsertStyles =
  foldPanelStyles +
  [
    'body{color:#111}',
    '.private-panel{break-before:page;margin:0;font:inherit}',
    '.private-panel:first-child{break-before:auto}',
    '.private-panel>h1{font-size:16pt;line-height:1.15;margin:0 0 3mm;color:#111}',
    '.private-panel>p{margin:0 0 2mm;line-height:1.2}',
    '.private-panel .private-stamp{font-size:' +
      foldLayout.typography.bodyPt +
      'pt;font-weight:700;margin:0 0 2mm}',
    '.entry{break-inside:avoid;margin:0 0 1.4mm}',
    '.entry h3{font-size:' +
      foldLayout.typography.bodyPt +
      'pt;line-height:1.15;font-weight:400;margin:0 0 .5mm}',
    '.entry .state{font-size:' +
      foldLayout.typography.metadataPt +
      'pt;line-height:1.15;font-weight:600;margin:0 0 .5mm;color:#222}',
    '.entry pre.value{font:' +
      foldLayout.typography.bodyPt +
      'pt/1.25 "DejaVu Sans Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:0 0 .7mm;border:0;border-bottom:.2mm dotted #555;background:transparent;color:#111}',
    '.credential-warning{border:.3mm solid #111;padding:2mm;margin:0 0 2mm;line-height:1.2}',
    '.write-line{min-height:' +
      foldLayout.content.writingMm +
      'mm;padding-bottom:' +
      foldLayout.content.writingMm +
      'mm;border-bottom:.2mm dotted #555;margin:0 0 2mm;break-inside:avoid;font-size:' +
      foldLayout.typography.bodyPt +
      'pt;line-height:1.2}',
    '@media print{.html-edition{display:none}}',
  ].join('\n');
