import { mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';

interface Reply {
  id?: number;
  result?: unknown;
  error?: string;
  ready?: boolean;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** All synchronous SQLite operations are confined to one dedicated worker. */
export class SqliteStore {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #sequence = 0;
  #closed = false;
  private constructor(worker: Worker) {
    this.#worker = worker;
  }

  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<SqliteStore> {
    const metadata = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()))
      throw new Error('Database must be a regular file');
    if (!metadata && options.readOnly) throw new Error('Read-only project database does not exist');
    if (!options.readOnly) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./worker${suffix}`, import.meta.url), {
      workerData: { path, readOnly: options.readOnly ?? false },
    });
    const store = new SqliteStore(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (reply: Reply) => {
        if (reply.ready) resolve();
        else reject(new Error(reply.error ?? 'Storage worker failed to initialize'));
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Storage worker exited ${code}`));
      });
    }).catch(async (error: unknown) => {
      await worker.terminate();
      throw error;
    });
    worker.on('message', (reply: Reply) => {
      if (reply.id === undefined) return;
      const pending = store.#pending.get(reply.id);
      if (!pending) return;
      store.#pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.result);
    });
    const failed = (error: Error): void => {
      store.#closed = true;
      for (const pending of store.#pending.values()) pending.reject(error);
      store.#pending.clear();
    };
    worker.on('error', failed);
    worker.on('exit', (code) => failed(new Error(`Storage worker closed (${code})`)));
    return store;
  }

  #request<T>(method: string, args: unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Storage worker is closed'));
    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#worker.postMessage({ id, method, args });
    });
  }
  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const result = await this.#request<{ found: boolean; value?: T }>('get', [collection, key]);
    return result.found ? result.value : undefined;
  }
  set(collection: string, key: string, value: unknown): Promise<void> {
    return this.#request('set', [collection, key, encode(value)]);
  }
  entries<T = unknown>(collection: string, limit = 1000): Promise<{ key: string; value: T }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      return Promise.reject(new Error('Invalid entry limit'));
    return this.#request('entries', [collection, limit]);
  }
  delete(collection: string, key: string): Promise<boolean> {
    return this.#request('delete', [collection, key]);
  }
  appendEvent(runId: string, event: unknown): Promise<number> {
    return this.#request('appendEvent', [runId, encode(event)]);
  }
  events<T = unknown>(runId: string, after = 0, limit = 100): Promise<{ sequence: number; event: T }[]> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      return Promise.reject(new Error('Invalid event cursor or limit'));
    return this.#request('events', [runId, after, limit]);
  }
  submit<T>(idempotencyKey: string, value: T): Promise<{ created: boolean; value: T }> {
    return this.#request('submit', [idempotencyKey, encode(value)]);
  }
  submitAndSet<T>(
    idempotencyKey: string,
    value: T,
    collection: string,
    recordKey: string,
  ): Promise<{ created: boolean; value: T }> {
    return this.#request('submitAndSet', [idempotencyKey, encode(value), collection, recordKey]);
  }
  compareAndSet(collection: string, key: string, expected: unknown, next: unknown): Promise<boolean> {
    return this.#request('compareAndSet', [
      collection,
      key,
      expected === undefined ? null : encode(expected),
      encode(next),
    ]);
  }
  ingestReceipt(
    receiptId: string,
    runId: string,
    event: unknown,
  ): Promise<{ created: boolean; sequence: number }> {
    return this.#request('ingestReceipt', [receiptId, runId, encode(event)]);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#request('close', []);
    this.#closed = true;
  }
}

function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Stored records must be JSON values');
  return encoded;
}
