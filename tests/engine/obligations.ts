import { randomUUID } from 'node:crypto';
import type { AndroidUserIdentity, RecoveryObligation } from '@pxv/contracts';
import type { ResourceScope } from '@pxv/engine';

/** Build synthetic evidence through the same owner-bound capability used by adapters. */
export async function recordObligation(
  scope: ResourceScope,
  kind: string,
  resource: string,
  payload: Record<string, unknown>,
  user?: AndroidUserIdentity,
): Promise<RecoveryObligation> {
  const writer = scope.writer();
  const value: RecoveryObligation = {
    schemaVersion: 1,
    id: randomUUID(),
    operationId: writer.operationId,
    ownerOperationId: writer.ownerOperationId,
    deviceSerial: scope.deviceSerial,
    kind,
    resource,
    payload,
    status: 'pending',
    ...(user ? { user } : {}),
  };
  await writer.record(value);
  return value;
}
