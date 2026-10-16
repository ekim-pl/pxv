export interface ExpectedRecord {
  collection: string;
  key: string;
  value: unknown;
}
export type RecordChange =
  | { kind: 'set'; collection: string; key: string; value: unknown }
  | { kind: 'delete'; collection: string; key: string };
export interface StoreTransition {
  expected: ExpectedRecord[];
  changes: RecordChange[];
  events: { runId: string; value: unknown }[];
}
/** Application services borrow storage; composition owns its lifetime. */
export interface Store {
  get<T>(collection: string, key: string): Promise<T | undefined>;
  set(collection: string, key: string, value: unknown): Promise<void>;
  entries<T = unknown>(collection: string, limit?: number): Promise<{ key: string; value: T }[]>;
  delete(collection: string, key: string): Promise<boolean>;
  appendEvent(runId: string, event: unknown): Promise<number>;
  events<T = unknown>(
    runId: string,
    after?: number,
    limit?: number,
  ): Promise<{ sequence: number; event: T }[]>;
  submitAndSet<T>(
    key: string,
    value: T,
    collection: string,
    recordKey: string,
  ): Promise<{ created: boolean; value: T }>;
  compareAndSet(collection: string, key: string, expected: unknown, next: unknown): Promise<boolean>;
  transition(input: StoreTransition): Promise<boolean>;
  ingestReceipt(
    receiptId: string,
    runId: string,
    event: unknown,
  ): Promise<{ created: boolean; sequence: number }>;
  ingestedReceipt<T = unknown>(receiptId: string): Promise<T | undefined>;
  close(): Promise<void>;
}
export interface EncodedTransition {
  expected: { collection: string; key: string; value: string | null }[];
  changes: (
    | { kind: 'set'; collection: string; key: string; value: string }
    | { kind: 'delete'; collection: string; key: string }
  )[];
  events: { runId: string; value: string }[];
}
export function encodeRecord(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Stored records must be JSON values');
  return encoded;
}
function validAddress(value: { collection: string; key: string }): boolean {
  return [value.collection, value.key].every(
    (part) => typeof part === 'string' && part.length > 0 && part.length <= 1024 && !part.includes('\0'),
  );
}
function validateTransition(input: StoreTransition): void {
  if (
    [input.expected, input.changes, input.events].some((items) => !Array.isArray(items) || items.length > 256)
  )
    throw new Error('Invalid transition size');
  for (const group of [input.expected, input.changes]) {
    if (group.some((value) => !validAddress(value))) throw new Error('Invalid transition record address');
    if (new Set(group.map((value) => JSON.stringify([value.collection, value.key]))).size !== group.length)
      throw new Error('Duplicate transition record address');
  }
  if (
    input.events.some((event) => typeof event.runId !== 'string' || !event.runId || event.runId.length > 1024)
  )
    throw new Error('Invalid transition event address');
}
export function encodeTransition(input: StoreTransition): EncodedTransition {
  validateTransition(input);
  return {
    expected: input.expected.map((item) => ({
      ...item,
      value: item.value === undefined ? null : encodeRecord(item.value),
    })),
    changes: input.changes.map((item) =>
      item.kind === 'delete' ? item : { ...item, value: encodeRecord(item.value) },
    ),
    events: input.events.map((item) => ({ ...item, value: encodeRecord(item.value) })),
  };
}
