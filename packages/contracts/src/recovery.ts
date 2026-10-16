import type { RecoveryObligation } from './types.js';

/** A child capability owns a distinct resource scope within one root operation. */
export interface ObligationWriter {
  readonly operationId: string;
  readonly ownerOperationId: string;
  child(name: string): ObligationWriter;
  record(obligation: RecoveryObligation): Promise<void>;
  resolve(id: string): Promise<void>;
}
