import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validatePhoneRegistryRecord,
  type PhoneRegistryRecord,
  type PhoneRegistryValue,
} from '@pxv/contracts';
import { CommandRunner, readBounded, writeRegistryPrivateFile, type Runtime } from '@pxv/runtime';
import { insertLabels } from './credential-insert-labels.js';

interface CredentialInsertOptions {
  locale?: 'en' | 'pl';
  exportedAt: string;
  support: string;
  model?: string;
}
interface CredentialInsertWriteOptions extends CredentialInsertOptions {
  chromiumExecutable: string;
  runtime?: Runtime;
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
/** Fixed-width visual lines preserve whitespace and bound every page's content. */
function lines(value: string): string[] {
  return value.split(/\r\n|\r|\n/u).flatMap((line) => {
    const chars = Array.from(line.replaceAll('\t', '    '));
    const result: string[] = [];
    for (let i = 0; i < chars.length; i += 32) result.push(chars.slice(i, i + 32).join(''));
    return result.length ? result : [''];
  });
}
/** @internal Pure private rendering contract; callers supply effective binding states. */
export function renderCredentialInsert(
  record: PhoneRegistryRecord,
  options: CredentialInsertOptions,
): string {
  validatePhoneRegistryRecord(record);
  const locale = options.locale ?? 'en';
  if (locale !== 'en' && locale !== 'pl') throw new Error('Unsupported insert locale');
  const t = insertLabels[locale];
  const pages: { title: string; body: string; destructive: boolean }[] = [];
  const row = (label: string, value: string) => `<p><b>${escape(label)}</b><br>${escape(value)}</p>`;
  pages.push({
    title: t.title,
    destructive: false,
    body: `<p>${t.instructions}</p>${row(t.model, options.model ? `${options.model} (${record.codename})` : record.codename)}${row(t.revision, String(record.revision))}${row(t.exported, options.exportedAt)}${row(t.support, options.support)}${row(t.recipient, '________________________')}${row(t.recovery, '________________________')}`,
  });
  function sheets(title: string, fields: [string, PhoneRegistryValue | undefined][], destructive: boolean) {
    let body = '';
    let used = 0;
    const flush = () => {
      if (body) pages.push({ title, body, destructive });
      body = '';
      used = 0;
    };
    for (const [label, field] of fields) {
      const valueLines = lines(field?.value ?? t.missing);
      for (let start = 0; start < valueLines.length; start += 12) {
        const chunk = valueLines.slice(start, start + 12);
        const cost = chunk.length + 7;
        if (used + cost > (destructive ? 21 : 27)) flush();
        body += `<article><h3>${escape(label)}${start ? ` (${t.continued})` : ''}</h3>`;
        if (field)
          body += `<p class="state">${t[field.state]}<br>${t.updated}: ${escape(field.updatedAt)}${field.confirmedAt ? `<br>${t.confirmed}: ${escape(field.confirmedAt)}` : ''}</p>`;
        body += `<pre>${chunk.map(escape).join('\n')}</pre></article>`;
        used += cost;
      }
    }
    flush();
  }
  sheets(t.ordinary, [[t.phoneNumber, record.fields.phoneNumber]], false);
  for (const profile of record.profiles) {
    const title = `${t.ordinary} / ${profile.user.name} (${profile.profileId}, ${profile.user.userId === 0 ? t.owner : t.secondary})`;
    sheets(
      title,
      (
        [
          'pin',
          'password',
          'phoneNumber',
          'sessionMessengerId',
          'protonVpnUsername',
          'protonVpnPassword',
        ] as const
      ).map((key) => [t[key], profile.fields[key]]),
      false,
    );
  }
  pages.push({ title: t.erasure, body: `<p>${t.destructive}</p>`, destructive: false });
  sheets(
    t.erasure,
    [
      [t.duressPin, record.fields.duressPin],
      [t.duressPassword, record.fields.duressPassword],
    ],
    true,
  );
  for (const profile of record.profiles)
    sheets(
      `${t.erasure} / ${profile.user.name} (${profile.profileId})`,
      [[t.oblivionNotificationWipeKey, profile.fields.oblivionNotificationWipeKey]],
      true,
    );
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${t.title}</title><style>
    @page{size:A5;margin:12mm}*{box-sizing:border-box}body{font:10pt/1.35 sans-serif;color:#111;margin:0}section{break-before:page}section:first-child{break-before:auto}header{font-size:9pt;border-bottom:1px solid #555;padding-bottom:3mm;overflow-wrap:anywhere}h1{font-size:11pt;line-height:1.2;margin:4mm 0;overflow-wrap:anywhere}h3{font-size:10pt;margin:3mm 0 1mm}p{margin:2mm 0;overflow-wrap:anywhere}article{break-inside:avoid}.state{font-size:8pt;font-weight:bold}pre{font:10pt/1.35 monospace;white-space:pre;margin:2mm 0}aside{font-size:8pt;border:2px solid #111;padding:2mm;margin:2mm 0}
    </style></head><body>${pages.map((page, i) => `<section><header>${t.asset}: ${escape(record.assetId)} | ${t.page} ${i + 1}/${pages.length}</header><h1>${escape(page.title)}</h1>${page.destructive ? `<aside>${locale === 'pl' ? 'Odłącz i zapieczętuj oddzielnie. Nigdy nie testuj tych wartości.' : 'Detach and seal separately. Never test these values.'}</aside>` : ''}${page.body}</section>`).join('')}</body></html>`;
}

/** Only the PDF survives. Browser errors are deliberately replaced to avoid secret diagnostics. */
export async function writeCredentialInsert(
  record: PhoneRegistryRecord,
  destination: string,
  options: CredentialInsertWriteOptions,
): Promise<void> {
  let temporary: string | undefined;
  let bytes: Buffer | undefined;
  try {
    if (!options.chromiumExecutable) throw new Error();
    const html = renderCredentialInsert(record, options);
    temporary = await mkdtemp(join(tmpdir(), 'pxv-private-insert-'));
    const source = join(temporary, 'insert.html');
    const output = join(temporary, 'insert.pdf');
    await writeRegistryPrivateFile(source, Buffer.from(html));
    const result = await (options.runtime ?? new CommandRunner()).run(
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
        pathToFileURL(source).href,
      ],
      { timeoutMs: 30_000, env: { PATH: '/usr/bin:/bin', HOME: temporary } },
    );
    if (result.code !== 0) throw new Error();
    bytes = await readBounded(output, 32 * 1024 * 1024);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error();
    await writeRegistryPrivateFile(destination, bytes);
  } catch {
    throw new Error(
      'Private credential insert export failed; check the private destination and local Chromium',
    );
  } finally {
    bytes?.fill(0);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
