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
import { imposeFoldPacket } from './fold-packet.js';
import { foldHeaderStyle } from './fold-layout.js';
import { credentialInsertStyles } from './credential-insert-styles.js';
import { insertLabels } from './credential-insert-labels.js';

interface CredentialInsertOptions {
  locale?: 'en' | 'pl';
  exportedAt: string;
  support: string;
  projectName?: string;
  model?: string;
}
interface CredentialInsertWriteOptions extends CredentialInsertOptions {
  chromiumExecutable: string;
  runtime?: Runtime;
}
type InsertGroup = 'ordinary' | 'erasure';
interface InsertField {
  label: string;
  field?: PhoneRegistryValue | undefined;
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

type InsertLabels = (typeof insertLabels)[keyof typeof insertLabels];
const timestamp = (value: string): string => value.replace('T', ' ').replace(/\.000(?=Z|[+-])/u, '');

function metadata(field: PhoneRegistryValue, t: InsertLabels): string {
  return [
    t[field.state],
    t.updated + ': ' + timestamp(field.updatedAt),
    ...(field.confirmedAt ? [t.confirmed + ': ' + timestamp(field.confirmedAt)] : []),
  ].join('\n');
}
function status(text: string): string {
  return '<p class="state">' + escape(text).replaceAll('\n', '<br>') + '</p>';
}

function fieldRow({ label, field }: InsertField, common: string | undefined, t: InsertLabels): string {
  const value = field
    ? (metadata(field, t) !== common ? status(metadata(field, t)) : '') +
      '<pre class="value">' +
      escape(field.value) +
      '</pre>'
    : '<p class="manual">' + escape(t.manual) + '</p><div class="write-line"></div>';
  return '<tr><td><article class="entry"><h3>' + escape(label) + '</h3>' + value + '</article></td></tr>';
}

class InsertRenderer {
  private readonly t: InsertLabels;
  private readonly pageStyles: string[] = [];
  constructor(
    private readonly record: PhoneRegistryRecord,
    private readonly options: CredentialInsertOptions,
    private readonly locale: 'en' | 'pl',
  ) {
    this.t = insertLabels[locale];
  }

  render(group?: InsertGroup): string {
    const body = (group !== 'erasure' ? this.ordinary() : '') + (group !== 'ordinary' ? this.erasure() : '');
    return (
      '<!doctype html><html lang="' +
      this.locale +
      '"><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
      '<title>' +
      escape(this.t.title) +
      '</title><style>' +
      credentialInsertStyles +
      this.pageStyles.join('') +
      '</style></head><body>' +
      body +
      '</body></html>'
    );
  }

  private heading(title: string, identity: string, common: string | undefined, mixed: boolean): string {
    return (
      '<h2 class="section-title">' +
      escape(title) +
      '</h2>' +
      (identity ? '<p class="identity">' + escape(identity) + '</p>' : '') +
      (common ? status((mixed ? this.t.metadataDefault + '\n' : '') + common) : '')
    );
  }

