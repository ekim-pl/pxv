import { randomUUID } from 'node:crypto';
import {
  sameAndroidUser,
  validateObligation,
  type AndroidUserIdentity,
  type RecoveryObligation,
} from '@pxv/contracts';
import type { SqliteStore } from '@pxv/runtime';

/** Resource scopes survive crashes; child cleanup cannot release a parent's resources. */
export class ResourceScope {
  constructor(
    readonly store: SqliteStore,
    readonly deviceSerial: string,
    readonly operationId: string,
    readonly ownerOperationId = operationId,
  ) {}

  child(id = randomUUID()): ResourceScope {
    return new ResourceScope(this.store, this.deviceSerial, id, this.ownerOperationId);
  }

  async register(
    kind: string,
    resource: string,
    payload: Record<string, unknown>,
    user?: AndroidUserIdentity,
  ): Promise<RecoveryObligation> {
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: randomUUID(),
      operationId: this.ownerOperationId,
      ownerOperationId: this.operationId,
      deviceSerial: this.deviceSerial,
      kind,
      resource,
      payload,
      status: 'pending',
      ...(user ? { user } : {}),
    };
    await this.record(obligation);
    return obligation;
  }

  async record(input: RecoveryObligation): Promise<void> {
    const obligation = validateObligation(input);
    if (
      obligation.deviceSerial !== this.deviceSerial ||
      obligation.operationId !== this.ownerOperationId ||
      obligation.status !== 'pending'
    )
      throw new Error('Recovery obligation is outside this operation');
    let saved = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      const original = await this.store.get<unknown>('obligations', this.deviceSerial);
      const entries = this.validate(original);
      if (entries.some((entry) => entry.id === obligation.id))
        throw new Error('Duplicate recovery obligation');
      if (
        await this.store.compareAndSet('obligations', this.deviceSerial, original, [...entries, obligation])
      ) {
        saved = true;
        break;
      }
    }
    if (!saved) throw new Error('Recovery record contention; inspect before continuing');
  }

  async resolve(id: string): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const original = await this.store.get<unknown>('obligations', this.deviceSerial);
      const entries = this.validate(original);
      const entry = entries.find((value) => value.id === id);
      if (!entry || entry.operationId !== this.ownerOperationId)
        throw new Error('Recovery obligation is outside this operation');
      const next = entries.map((value) =>
        value.id === id ? { ...value, status: 'resolved' as const } : value,
      );
      if (await this.store.compareAndSet('obligations', this.deviceSerial, original, next)) return;
    }
    throw new Error('Recovery completion could not be persisted');
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

  async list(): Promise<RecoveryObligation[]> {
    return this.validate(await this.store.get<unknown>('obligations', this.deviceSerial));
  }

  async cleanup(
    inspectUser: (user: AndroidUserIdentity) => Promise<AndroidUserIdentity>,
    release: (obligation: RecoveryObligation) => Promise<void>,
  ): Promise<void> {
    const entries = await this.list();
    const failures: string[] = [];
    for (const entry of entries.filter(
      (value) =>
        value.ownerOperationId === this.operationId &&
        value.operationId === this.ownerOperationId &&
        value.status !== 'resolved',
    )) {
      try {
        if (entry.user) {
          const actual = await inspectUser(entry.user);
          if (!sameAndroidUser(entry.user, actual))
            throw new Error('Android user identity changed; cleanup retained');
        }
        await release(entry);
        entry.status = 'resolved';
      } catch (error) {
        entry.status = 'blocked';
        failures.push(error instanceof Error ? error.message : 'Cleanup failed');
      }
      let saved = false;
      for (let attempt = 0; attempt < 32; attempt++) {
        const original = await this.store.get<unknown>('obligations', this.deviceSerial);
        const current = this.validate(original);
        if (!current.some((value) => value.id === entry.id))
          throw new Error('Recovery record disappeared during cleanup');
        const next = current.map((value) => (value.id === entry.id ? entry : value));
        if (await this.store.compareAndSet('obligations', this.deviceSerial, original, next)) {
          saved = true;
          break;
        }
      }
      if (!saved) throw new Error('Recovery completion could not be persisted; inspect before continuing');
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}
