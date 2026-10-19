import type { SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import type { CollectionStatus } from './profile-collection.js';
import { normalizePhoneNumber, parseCurrentSimCards, type SimCardInspection } from './simcards-inspection.js';
export { normalizePhoneNumber } from './simcards-inspection.js';

export interface CollectedSimCards extends SimCardInspection {
  numbers: string[];
  outcomes: { scope: 'device'; slotIndex?: number; status: CollectionStatus }[];
  manual: boolean;
}
export interface SimCardCollectionOptions extends OperationOptions {
  manual(slotIndex?: number): Promise<string | undefined>;
}

export async function inspectSimCards(
  android: AndroidAdapter,
  target: SelectedTarget,
  signal?: AbortSignal,
): Promise<SimCardInspection> {
  await android.guardTarget(target, signal);
  let output: string;
  try {
    output = await android.shell(target, ['dumpsys', 'isub'], signal ? { signal } : {});
  } catch {
    signal?.throwIfAborted();
    return { known: false, lines: [] };
  }
  try {
    return parseCurrentSimCards(output);
  } catch {
    throw new AdapterError(
      'SIM collection failed during subscription inspection; no values were saved',
      'SIMCARDS_COLLECTION_FAILED',
    );
  }
}

/** Recheck the transient active list, including any visible numbers, before committing. */
export function sameSimCards(before: SimCardInspection, after: SimCardInspection): boolean {
  return before.known === after.known && JSON.stringify(before.lines) === JSON.stringify(after.lines);
}

export async function collectSimCards(
  android: AndroidAdapter,
  target: SelectedTarget,
  options: SimCardCollectionOptions,
): Promise<CollectedSimCards> {
  const inspection = await inspectSimCards(android, target, options.signal);
  const result: CollectedSimCards = { ...inspection, numbers: [], outcomes: [], manual: false };
  if (inspection.known && !inspection.lines.length) {
    result.outcomes.push({ scope: 'device', status: 'not-present' });
    return result;
  }
  if (!inspection.known) return collectUnknownCards(result, options);
  for (const line of inspection.lines) {
    options.signal?.throwIfAborted();
    let number = line.number;
    if (!number) {
      number = await options.manual(line.slotIndex);
      result.manual = true;
    }
    options.signal?.throwIfAborted();
    if (number) result.numbers.push(validatedNumber(number));
    result.outcomes.push({
      scope: 'device',
      slotIndex: line.slotIndex,
      status: number ? 'collected' : 'skipped',
    });
  }
  result.numbers = [...new Set(result.numbers)];
  return result;
}

async function collectUnknownCards(
  result: CollectedSimCards,
  options: SimCardCollectionOptions,
): Promise<CollectedSimCards> {
  const entered = await options.manual();
  options.signal?.throwIfAborted();
  result.manual = true;
  const numbers = entered?.split('\n').map((value) => normalizePhoneNumber(value));
  if (numbers?.some((number) => !number)) throw new AdapterError('Invalid private SIM number list');
  result.numbers = [...new Set(numbers?.filter((number): number is string => Boolean(number)) ?? [])];
  result.outcomes.push({ scope: 'device', status: result.numbers.length ? 'collected' : 'unavailable' });
  return result;
}

function validatedNumber(value: string): string {
  const number = normalizePhoneNumber(value);
  if (!number) throw new AdapterError('Invalid private SIM number');
  return number;
}
