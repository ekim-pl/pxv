import { randomUUID } from 'node:crypto';
import {
  sameAndroidUser,
  validateObligation,
  type AndroidUserIdentity,
  type RecoveryObligation,
  type ObligationWriter,
} from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
/** Only this owner-bound capability crosses the adapter boundary. */
export class ResourceScope {
  constructor(
    readonly store: Store,
    readonly deviceSerial: string,
    readonly operationId: string,
    readonly ownerOperationId = operationId,
  ) {}
  child(name: string = randomUUID()): ResourceScope {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new Error('Invalid recovery child scope');
    return new ResourceScope(
      this.store,
      this.deviceSerial,
      `${this.operationId}:${name}`,
      this.ownerOperationId,
    );
  }
  writer(): ObligationWriter {
    return Object.freeze({
      operationId: this.ownerOperationId,
      ownerOperationId: this.operationId,
      child: (name: string) => this.child(name).writer(),
      record: (value: RecoveryObligation) => this.record(value),
      resolve: (id: string) => this.resolve(id),
    });
  }
  private owns(value: RecoveryObligation): boolean {
    return value.operationId === this.ownerOperationId && value.ownerOperationId === this.operationId;
  }
  async record(input: RecoveryObligation): Promise<void> {
    const value = validateObligation(input);
    if (value.deviceSerial !== this.deviceSerial || !this.owns(value) || value.status !== 'pending')
      throw new Error('Recovery obligation is outside this operation');
    await this.update((entries) => {
      if (entries.some((entry) => entry.id === value.id)) throw new Error('Duplicate recovery obligation');
      return [...entries, value];
    });
  }
  async resolve(id: string): Promise<void> {
    await this.update((entries) => {
      const entry = entries.find((value) => value.id === id);
      if (!entry || !this.owns(entry)) throw new Error('Recovery obligation is outside this operation');
      return entries.map((value) => (value.id === id ? { ...value, status: 'resolved' } : value));
    });
  }
  private async update(change: (entries: RecoveryObligation[]) => RecoveryObligation[]): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const original = await this.store.get<unknown>('obligations', this.deviceSerial);
      if (
        await this.store.compareAndSet(
          'obligations',
          this.deviceSerial,
          original,
          change(this.validate(original)),
        )
      )
        return;
    }
    throw new Error('Recovery record contention; inspect before continuing');
  }
  private validate(value: unknown): RecoveryObligation[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Malformed recovery records retained for inspection');
    const entries = value.map(validateObligation);
    if (
      entries.some((entry) => entry.deviceSerial !== this.deviceSerial) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    )
      throw new Error('Recovery identity mismatch retained for inspection');
    return entries;
  }
  list(): Promise<RecoveryObligation[]> {
    return this.store.get<unknown>('obligations', this.deviceSerial).then((value) => this.validate(value));
  }
  private async release(
    entry: RecoveryObligation,
    inspect: (user: AndroidUserIdentity) => Promise<AndroidUserIdentity>,
    release: (entry: RecoveryObligation) => Promise<void>,
  ): Promise<string | undefined> {
    let failure: string | undefined;
    try {
      if (entry.user && !sameAndroidUser(entry.user, await inspect(entry.user)))
        throw new Error('Android user identity changed; cleanup retained');
      await release(entry);
      entry.status = 'resolved';
    } catch (error) {
      entry.status = 'blocked';
      failure = error instanceof Error ? error.message : 'Cleanup failed';
    }
    await this.update((entries) => {
      if (!entries.some((value) => value.id === entry.id && this.owns(value)))
        throw new Error('Recovery record disappeared during cleanup');
      return entries.map((value) => (value.id === entry.id ? entry : value));
    });
    return failure;
  }
  async cleanup(
    inspect: (user: AndroidUserIdentity) => Promise<AndroidUserIdentity>,
    release: (entry: RecoveryObligation) => Promise<void>,
  ): Promise<void> {
    const entries = (await this.list()).filter((value) => this.owns(value) && value.status !== 'resolved');
    const failures: string[] = [];
    for (const entry of entries) {
      const failure = await this.release(entry, inspect, release);
      if (failure) failures.push(failure);
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}
