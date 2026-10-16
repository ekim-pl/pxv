import type { RecoveryObligation } from '@pxv/contracts';
import type { ObligationWriter } from '@pxv/contracts';
/** A real owner-bound in-memory writer: tests must obey the same ownership rules as storage. */
export function obligationWriter(
  operationId: string,
  record: (value: RecoveryObligation) => Promise<void>,
  resolve: (id: string) => Promise<void>,
  ownerOperationId = operationId,
  owners = new Map<string, string>(),
): ObligationWriter {
  return {
    operationId,
    ownerOperationId,
    child: (name) => obligationWriter(operationId, record, resolve, ownerOperationId + ':' + name, owners),
    record: async (value) => {
      if (value.operationId !== operationId || value.ownerOperationId !== ownerOperationId)
        throw new Error('Wrong obligation owner');
      owners.set(value.id, ownerOperationId);
      await record(value);
    },
    resolve: async (id) => {
      const owner = owners.get(id);
      if (owner !== ownerOperationId) throw new Error('Cannot resolve another owner');
      await resolve(id);
    },
  };
}
