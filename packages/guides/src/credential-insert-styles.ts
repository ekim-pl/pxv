import { foldPanelStyles } from './fold-packet.js';

/** Registry values flow through tables; missing fields retain space for handwriting. */
export const credentialInsertStyles =
  foldPanelStyles +
  `
body{color:#111;line-height:1.15}
[data-fold-group]+[data-fold-group]{break-before:page}
h1{font-size:12pt;line-height:1.1;margin:0 0 2mm}
.summary,.note,.identity,.state,.empty{font-size:8pt;line-height:1.2}
.summary{margin-bottom:2mm}
.summary div{overflow-wrap:anywhere}
.note{margin:0 0 2mm}
.credential-section{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 2mm}
.credential-section thead{display:table-header-group}
.credential-section th,.credential-section td{text-align:left;vertical-align:top;padding:0;font-weight:normal}
.credential-section th{padding-top:1.5mm;border-top:.3mm solid #111}
.credential-section h2,.group-title{font-size:10pt;font-weight:bold;line-height:1.15;margin:0 0 .8mm}
.identity{margin:0 0 .8mm}
.state{font-weight:normal;white-space:normal;overflow-wrap:anywhere;margin:0 0 1mm}
.credential-section tr{break-inside:avoid}
@media print{.profile-section thead .section-title,.profile-section .identity{display:none}}
.entry{margin:0 0 1.2mm}
.entry h3{font-size:8pt;font-weight:bold;line-height:1.15;margin:0 0 .3mm}
.manual{font-size:8pt;line-height:1.2;margin:0}
.entry pre.value{font:10pt/1.15 'DejaVu Sans Mono',monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;margin:0;padding:0;border:0}
.empty{margin:0 0 1mm}
.credential-warning{font-weight:bold;border:.6mm solid #111;padding:2mm;margin-bottom:2mm}
.warning{font-weight:bold}
.group-title{break-after:avoid;margin-top:2mm}
`;
