import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateHandoff,
  validateExecutionPolicy,
  validateProduct,
  verifyResolvedPolicy,
  digest,
  profileLocale,
  type HandoffRecord,
  type ExecutionPolicy,
  type ProductDescriptor,
  type ResolvedPolicy,
} from '@pxv/contracts';
import { atomicWritePrivate, CommandRunner, readBounded, type Runtime } from '@pxv/runtime';

export interface HandoffSnapshot {
  product: ProductDescriptor;
  policy: ExecutionPolicy;
  record: HandoffRecord;
  assetId: string;
  resolvedPolicy: ResolvedPolicy;
}
/** Pure renderer result. */
interface RenderedHandoff {
  markdown: string;
  html: string;
}
export interface HandoffWriteOptions {
  locale?: 'en' | 'pl';
  pdf?: boolean;
  chromiumExecutable?: string;
  runtime?: Runtime;
}
const labels = {
  en: {
    title: 'Device handoff',
    asset: 'Asset',
    policy: 'Policy',
    status: 'Status',
    accepted: 'Accepted by',
    date: 'Recorded',
    profiles: 'Profiles',
    privacy:
      'Enter account passwords, MFA and recovery material privately on your phone. Privately verify or replace supplied screen-lock defaults. Keep recovery material in a safe place outside the phone.',
    support: 'Support',
    normal:
      'Set or verify your normal screen lock privately for each profile before selecting your language and configuring an optional duress credential. Never test destructive duress activation.',
    maintenance:
      'Arrange a maintenance visit before changing device policy. Review application updates, routing and backups with your operator.',
  },
  pl: {
    title: 'Przekazanie urządzenia',
    asset: 'Identyfikator',
    policy: 'Polityka',
    status: 'Status',
    accepted: 'Odbiorca',
    date: 'Data zapisu',
    profiles: 'Profile',
    privacy:
      'Hasła do kont, MFA i dane odzyskiwania wprowadzaj prywatnie na swoim telefonie. Prywatnie sprawdź lub zmień nadane początkowe blokady ekranu. Dane odzyskiwania przechowuj bezpiecznie poza telefonem.',
    support: 'Wsparcie',
    normal:
      'Ustaw lub sprawdź prywatnie zwykłą blokadę każdego profilu przed wyborem języka i ewentualną konfiguracją kodu przymusu. Nigdy nie testuj destrukcyjnego działania kodu przymusu.',
    maintenance:
      'Przed zmianą polityki urządzenia umów wizytę serwisową. Sprawdź aktualizacje aplikacji, routing i kopie zapasowe z operatorem.',
  },
} as const;
function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function markdown(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+.!|<>-]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
}

function validateDisplay(snapshot: HandoffSnapshot, record: HandoffRecord, locale: 'en' | 'pl'): void {
  if (locale !== 'en' && locale !== 'pl') throw new Error('Unsupported handoff locale');
  if (record.outcome !== 'ready-for-handoff' && record.outcome !== 'completed-custody')
    throw new Error('Only accepted handoff outcomes can produce recipient documents');
  if (!snapshot.assetId || snapshot.assetId.length > 160 || /[\r\n]/u.test(snapshot.assetId))
    throw new Error('Invalid public asset identifier');
}
function validatedHandoff(snapshot: HandoffSnapshot, locale: 'en' | 'pl') {
  const product = validateProduct(snapshot.product);
  const policy = validateExecutionPolicy(snapshot.policy);
  const record = validateHandoff(snapshot.record);
  const resolved = verifyResolvedPolicy(snapshot.resolvedPolicy);
  if (
    record.policyDigest !== resolved.digest ||
    record.projectId !== resolved.project.id ||
    digest(policy) !== digest(resolved.policy) ||
    digest(product) !== digest(resolved.product)
  )
    throw new Error('Handoff documents require the exact accepted policy snapshot');

  validateDisplay(snapshot, record, locale);
  return { product, policy, record };
}

/** Only this explicit projection enters recipient artifacts; project state,
 * device serials, account names and arbitrary configuration are never rendered. */
