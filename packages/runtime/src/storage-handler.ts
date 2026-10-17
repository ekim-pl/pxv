import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { entryPageOptions, type EncodedTransition } from './store.ts';
export interface StorageRequest {
  id: number;
  method: string;
  args: unknown[];
}
export interface StorageSettings {
  path: string;
  readOnly: boolean;
}
function parseStored(value: unknown, location: string): unknown {
  if (typeof value !== 'string')
    throw new Error(`Malformed stored record ${location}; original record retained`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed stored JSON ${location}; original record retained`);
  }
}
export function openDatabase(settings: StorageSettings): DatabaseSync {
  const database = new DatabaseSync(settings.path, {
    readOnly: settings.readOnly,
    allowExtension: false,
    timeout: 5000,
  });
  try {
    initializeWithContention(database, settings);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
function initializeWithContention(database: DatabaseSync, settings: StorageSettings): void {
  const deadline = Date.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      initializeDatabase(database, settings);
      return;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
      // WAL activation may return SQLITE_BUSY without honoring SQLite's busy handler.
      // Initialization is idempotent; no application mutation is retried here.
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}
function initializeDatabase(database: DatabaseSync, settings: StorageSettings): void {
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (settings.readOnly) return;
  chmodSync(settings.path, 0o600);
  database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,key));
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,sequence);
    CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_receipts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES events(sequence));`);
}
export class StorageHandler {
  readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }
  dispatch(method: string, args: unknown[]): unknown {
    const handlers: Record<string, () => unknown> = {
      get: () => this.get(String(args[0]), String(args[1])),
      set: () => this.set(String(args[0]), String(args[1]), String(args[2])),
      entries: () => this.entries(String(args[0]), Number(args[1])),
      entriesPage: () => this.entriesPage(String(args[0]), args[1], args[2]),
      delete: () => this.delete(String(args[0]), String(args[1])),
      appendEvent: () => this.appendEvent(String(args[0]), String(args[1])),
      events: () => this.events(String(args[0]), Number(args[1]), Number(args[2])),
      submitAndSet: () => this.transaction(() => this.submitAndSet(args)),
      compareAndSet: () => this.transaction(() => this.compareAndSet(args)),
      ingestReceipt: () => this.transaction(() => this.ingestReceipt(args)),
      ingestedReceipt: () => this.ingestedReceipt(String(args[0])),
      transition: () => this.transaction(() => this.transition(args[0] as EncodedTransition)),
      close: () => {
        this.database.close();
        return null;
      },
    };
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new Error('Unsupported storage operation');
    return handler();
  }
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  private row(collection: string, key: string) {
    return this.database
      .prepare('SELECT value FROM records WHERE collection=? AND key=?')
      .get(collection, key);
  }
  private get(collection: string, key: string) {
    const row = this.row(collection, key);
    return row ? { found: true, value: parseStored(row['value'], `${collection}/${key}`) } : { found: false };
  }
  private set(collection: string, key: string, value: string): null {
    this.database
      .prepare(
        'INSERT INTO records(collection,key,value) VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value',
      )
      .run(collection, key, value);
    return null;
  }
  private entries(collection: string, limit: number) {
    return this.database
      .prepare('SELECT key,value FROM records WHERE collection=? ORDER BY key LIMIT ?')
      .all(collection, limit)
      .map((row) => ({
        key: row['key'],
        value: parseStored(row['value'], `${collection}/${String(row['key'])}`),
      }));
  }
  private entriesPage(collection: string, cursorValue: unknown, limitValue: unknown) {
    const { cursor, limit } = entryPageOptions({
      ...(cursorValue !== null ? { cursor: cursorValue as string } : {}),
      limit: limitValue as number,
    });
    const rows =
      cursor === undefined
        ? this.database
            .prepare('SELECT key,value FROM records WHERE collection=? ORDER BY key LIMIT ?')
            .all(collection, limit + 1)
        : this.database
            .prepare('SELECT key,value FROM records WHERE collection=? AND key>? ORDER BY key LIMIT ?')
            .all(collection, cursor, limit + 1);
    const items = rows.slice(0, limit).map((row) => ({
      key: String(row['key']),
      value: parseStored(row['value'], `${collection}/${String(row['key'])}`),
    }));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.key : null };
  }
  private delete(collection: string, key: string): boolean {
    return (
      this.database.prepare('DELETE FROM records WHERE collection=? AND key=?').run(collection, key).changes >
      0
    );
  }
  private appendEvent(runId: string, value: string): number {
    return Number(
      this.database.prepare('INSERT INTO events(run_id,value) VALUES(?,?)').run(runId, value).lastInsertRowid,
    );
  }
  private events(runId: string, after: number, limit: number) {
    return this.database
      .prepare('SELECT sequence,value FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(runId, after, limit)
      .map((row) => ({
        sequence: row['sequence'],
        event: parseStored(row['value'], `event ${String(row['sequence'])}`),
      }));
  }
  private submitAndSet(args: unknown[]) {
    const row = this.database
      .prepare('SELECT value FROM submissions WHERE idempotency_key=?')
      .get(String(args[0]));
    if (row && row['value'] !== args[1])
      throw new Error('Idempotency key already binds a different submission');
    if (!row)
      this.database
        .prepare('INSERT INTO submissions(idempotency_key,value) VALUES(?,?)')
        .run(String(args[0]), String(args[1]));
    if (!row)
      this.database
        .prepare('INSERT INTO records(collection,key,value) VALUES(?,?,?)')
        .run(String(args[2]), String(args[3]), String(args[1]));
    return { created: !row, value: parseStored(row ? row['value'] : args[1], 'submission') };
  }
  private matches(collection: string, key: string, value: unknown): boolean {
    const row = this.row(collection, key);
    if (row) parseStored(row['value'], 'compare-and-set');
    return row ? row['value'] === value : value === null;
  }
  private compareAndSet(args: unknown[]): boolean {
    const matches = this.matches(String(args[0]), String(args[1]), args[2]);
    if (matches) this.set(String(args[0]), String(args[1]), String(args[3]));
    return matches;
  }
  private ingestReceipt(args: unknown[]) {
    const row = this.database
      .prepare('SELECT run_id,event,sequence FROM native_receipts WHERE id=?')
      .get(String(args[0]));
    if (row && (row['run_id'] !== args[1] || row['event'] !== args[2]))
      throw new Error('Native receipt already binds different evidence');
    const sequence = row ? Number(row['sequence']) : this.appendEvent(String(args[1]), String(args[2]));
    if (!row)
      this.database
        .prepare('INSERT INTO native_receipts(id,run_id,event,sequence) VALUES(?,?,?,?)')
        .run(String(args[0]), String(args[1]), String(args[2]), sequence);
    return { created: !row, sequence };
  }
  private ingestedReceipt(id: string): unknown {
    const row = this.database.prepare('SELECT event FROM native_receipts WHERE id=?').get(id);
    return row ? parseStored(row['event'], `native receipt ${id}`) : undefined;
  }
  private transition(input: EncodedTransition): boolean {
    if (!input.expected.every((item) => this.matches(item.collection, item.key, item.value))) return false;
    for (const item of input.changes) {
      if (item.kind === 'set') this.set(item.collection, item.key, item.value);
      else this.delete(item.collection, item.key);
    }
    for (const event of input.events) this.appendEvent(event.runId, event.value);
    return true;
  }
}
