/** Retained data failed validation; infrastructure failures must keep their original identity. */
export class EvidenceValidationError extends Error {}

/** Only synchronous, side-effect-free evidence checks belong inside this boundary. */
export function validateEvidence<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof EvidenceValidationError) throw error;
    throw new EvidenceValidationError(error instanceof Error ? error.message : 'Invalid retained evidence', {
      cause: error,
    });
  }
}