/** @internal Pure rendering contract, exercised separately from filesystem/PDF effects. */
export function renderHandoff(
  snapshot: HandoffSnapshot,
  locale: 'en' | 'pl' = snapshot.record.locale,
): RenderedHandoff {
  const { product, policy, record } = validatedHandoff(snapshot, locale);
  const text = labels[locale];
  const rows: [[string, string], ...[string, string][]] = [
    [text.asset, snapshot.assetId],
    [text.policy, policy.name],
    [text.status, record.outcome],
    [text.date, record.acceptedAt ?? record.createdAt],
  ];
  if (record.acceptedBy) rows.push([text.accepted, record.acceptedBy]);
  const instructions = [text.privacy, text.normal, text.maintenance];
  const profiles = policy.profiles.map((profile) => {
    const locale = profileLocale(profile);
    return locale ? `${profile.name} (${locale})` : profile.name;
  });
  const support = `${product.support.name}: ${product.support.email} · ${product.support.url}`;
  return {
    markdown: `# ${markdown(product.name)} — ${text.title}\n\n${rows.map(([key, value]) => `**${key}:** ${markdown(value)}`).join('\n\n')}\n\n## ${text.profiles}\n\n${profiles.map((name) => `- ${markdown(name)}`).join('\n')}\n\n${instructions.join('\n\n')}\n\n## ${text.support}\n\n${markdown(support)}\n`,
    html: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${html(product.name)} — ${text.title}</title><style>@page{size:A4;margin:20mm}body{font-family:system-ui,sans-serif;color:#17222d;line-height:1.5;max-width:760px;margin:auto}h1{font-size:25px}h2{font-size:18px;margin-top:24px}dt{font-weight:600}dd{margin:0 0 12px}p,li{break-inside:avoid}footer{font-size:12px;border-top:1px solid #bbb;margin-top:30px;padding-top:12px}</style></head><body><h1>${html(product.name)} — ${text.title}</h1><dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${html(value)}</dd>`).join('')}</dl><h2>${text.profiles}</h2><ul>${profiles.map((name) => `<li>${html(name)}</li>`).join('')}</ul>${instructions.map((value) => `<p>${html(value)}</p>`).join('')}<footer><strong>${text.support}</strong><p>${html(support)}</p></footer></body></html>`,
  };
}

/** PDF generation is explicit and uses a configured local Chromium executable.
 * No browser or network dependency is installed by this operation. */
export async function writeHandoff(
  snapshot: HandoffSnapshot,
  destination: string,
  options: HandoffWriteOptions = {},
): Promise<{ markdown: string; html: string; pdf?: string }> {
  const rendered = renderHandoff(snapshot, options.locale ?? snapshot.record.locale);
  const root = resolve(destination);
  const prefix = `handoff-${snapshot.record.id}-${options.locale ?? snapshot.record.locale}`;
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(snapshot.record.id))
    throw new Error('Invalid handoff record identifier');
  const markdownPath = join(root, `${prefix}.md`);
  const htmlPath = join(root, `${prefix}.html`);
  await atomicWritePrivate(markdownPath, rendered.markdown);
  await atomicWritePrivate(htmlPath, rendered.html);
  if (!options.pdf) return { markdown: markdownPath, html: htmlPath };
  if (!options.chromiumExecutable)
    throw new Error('PDF output requires an explicit local Chromium executable');
  const temporary = await mkdtemp(join(root, '.pdf-'));
  const output = join(temporary, 'handoff.pdf');
  try {
    await (options.runtime ?? new CommandRunner()).run(
      [
        options.chromiumExecutable,
        '--headless',
        '--disable-gpu',
        '--disable-javascript',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        `--user-data-dir=${join(temporary, 'profile')}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${output}`,
        pathToFileURL(htmlPath).href,
      ],
      { timeoutMs: 30_000, env: { PATH: '/usr/bin:/bin', HOME: temporary } },
    );
    const header = await readBounded(output, 16 * 1024 * 1024);
    if (header.subarray(0, 5).toString() !== '%PDF-') throw new Error('Chromium did not produce a valid PDF');
    const pdfPath = join(root, `${prefix}.pdf`);
    await atomicWritePrivate(pdfPath, header);
    return { markdown: markdownPath, html: htmlPath, pdf: pdfPath };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export { writeCredentialInsert } from './credential-insert.js';
