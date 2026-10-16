import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { chmodSync } from 'node:fs';

interface Request {
  id: number;
  method: string;
  args: unknown[];
}
const settings = workerData as { path: string; readOnly: boolean };
let database: DatabaseSync;
const port = parentPort;
if (!port) throw new Error('Storage worker requires a parent');

function parse(value: unknown, location: string): unknown {
  if (typeof value !== 'string')
    throw new Error(`Malformed stored record ${location}; original record retained`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed stored JSON ${location}; original record retained`);
  }
}

try {
  database = new DatabaseSync(settings.path, { readOnly: settings.readOnly, allowExtension: false });
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (!settings.readOnly) {
    chmodSync(settings.path, 0o600);
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,key));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,sequence);
      CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    database.exec(
      'CREATE TABLE IF NOT EXISTS native_receipts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES events(sequence));',
    );
  }
  port.postMessage({ ready: true });
} catch (error) {
  port.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) });
  port.close();
}

port.on('message', ({ id, method, args }: Request) => {
  try {
    let result: unknown;
    switch (method) {
      case 'get': {
        const row = database
          .prepare('SELECT value FROM records WHERE collection=? AND key=?')
          .get(String(args[0]), String(args[1]));
        result = row
          ? { found: true, value: parse(row['value'], `${String(args[0])}/${String(args[1])}`) }
          : { found: false };
        break;
      }
      case 'set':
        database
          .prepare(
            'INSERT INTO records(collection,key,value) VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value',
          )
          .run(String(args[0]), String(args[1]), String(args[2]));
        result = null;
        break;
      case 'entries':
        result = database
          .prepare('SELECT key,value FROM records WHERE collection=? ORDER BY key LIMIT ?')
          .all(String(args[0]), Number(args[1]))
          .map((row) => ({
            key: row['key'],
            value: parse(row['value'], `${String(args[0])}/${String(row['key'])}`),
          }));
        break;
      case 'delete':
        result =
          database
            .prepare('DELETE FROM records WHERE collection=? AND key=?')
            .run(String(args[0]), String(args[1])).changes > 0;
        break;
      case 'appendEvent': {
        result = Number(
          database
            .prepare('INSERT INTO events(run_id,value) VALUES(?,?)')
            .run(String(args[0]), String(args[1])).lastInsertRowid,
        );
        break;
      }
      case 'events':
        result = database
          .prepare(
            'SELECT sequence,value FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
          )
          .all(String(args[0]), Number(args[1]), Number(args[2]))
          .map((row) => ({
            sequence: row['sequence'],
            event: parse(row['value'], `event ${String(row['sequence'])}`),
          }));
        break;
      case 'submit':
      case 'submitAndSet': {
        database.exec('BEGIN IMMEDIATE');
        try {
          const row = database
            .prepare('SELECT value FROM submissions WHERE idempotency_key=?')
            .get(String(args[0]));
          if (row && row['value'] !== args[1])
            throw new Error('Idempotency key already binds a different submission');
          if (!row)
            database
              .prepare('INSERT INTO submissions(idempotency_key,value) VALUES(?,?)')
              .run(String(args[0]), String(args[1]));
          if (!row && method === 'submitAndSet')
            database
              .prepare('INSERT INTO records(collection,key,value) VALUES(?,?,?)')
              .run(String(args[2]), String(args[3]), String(args[1]));
          result = { created: !row, value: parse(row ? row['value'] : args[1], 'submission') };
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        break;
      }
      case 'compareAndSet': {
        database.exec('BEGIN IMMEDIATE');
        try {
          const row = database
            .prepare('SELECT value FROM records WHERE collection=? AND key=?')
            .get(String(args[0]), String(args[1]));
          if (row) parse(row['value'], 'compare-and-set');
          const matches = row ? row['value'] === args[2] : args[2] === null;
          if (matches)
            database
              .prepare(
                'INSERT INTO records(collection,key,value) VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value',
              )
              .run(String(args[0]), String(args[1]), String(args[3]));
          result = matches;
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        break;
      }
      case 'ingestReceipt': {
        database.exec('BEGIN IMMEDIATE');
        try {
          const row = database
            .prepare('SELECT run_id,event,sequence FROM native_receipts WHERE id=?')
            .get(String(args[0]));
          if (row && (row['run_id'] !== args[1] || row['event'] !== args[2]))
            throw new Error('Native receipt already binds different evidence');
          const sequence = row
            ? Number(row['sequence'])
            : Number(
                database
                  .prepare('INSERT INTO events(run_id,value) VALUES(?,?)')
                  .run(String(args[1]), String(args[2])).lastInsertRowid,
              );
          if (!row)
            database
              .prepare('INSERT INTO native_receipts(id,run_id,event,sequence) VALUES(?,?,?,?)')
              .run(String(args[0]), String(args[1]), String(args[2]), sequence);
          result = { created: !row, sequence };
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        break;
      }
      case 'close':
        database.close();
        result = null;
        break;
      default:
        throw new Error('Unsupported storage operation');
    }
    port.postMessage({ id, result });
    if (method === 'close') port.close();
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
