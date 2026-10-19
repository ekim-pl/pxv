import { AdapterError } from './command.js';

export interface SimCardLine {
  subscriptionId: number;
  slotIndex: number;
  number?: string;
}
export interface SimCardInspection {
  lines: SimCardLine[];
  known: boolean;
}
export function normalizePhoneNumber(value: string): string | undefined {
  const text = value.trim();
  if (!/^\+?[0-9 ()\-.]+$/u.test(text)) return undefined;
  const normalized = text.replace(/[ ()\-.]/gu, '');
  return /^\+?[0-9]{3,15}$/u.test(normalized) ? normalized : undefined;
}

function parseLine(line: string): SimCardLine | undefined {
  const id = /\b(?:id|mId)=([0-9]+)\b/u.exec(line);
  const slot = /\b(?:simSlotIndex|mSimSlotIndex)=([0-9]+)\b/u.exec(line);
  if (!id || !slot || [...line.matchAll(/\b(?:id|mId)=/gu)].length !== 1) return undefined;
  const subscriptionId = Number(id[1]);
  const slotIndex = Number(slot[1]);
  if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(slotIndex)) return undefined;
  const number = /\bnumber=(.*?)(?=\s+[A-Za-z][A-Za-z0-9_]*=|\s*\]$|$)/u.exec(line)?.[1];
  const normalized = number && normalizePhoneNumber(number);
  return {
    subscriptionId,
    slotIndex,
    ...(normalized ? { number: normalized } : {}),
  };
}

/** Restrict parsing to the current list: historical subscriptions and log entries are excluded. */
export function parseCurrentSimCards(output: string): SimCardInspection {
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new AdapterError('SIM inspection exceeds limits');
  const header = /^(?:\s*)(?:Active subscriptions:|ActiveSubInfoList:)[ \t]*(.*)$/mu.exec(output);
  if (!header) return { known: false, lines: [] };
  const remainder = header[1] + '\n' + output.slice(header.index + header[0].length);
  const section = remainder.split(
    /\n[ \t]*(?:All subscriptions:|AllSubInfoList:|AvailableSubInfoList:|Embedded subscriptions:|Cached|Local logs:|SubscriptionDatabaseManager:)/u,
  )[0]!;
  const rows = section
    .split('\n')
    .filter((line) => /\b(?:SubscriptionInfoInternal:|simSlotIndex=|mSimSlotIndex=)/u.test(line));
  const lines = rows.map(parseLine);
  if (lines.some((line) => !line)) return { known: false, lines: [] };
  const parsed = lines.filter((line): line is SimCardLine => Boolean(line));
  if (new Set(parsed.map((line) => line.subscriptionId)).size !== parsed.length)
    throw new AdapterError('Current SIM subscriptions are ambiguous');
  if (!parsed.length && !/^(?:\s|\[\]|null)*$/u.test(section)) return { known: false, lines: [] };
  return {
    known: true,
    lines: parsed.sort((a, b) => a.slotIndex - b.slotIndex || a.subscriptionId - b.subscriptionId),
  };
}
