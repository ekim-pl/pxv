import {
  validatePhoneRegistryRecord,
  type PhoneRegistryRecord,
  type PhoneRegistryValue,
} from '@pxv/contracts';
import { writeRegistryPrivateFile } from '@pxv/runtime';
import { insertLabels } from './credential-insert-labels.js';
import { cardPagination } from './card-pagination.js';
import {
  escapePrint as escape,
  normalizePrintPdf,
  printDocument,
  printLocale,
  renderPrivatePdf,
  withPrivatePrint,
  type PrivatePrintOptions,
} from './private-print.js';

interface CardOptions {
  locale?: 'en' | 'pl';
}

const styles = `
@page{size:68mm 100mm;margin:0}
*{box-sizing:border-box}
body{margin:0;color:#000;font:7pt/1.15 'DejaVu Sans',sans-serif}
#source{display:none}
.card{width:68mm;height:100mm;padding:3mm;display:flex;flex-direction:column;break-after:page}
.card:last-child{break-after:auto}
header,footer{flex:none;overflow-wrap:anywhere}
header{border-bottom:.3mm solid #000;padding-bottom:1mm;margin-bottom:1mm}
h1{font-size:9pt;margin:0 0 1mm}
header p{margin:0 0 .8mm}
.warning{font-weight:bold}
main{flex:1;min-height:0}
footer{height:4mm;text-align:right;font-size:7pt;padding-top:1mm}
.entry{margin:0 0 1.4mm;overflow-wrap:anywhere}
.same-identity h2,.same-state .state{display:none}
h2,h3{font-size:7pt;line-height:1.15;margin:0 0 .4mm}
.state{font-size:6pt;line-height:1.15;margin:0 0 .5mm;white-space:pre-wrap}
pre{font:9pt/1.15 'DejaVu Sans Mono',monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;margin:0}
`;

/** Pure HTML renderer; callers supply effective registry binding states. */
export function renderDeviceBoxCard(record: PhoneRegistryRecord, options: CardOptions = {}): string {
  validatePhoneRegistryRecord(record);
  const locale = printLocale(options.locale);
  const t = insertLabels[locale];
  const entry = (identity: string, label: string, field: PhoneRegistryValue | undefined): string => {
    if (!field)
      return `<article class="entry"><h2>${escape(identity)}</h2><h3>${escape(label)}</h3>${escape(t.empty)}</article>`;
    const metadata = [
      t.metadataDefault,
      t[field.state],
      `${t.updated}: ${field.updatedAt}`,
      ...(field.confirmedAt ? [`${t.confirmed}: ${field.confirmedAt}`] : []),
    ].join('\n');
    return `<article class="entry"><h2>${escape(identity)}</h2><h3>${escape(label)}</h3><p class="state">${escape(metadata)}</p><pre>${escape(field.value)}</pre></article>`;
  };
  const fields = [
    entry(t.device, t.duressPin, record.fields.duressPin),
    entry(t.device, t.duressPassword, record.fields.duressPassword),
    entry(t.device, t.phoneNumber, record.fields.phoneNumber),
    ...record.profiles.flatMap((profile) => {
      const identity = `${t.profile}: ${profile.user.name} (${profile.profileId}; ${profile.user.userId}/${profile.user.serialNo})`;
      return [
        entry(identity, t.oblivionNotificationWipeKey, profile.fields.oblivionNotificationWipeKey),
        entry(identity, t.phoneNumber, profile.fields.phoneNumber),
        entry(identity, t.sessionMessengerId, profile.fields.sessionMessengerId),
      ];
    }),
    ...(record.profiles.length
      ? []
      : [`<article class="entry"><h2>${escape(t.profile)}</h2>${escape(t.empty)}</article>`]),
  ].join('');
  const header = `<header><h1>${escape(t.erasure)}</h1><p>${escape(t.serial)}: ${escape(record.canonicalSerial)}</p><p class="warning">${escape(t.destructive)}</p><p>${escape(t.missingNote)}</p></header>`;
  return printDocument(
    locale,
    styles,
    `<template id="card"><section class="card">${header}<main></main><footer></footer></section></template><div id="source">${fields}</div>`,
    cardPagination,
  );
}

/** Retain only a private native-size PDF; renderer diagnostics cannot expose values. */
export async function writeDeviceBoxCard(
  record: PhoneRegistryRecord,
  destination: string,
  options: PrivatePrintOptions,
): Promise<void> {
  let bytes: Buffer | undefined;
  try {
    await withPrivatePrint(async (directory) => {
      bytes = await renderPrivatePdf(directory, renderDeviceBoxCard(record, options), options);
      const normalized = await normalizePrintPdf(bytes, [68, 100], false);
      try {
        await writeRegistryPrivateFile(destination, normalized);
      } finally {
        normalized.fill(0);
      }
    });
  } catch {
    throw new Error(
      'Private device box card export failed; check the private destination, content capacity and local Chromium',
    );
  } finally {
    bytes?.fill(0);
  }
}
