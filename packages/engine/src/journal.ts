import { randomUUID } from 'node:crypto';
import { nativeReceipts, type Store, type RecordChange, type ExpectedRecord } from '@pxv/runtime';
import type { RunRecord } from './workflow-types.js';
export interface Journal {
  track(run: RunRecord): void;
  event(runId: string, type: string, data: Record<string, unknown>): Promise<void>;
  entry(
    runId: string,
    type: string,
    data: Record<string, unknown>,
  ): { schemaVersion: 1; id: string; runId: string; at: string; type: string; data: Record<string, unknown> };
  ingestNative(runId: string, operationId?: string): Promise<void>;
  save(
    run: RunRecord,
    type: string,
    changes?: RecordChange[],
    expected?: ExpectedRecord[],
    data?: Record<string, unknown>,
  ): Promise<void>;
}
export class RunJournal implements Journal {
  private readonly runSnapshots = new WeakMap<RunRecord, RunRecord>();
  constructor(
    readonly store: Store,
    readonly controlRoot: string,
    readonly clock: () => Date,
  ) {}
  track(run: RunRecord): void {
    this.runSnapshots.set(run, structuredClone(run));
  }
  async event(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.store.appendEvent(runId, this.entry(runId, type, data));
  }
  entry(runId: string, type: string, data: Record<string, unknown>) {
    return {
      schemaVersion: 1 as const,
      id: randomUUID(),
      runId,
      at: this.clock().toISOString(),
      type,
      data,
    };
  }
  async ingestNative(runId: string, operationId = runId): Promise<void> {
    for (const receipt of await nativeReceipts(this.controlRoot, operationId)) {
      if (receipt.status !== 'completed') continue;
      await this.store.ingestReceipt(receipt.id, runId, {
        schemaVersion: 1 as const,
        id: receipt.id,
        runId,
        at: await this.nativeEventTime(receipt.id),
        type: 'native-completed',
        data: receipt,
      });
    }
  }
  private async nativeEventTime(id: string): Promise<string> {
    const collection = 'native-event-times';
    const marker = await this.store.get<unknown>(collection, id);
    if (marker !== undefined) return this.validateNativeTime(marker);
    const previous = await this.store.ingestedReceipt<{ at?: unknown }>(id);
    const first = previous ? this.validateNativeTime(previous.at) : this.clock().toISOString();
    if (await this.store.compareAndSet(collection, id, undefined, first)) return first;
    return this.validateNativeTime(await this.store.get<unknown>(collection, id));
  }
  private validateNativeTime(stored: unknown): string {
    if (typeof stored !== 'string' || !Number.isFinite(Date.parse(stored)))
      throw new Error('Malformed native event time retained for inspection');
    return stored;
  }
  async save(
    run: RunRecord,
    type: string,
    changes: RecordChange[] = [],
    expected: ExpectedRecord[] = [],
    data: Record<string, unknown> = {},
  ): Promise<void> {
    const committed = await this.store.transition({
      expected: [{ collection: 'runs', key: run.id, value: this.runSnapshots.get(run) }, ...expected],
      changes: [{ kind: 'set', collection: 'runs', key: run.id, value: run }, ...changes],
      events: [{ runId: run.id, value: this.entry(run.id, type, { status: run.status, ...data }) }],
    });
    if (!committed) throw new Error('Run evidence changed; inspect before retrying');
    this.runSnapshots.set(run, structuredClone(run));
  }
}
