import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validatePhoneRegistryRecord,
  type PhoneRegistryProfile,
  type PhoneRegistryRecord,
  type PhoneRegistryValue,
} from '@pxv/contracts';
import { CommandRunner, readBounded, writeRegistryPrivateFile, type Runtime } from '@pxv/runtime';
import { foldPrintingInstructions, imposeFoldPacket } from './fold-packet.js';
import { foldHeaderStyle } from './fold-layout.js';
import { credentialInsertStyles } from './credential-insert-styles.js';
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
interface InsertField {
  label: string;
  value?: string;
  field?: PhoneRegistryValue | undefined;
  blank?: boolean;
}
interface InsertPage {
  sectionNumber: number;
  sectionTitle: string;
  context: string[];
  body: string;
  group: 'ordinary' | 'erasure';
  cover?: boolean;
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
function lines(value: string, width = 26): string[] {
  return value.split(/\r\n|\r|\n/u).flatMap((line) => {
    const chars = Array.from(line.replaceAll('\t', '    '));
    const result: string[] = [];
    for (let i = 0; i < chars.length; i += width) result.push(chars.slice(i, i + width).join(''));
    return result.length ? result : [''];
  });
}

function estimateLines(value: string, width = 32): number {
  return Math.max(1, Math.ceil(Array.from(value).length / width));
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
  const pages: InsertPage[] = [];
  const deviceContext = [t.deviceContext];

  const addPage = (
    sectionNumber: number,
    sectionTitle: string,
    context: string[],
    body: string,
    group: 'ordinary' | 'erasure',
    cover = false,
  ) => {
    pages.push({ sectionNumber, sectionTitle, context, body, group, ...(cover ? { cover: true } : {}) });
  };

  const addFieldPages = (
    sectionNumber: number,
    sectionTitle: string,
    context: string[],
    fields: InsertField[],
    group: 'ordinary' | 'erasure',
  ) => {
    let body = '';
    let usedMm = 0;
    const flush = () => {
      if (body) addPage(sectionNumber, sectionTitle, context, body, group);
      body = '';
      usedMm = 0;
    };

    for (const entry of fields) {
      if (entry.blank) {
        const cost = 10 + estimateLines(entry.label) * 4.4;
        if (body && usedMm + cost > 42) flush();
        body += '<div class="write-line">' + escape(entry.label) + '</div>';
        usedMm += cost;
        continue;
      }

      const field = entry.field;
      const valueLines = lines(field?.value ?? entry.value ?? t.missing);
      for (let start = 0; start < valueLines.length; start += 4) {
        const chunk = valueLines.slice(start, start + 4);
        const label = entry.label + (start ? ' (' + t.continued + ')' : '');
        const status = field
          ? [
              t[field.state],
              t.updated + ': ' + field.updatedAt,
              ...(field.confirmedAt ? [t.confirmed + ': ' + field.confirmedAt] : []),
            ]
          : [];
        const labelCost = estimateLines(label) * 4.3;
        const statusCost = status.reduce((total, line) => total + estimateLines(line) * 3.3, 0);
        const cost = 2 + labelCost + statusCost + chunk.length * 4.5;
        if (body && usedMm + cost > 42) flush();
        body +=
          '<article class="entry"><h3>' +
          escape(label) +
          '</h3>' +
          (status.length ? '<p class="state">' + status.map(escape).join('<br>') + '</p>' : '') +
          '<pre class="value">' +
          chunk.map(escape).join('\n') +
          '</pre></article>';
        usedMm += cost;
      }
    }
    flush();
  };

  const addIntro = (
    sectionNumber: number,
    sectionTitle: string,
    context: string[],
    body: string,
    group: 'ordinary' | 'erasure',
  ) => addPage(sectionNumber, sectionTitle, context, body, group);

  addPage(
    1,
    t.section1,
    deviceContext,
    '<p class="private-stamp">' +
      escape(t.privateWhenComplete) +
      '</p><h1>' +
      escape(t.title) +
      '</h1><p>' +
      escape(foldPrintingInstructions(locale)) +
      '</p>',
    'ordinary',
    true,
  );

  addIntro(
    1,
    t.section1,
    deviceContext,
    '<p><strong>' + escape(t.privateWhenComplete) + '.</strong> ' + escape(t.instructions) + '</p>',
    'ordinary',
  );

  const deviceFields: InsertField[] = [
    { label: t.asset, value: record.assetId },
    { label: t.model, value: options.model ? options.model + ' (' + record.codename + ')' : record.codename },
    { label: t.revision, value: String(record.revision) },
    { label: t.exported, value: options.exportedAt },
    { label: t.support, value: options.support },
    { label: t.recipient, blank: true },
    { label: t.handoffDate, blank: true },
    { label: t.recovery, blank: true },
    { label: t.supportRoute, blank: true },
    { label: t.updateMethod, blank: true },
    { label: t.enclosedSheets, blank: true },
    { label: t.retentionReview, blank: true },
    { label: t.devicePhone, field: record.fields.phoneNumber },
  ];
  addFieldPages(1, t.section1, deviceContext, deviceFields, 'ordinary');

  function profileContext(profile: PhoneRegistryProfile): string[] {
    return [
      t.profile + ': ' + profile.user.name,
      t.id + ': ' + profile.profileId,
      profile.user.userId === 0 ? t.owner : t.secondary,
    ];
  }

  for (const profile of record.profiles) {
    const context = profileContext(profile);
    const credentialType = [
      ...(profile.fields.pin ? [t.pinType] : []),
      ...(profile.fields.password ? [t.passwordType] : []),
    ];
    const normalFields: InsertField[] = [
      { label: t.lockType, value: credentialType.length ? credentialType.join(t.typeSeparator) : t.missing },
    ];
    if (profile.fields.pin && profile.fields.password) {
      normalFields.push(
        { label: t.pin, field: profile.fields.pin },
        { label: t.password, field: profile.fields.password },
      );
    } else {
      normalFields.push({
        label: t.unlockValue,
        field: profile.fields.pin ?? profile.fields.password,
      });
    }
    normalFields.push({ label: t.phoneNumber, field: profile.fields.phoneNumber });

    addIntro(
      2,
      t.section2,
      context,
      '<p>' +
        escape(t.profileInstructions) +
        '</p>' +
        (profile.user.userId === 0 ? '<p>' + escape(t.ownerRestart) + '</p>' : '') +
        '<p><strong>' +
        escape(t.noDestructiveTitle) +
        '</strong> ' +
        escape(t.noDestructive) +
        '</p>',
      'ordinary',
    );
    addFieldPages(2, t.section2, context, normalFields, 'ordinary');

    addIntro(3, t.section3, context, '<p>' + escape(t.accountInstructions) + '</p>', 'ordinary');
    addFieldPages(
      3,
      t.section3,
      context,
      [
        { label: t.sessionMessengerId, field: profile.fields.sessionMessengerId },
        { label: t.protonVpnUsername, field: profile.fields.protonVpnUsername },
        { label: t.protonVpnPassword, field: profile.fields.protonVpnPassword },
        { label: t.accountStoreReference, blank: true },
        { label: t.mfaRecovery, blank: true },
        { label: t.recoveryStorage, blank: true },
        { label: t.backupMethod, blank: true },
        { label: t.backupCoverage, blank: true },
        { label: t.backupLimitations, blank: true },
        { label: t.backupFrequency, blank: true },
        { label: t.restoreTest, blank: true },
        { label: t.recoveryContact, blank: true },
      ],
      'ordinary',
    );
  }

  addIntro(
    4,
    t.section4,
    deviceContext,
    '<div class="credential-warning"><strong>' +
      escape(t.destructiveTitle) +
      '</strong><br>' +
      escape(t.destructive) +
      '</div>',
    'erasure',
  );
  addIntro(4, t.section4, deviceContext, '<p>' + escape(t.erasureInstructions) + '</p>', 'erasure');
  addIntro(4, t.section4, deviceContext, '<p>' + escape(t.oblivionInstructions) + '</p>', 'erasure');
  addFieldPages(
    4,
    t.section4,
    deviceContext,
    [
      { label: t.duressPin, field: record.fields.duressPin },
      { label: t.duressPassword, field: record.fields.duressPassword },
      { label: t.duressStatus, blank: true },
      { label: t.configurationDate, blank: true },
      { label: t.erasureProcedure, blank: true },
    ],
    'erasure',
  );
  for (const profile of record.profiles)
    addFieldPages(
      4,
      t.section4,
      profileContext(profile),
      [
        { label: t.oblivionStatus, blank: true },
        { label: t.oblivionVersion, blank: true },
        { label: t.oblivionNotificationWipeKey, field: profile.fields.oblivionNotificationWipeKey },
        { label: t.oblivionKeyReference, blank: true },
        { label: t.erasureProcedure, blank: true },
      ],
      'erasure',
    );

  return privateHtml(pages, record.assetId, locale);
}

function privateHtml(pages: InsertPage[], assetId: string, locale: 'en' | 'pl'): string {
  const t = insertLabels[locale];
  const pageStyles = pages
    .map((page, i) => {
      const headerLines = page.cover
        ? []
        : [
            page.sectionNumber + ' ' + page.sectionTitle,
            t.sectionContinued,
            ...page.context,
            t.asset + ': ' + assetId,
          ];
      return foldHeaderStyle('private' + i, { lines: headerLines, assetField: t.assetField });
    })
    .join('');
  const sections = pages
    .map(
      (page, i) =>
        '<section class="private-panel' +
        (page.cover ? ' cover' : '') +
        '" style="page:private' +
        i +
        '" data-fold-group="' +
        (page.group === 'erasure' ? 'erasure' : 'ordinary') +
        '">' +
        page.body +
        '</section>',
    )
    .join('');
  return (
    '<!doctype html><html lang="' +
    locale +
    '"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' +
    escape(t.title) +
    '</title><style>' +
    credentialInsertStyles +
    pageStyles +
    '</style></head><body>' +
    sections +
    '</body></html>'
  );
}

/** Only the PDF survives. Browser errors are deliberately replaced to avoid secret diagnostics. */
export async function writeCredentialInsert(
  record: PhoneRegistryRecord,
  destination: string,
  options: CredentialInsertWriteOptions,
): Promise<void> {
  let temporary: string | undefined;
  let bytes: Buffer | undefined;
  let imposedBytes: Uint8Array | undefined;
  const groups: { name: string; pdf: Uint8Array }[] = [];
  try {
    if (!options.chromiumExecutable) throw new Error();
    const html = renderCredentialInsert(record, options);
    temporary = await mkdtemp(join(tmpdir(), 'pxv-private-insert-'));
    for (const name of ['ordinary', 'erasure']) {
      bytes = await renderPrivatePanels(temporary, name, html, options);
      groups.push({ name, pdf: bytes });
    }
    const imposed = await imposeFoldPacket(groups);
    imposedBytes = imposed.pdf;
    bytes = Buffer.from(imposedBytes);
    await writeRegistryPrivateFile(destination, bytes);
  } catch {
    throw new Error(
      'Private credential insert export failed; check the private destination and local Chromium',
    );
  } finally {
    bytes?.fill(0);
    imposedBytes?.fill(0);
    for (const group of groups) group.pdf.fill(0);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function renderPrivatePanels(
  temporary: string,
  name: string,
  html: string,
  options: CredentialInsertWriteOptions,
): Promise<Buffer> {
  const source = join(temporary, 'insert-' + name + '.html');
  const output = join(temporary, 'insert-' + name + '.pdf');
  const hidden = name === 'ordinary' ? 'erasure' : 'ordinary';
  await writeRegistryPrivateFile(
    source,
    Buffer.from(html.replace('</style>', '[data-fold-group="' + hidden + '"]{display:none}</style>')),
  );
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
      '--user-data-dir=' + join(temporary, 'profile'),
      '--no-pdf-header-footer',
      '--print-to-pdf=' + output,
      pathToFileURL(source).href,
    ],
    { timeoutMs: 30_000, env: { PATH: '/usr/bin:/bin', HOME: temporary } },
  );
  if (result.code !== 0) throw new Error();
  const bytes = await readBounded(output, 32 * 1024 * 1024);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error();
  return bytes;
}
