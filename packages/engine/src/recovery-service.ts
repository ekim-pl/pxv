import { randomUUID } from 'node:crypto';
import type { RecoveryObligation, SelectedTarget } from '@pxv/contracts';
import type { DeviceLease, Store } from '@pxv/runtime';
import type { WorkflowPort } from './workflow-types.js';
import type { ObservationReader } from './observation-service.js';
import type { DeviceOwnership } from './ownership.js';
import type { Journal } from './journal.js';
import { ResourceScope } from './recovery.js';
export class RecoveryService {
  constructor(
    readonly store: Store,
    readonly port: WorkflowPort,
    readonly observations: ObservationReader,
    readonly devices: DeviceOwnership,
    readonly journal: Journal,
  ) {}
  /** Explicit recovery keeps the native fence held until every owned cleanup is measured. */
  async recover(
    target: SelectedTarget,
    previousOperationId: string,
    signal?: AbortSignal,
  ): Promise<{ operationId: string; resolved: number }> {
    this.observations.assertTarget(target);
    const rootScope = new ResourceScope(this.store, target.device.canonicalSerial, previousOperationId);
    const pending = (await rootScope.list()).filter(
      (obligation) => obligation.operationId === previousOperationId && obligation.status !== 'resolved',
    );
    if (pending.length && !this.port.cleanup)
      throw new Error('Typed device cleanup adapter is required for pending recovery obligations');
    const keys = this.devices.keys(target);
    const reservations = await this.devices.reservations(target.device);
    const attempt = await this.store.get<{ operationId: string; deviceSerial: string }>(
      'recovery-attempts',
      previousOperationId,
    );
    await this.journal.ingestNative(previousOperationId);
    if (attempt?.deviceSerial === target.device.canonicalSerial)
      await this.journal.ingestNative(previousOperationId, attempt.operationId);
    const fenced = reservations.find(
      (reservation) =>
        (reservation.operation_id === previousOperationId ||
          reservation.previous_operation_id === previousOperationId ||
          (attempt?.deviceSerial === target.device.canonicalSerial &&
            (reservation.operation_id === attempt.operationId ||
              reservation.previous_operation_id === attempt.operationId))) &&
        reservation.device_key === keys.device &&
        reservation.transport_key === keys.transport,
    );
    const recoverOwned = (lease: DeviceLease) =>
      this.recoverOwnedScope(target, previousOperationId, pending, rootScope, lease, signal);
    return fenced
      ? this.devices.recover(target, fenced.operation_id, recoverOwned)
      : this.devices.run(target, `recovery-${randomUUID()}`, recoverOwned);
  }
  private async recoverOwnedScope(
    target: SelectedTarget,
    previousOperationId: string,
    pending: RecoveryObligation[],
    rootScope: ResourceScope,
    lease: DeviceLease,
    signal?: AbortSignal,
  ): Promise<{ operationId: string; resolved: number }> {
    await this.store.set('recovery-attempts', previousOperationId, {
      operationId: lease.operationId,
      deviceSerial: target.device.canonicalSerial,
    });
    try {
      const owners = [...new Set(pending.map((obligation) => obligation.ownerOperationId))];
      for (const owner of owners) {
        const scope = new ResourceScope(
          this.store,
          target.device.canonicalSerial,
          owner,
          previousOperationId,
        );
        await scope.cleanup(
          async (user) => {
            signal?.throwIfAborted();
            if (this.port.inspectUser) return this.port.inspectUser(target, user, signal);
            const actual = (await this.observations.observe(target, signal)).profiles.find(
              (profile) => profile.user.userId === user.userId,
            )?.user;
            if (!actual) throw new Error('Recovery user is absent; preserve the obligation');
            return actual;
          },
          async (obligation) => {
            signal?.throwIfAborted();
            if (obligation.operationId !== previousOperationId || !this.port.cleanup)
              throw new Error('Cleanup owner changed during recovery');
            await this.port.cleanup(target, obligation, {
              lease,
              operationId: obligation.ownerOperationId,
              obligations: scope.writer(),
              ...(signal ? { signal } : {}),
            });
          },
        );
      }
      if (
        (await rootScope.list()).some(
          (obligation) => obligation.operationId === previousOperationId && obligation.status !== 'resolved',
        )
      )
        throw new Error('Recovery obligations remain unresolved');
      await this.journal.event(previousOperationId, 'recovered', {
        resolved: pending.length,
        recoveryOperationId: lease.operationId,
      });
      return { operationId: previousOperationId, resolved: pending.length };
    } finally {
      await this.journal.ingestNative(previousOperationId, lease.operationId);
    }
  }
}
