import { foldPanelStyles } from './fold-packet.js';
import { foldLayout } from './fold-layout.js';

export const credentialInsertStyles = `${foldPanelStyles}
    :root{--ink:#17283d;--muted:#536477;--rule:#c5ced7;--accent:#246879;--accent-soft:#edf4f5;--danger:#9a3037;--danger-rule:#d5a7aa;--danger-soft:#fff5f4}
    body{font:${foldLayout.typography.bodyPt}pt/1.3 'DejaVu Sans',sans-serif;color:var(--ink)}
    section{break-before:page}section:first-child{break-before:auto}
    section>header{display:flex;justify-content:space-between;align-items:flex-start;gap:1mm;padding:0 0 1.2mm;margin:0 0 2mm;border-bottom:.35mm solid var(--rule);font-size:${foldLayout.typography.metadataPt}pt;line-height:1.1;font-weight:700;color:var(--muted);overflow-wrap:anywhere}
    .asset-label{color:var(--accent);letter-spacing:.25pt;text-transform:none}
    .page-number{white-space:nowrap;text-align:right}
    section>h1{font-size:11pt;line-height:1.12;margin:0 0 2mm;padding-left:2mm;border-left:1mm solid var(--accent);color:var(--ink);overflow-wrap:anywhere}
    article{break-inside:avoid;border-top:.25mm solid var(--rule);padding-top:1.1mm;margin:1.1mm 0 0}
    h3{font-size:${foldLayout.typography.bodyPt}pt;line-height:1.12;margin:0 0 .7mm;color:var(--ink)}
    .state{font-size:${foldLayout.typography.metadataPt}pt;line-height:1.15;font-weight:600;color:var(--muted);margin:0 0 .8mm;overflow-wrap:anywhere}
    pre{font:${foldLayout.typography.bodyPt}pt/1.3 'DejaVu Sans Mono',monospace;margin:0;padding:1.1mm 1.3mm;border-left:1mm solid var(--accent);background:var(--accent-soft);overflow-wrap:anywhere}
    section[data-fold-group="erasure"]>header{border-color:var(--danger-rule)}
    section[data-fold-group="erasure"] .asset-label,section[data-fold-group="erasure"]>h1{color:var(--danger)}
    section[data-fold-group="erasure"]>h1{border-color:var(--danger)}
    section[data-fold-group="erasure"] article{border-color:var(--danger-rule)}
    section[data-fold-group="erasure"] pre{border-color:var(--danger);background:var(--danger-soft)}
    section[data-fold-group="erasure"] aside{border-color:var(--danger-rule);background:var(--danger-soft);color:var(--danger);font-size:${foldLayout.typography.bodyPt}pt;line-height:1.18;padding:1.4mm;margin:0 0 1.3mm}
    section>p{margin:0 0 1.5mm;line-height:1.2}
    section>p b{color:var(--accent)}

@media print{section>header,section>h1{display:none}}
`;