  private section(title: string, identity: string, fields: InsertField[], intro = ''): string {
    const pageName = 'profile' + this.pageStyles.length;
    // Margin boxes retain identity even when a single long value crosses many panels.
    if (identity) this.pageStyles.push(foldHeaderStyle(pageName, { lines: [title, identity] }));
    const recorded = fields.filter((entry): entry is InsertField & { field: PhoneRegistryValue } =>
      Boolean(entry.field),
    );
    const counts = new Map<string, number>();
    for (const { field } of recorded) {
      const key = metadata(field, this.t);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const rows = fields.map((entry) => fieldRow(entry, common, this.t)).join('');
    const attributes = identity ? ' profile-section" style="page:' + pageName : '';
    return (
      '<table class="credential-section' +
      attributes +
      '"><thead><tr><th>' +
      intro +
      this.heading(title, identity, common, counts.size > 1) +
      '</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>'
    );
  }

  private profile(profile: PhoneRegistryProfile, destructive: boolean, intro = ''): string {
    const t = this.t;
    return this.section(
      t.profile + ': ' + profile.user.name,
      profile.profileId + ' · ' + (profile.user.userId === 0 ? t.owner : t.secondary),
      destructive
        ? [{ label: t.oblivionNotificationWipeKey, field: profile.fields.oblivionNotificationWipeKey }]
        : [
            { label: t.pin, field: profile.fields.pin },
            { label: t.password, field: profile.fields.password },
            { label: t.phoneNumber, field: profile.fields.phoneNumber },
            { label: t.sessionMessengerId, field: profile.fields.sessionMessengerId },
            { label: t.protonVpnUsername, field: profile.fields.protonVpnUsername },
            { label: t.protonVpnPassword, field: profile.fields.protonVpnPassword },
          ],
      intro,
    );
  }

  private ordinary(): string {
    const { t, record, options } = this;
    const summary = [
      ...(options.projectName ? [[t.project, options.projectName]] : []),
      [t.model, options.model ? options.model + ' (' + record.codename + ')' : record.codename],
      [t.revision, String(record.revision)],
      [t.exported, timestamp(options.exportedAt)],
      [t.support, options.support],
    ]
      .map(([label, value]) => '<div><strong>' + escape(label!) + ':</strong> ' + escape(value!) + '</div>')
      .join('');
    return (
      '<section data-fold-group="ordinary"><h1>' +
      escape(t.title) +
      '</h1>' +
      this.deviceSerial() +
      '<div class="summary">' +
      summary +
      '</div><p class="note">' +
      escape(t.instructions) +
      '</p>' +
      this.section(t.device, '', [{ label: t.simPhoneNumbers, field: record.fields.phoneNumber }]) +
      (record.profiles.length
        ? record.profiles.map((profile) => this.profile(profile, false)).join('')
        : '<p class="empty">' + escape(t.empty) + '</p>') +
      '</section>'
    );
  }

  private erasure(): string {
    const { t, record } = this;
    const profiles = record.profiles;
    const intro =
      '<h2 class="group-title">Oblivion</h2><p class="note">' + escape(t.oblivionInstructions) + '</p>';
    return (
      '<section data-fold-group="erasure"><h1 class="credential-warning">' +
      escape(t.erasure) +
      '</h1>' +
      this.deviceSerial() +
      '<p class="note warning">' +
      escape(t.destructive) +
      '</p><p class="note">' +
      escape(t.missingNote) +
      '</p>' +
      this.section(t.duress, '', [
        { label: t.duressPin, field: record.fields.duressPin },
        { label: t.duressPassword, field: record.fields.duressPassword },
      ]) +
      (profiles.length
        ? profiles.map((profile, index) => this.profile(profile, true, index === 0 ? intro : '')).join('')
        : intro + '<p class="empty">' + escape(t.empty) + '</p>') +
      '</section>'
    );
  }

  private deviceSerial(): string {
    return (
      '<p class="identity"><strong>' +
      escape(this.t.serial) +
      ':</strong><br>' +
      escape(this.record.canonicalSerial) +
      '</p>'
    );
  }
}

/** @internal Pure private rendering contract; callers supply effective binding states. */
export function renderCredentialInsert(
  record: PhoneRegistryRecord,
  options: CredentialInsertOptions,
  group?: InsertGroup,
): string {
  validatePhoneRegistryRecord(record);
  const locale = options.locale ?? 'en';
  if (locale !== 'en' && locale !== 'pl') throw new Error('Unsupported insert locale');
  return new InsertRenderer(record, options, locale).render(group);
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
  const groups: { name: string; pdf: Uint8Array; sheetHeader: string }[] = [];
  try {
    if (!options.chromiumExecutable) throw new Error();
    temporary = await mkdtemp(join(tmpdir(), 'pxv-private-insert-'));
    for (const name of ['ordinary', 'erasure'] as const) {
      const html = renderCredentialInsert(record, options, name);
      bytes = await renderPrivatePanels(temporary, name, html, options);
      groups.push({
        name,
        pdf: bytes,
        sheetHeader: insertLabels[options.locale ?? 'en'].asset + ': ' + record.assetId,
      });
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
