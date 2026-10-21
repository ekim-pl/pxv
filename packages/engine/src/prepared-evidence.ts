import { canonicalJson, digest, validateObservation, validatePlan } from '@pxv/contracts';
import { EvidenceValidationError, validateEvidence } from './evidence-validation.js';
import { canonicalEffects, preparedDigest, summaryData } from './reviewed-plan.js';
import type { PreparedOperation } from './workflow-types.js';

/** Authenticate retained content against its original extension baseline, without I/O or expiry checks. */
export function validatePreparedEvidence(input: unknown, extensions: unknown): PreparedOperation {
  return validateEvidence(() => {
    const value = input as PreparedOperation;
    validatePlan(value.plan);
    validateObservation(value.baseline);
    canonicalEffects(value.sharedEffects);
    if (
      value.schemaVersion !== 1 ||
      !['create-users', 'deploy-apps', 'provision', 'install-os', 'extension'].includes(value.operation) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new EvidenceValidationError('Malformed reviewed plan retained for inspection');
    assertTargetBinding(value);
    if (
      value.plan.digest !== preparedDigest(value, extensions) ||
      value.reviewSummary !== canonicalJson({ ...summaryData(value), planDigest: value.plan.digest })
    )
      throw new EvidenceValidationError('Stored reviewed plan changed; preserve it for inspection');
    return value;
  });
}

function assertTargetBinding(value: PreparedOperation): void {
  if (
    digest(value.plan.device) !== digest(value.baseline.device) ||
    digest(value.plan.device) !== digest(value.target.device) ||
    !value.plan.device.transports.some((transport) => digest(transport) === digest(value.target.transport))
  )
    throw new EvidenceValidationError('Reviewed plan target or baseline identity changed');
}
