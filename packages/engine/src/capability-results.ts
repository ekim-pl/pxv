import { digest, ipInCidrs, sameAndroidUser, validateUserIdentity } from '@pxv/contracts';
import { isIP } from 'node:net';
import type { AndroidUserIdentity, NetworkProbePolicy, RecipePolicy } from '@pxv/contracts';
import type {
  CapabilityEvidenceRef,
  ProbeExecutionResult,
  ProbeObservation,
  RecipeExecutionResult,
} from './workflow-types.js';
import { EvidenceValidationError, validateEvidence } from './evidence-validation.js';

export interface RetainedCapabilityProof {
  kind: 'recipe' | 'network-probe';
  status: 'measured' | 'manual-completed';
  runId: string;
  policyDigest: string;
  configurationDigest: string;
  user: AndroidUserIdentity;
  observationDigest: string;
  app?: { packageId: string; versionCode: number; signerSha256: string };
  result: unknown;
}
function requireEvidence(
  value: unknown,
  message = 'Capability evidence is incomplete or mismatched',
): asserts value {
  if (!value) throw new EvidenceValidationError(message);
}
export function validateCapabilityProof(
  input: unknown,
  reference: CapabilityEvidenceRef,
  user: AndroidUserIdentity | undefined,
  policyDigest: string,
): RetainedCapabilityProof {
  return validateEvidence(() => {
    const proof = input as RetainedCapabilityProof;
    requireEvidence(
      proof &&
        user &&
        proof.kind === reference.kind &&
        proof.status === reference.status &&
        proof.policyDigest === policyDigest &&
        proof.configurationDigest === reference.configurationDigest,
    );
    requireEvidence(['measured', 'manual-completed'].includes(proof.status));
    requireEvidence(/^[a-f0-9]{64}$/u.test(proof.runId) && /^[a-f0-9]{64}$/u.test(proof.observationDigest));
    requireEvidence(sameAndroidUser(validateUserIdentity(proof.user), user));
    return proof;
  });
}
export function validateRecipeResult(
  recipe: RecipePolicy,
  input: unknown,
  status: RetainedCapabilityProof['status'] | 'manual-pending',
): RecipeExecutionResult {
  return validateEvidence(() => {
    const result = input as RecipeExecutionResult;
    requireEvidence(
      result && result.capability === 'app-setup' && result.recipeDigest === digest(recipe),
      'Recipe adapter returned evidence for a different configuration',
    );
    requireEvidence(
      status === 'measured'
        ? result.status === 'measured' && result.postconditions === recipe.postconditions.length
        : result.status === 'manual-pending',
      'Recipe postcondition evidence is incomplete',
    );
    requireEvidence(result.instructions === undefined || typeof result.instructions === 'string');
    return result;
  });
}
function nullableString(value: unknown, valid: (value: string) => boolean): boolean {
  return value === null || (typeof value === 'string' && valid(value));
}
function observation(input: unknown, user: AndroidUserIdentity): ProbeObservation {
  const value = input as ProbeObservation;
  requireEvidence(
    value &&
      Number.isSafeInteger(value.uid) &&
      Math.floor(value.uid / 100000) === user.userId &&
      value.uid % 100000 >= 10000,
  );
  for (const key of ['requestSucceeded', 'connectionObserved', 'vpnActive'] as const)
    requireEvidence(typeof value[key] === 'boolean');
  requireEvidence(nullableString(value.egressIp, (value) => !!isIP(value)));
  requireEvidence(nullableString(value.errorType, (value) => /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(value)));
  return value;
}
function blocked(value: ProbeObservation): void {
  requireEvidence(
    !value.requestSucceeded &&
      !value.connectionObserved &&
      [
        'ConnectException',
        'SocketTimeoutException',
        'UnknownHostException',
        'NoRouteToHostException',
      ].includes(value.errorType ?? ''),
  );
}
function route(value: ProbeObservation, probe: NetworkProbePolicy): void {
  requireEvidence(
    value.requestSucceeded &&
      value.connectionObserved &&
      (!probe.requireVpn || value.vpnActive) &&
      value.egressIp &&
      ipInCidrs(value.egressIp, probe.expectedEgressCidrs),
  );
}
export function validateProbeResult(
  probe: NetworkProbePolicy,
  input: unknown,
  user: AndroidUserIdentity,
): ProbeExecutionResult {
  return validateEvidence(() => {
    const result = input as ProbeExecutionResult;
    requireEvidence(
      result &&
        result.scope === 'probe-app-uid-https-only' &&
        Array.isArray(result.failures) &&
        result.failures.length === probe.failurePackages.length,
    );
    const normal = observation(result.normal, user);
    route(normal, probe);
    for (const [index, failure] of result.failures.entries()) {
      requireEvidence(failure && failure.stoppedPackage === probe.failurePackages[index]);
      const stopped = observation(failure.stopped, user),
        recovered = observation(failure.recovered, user);
      requireEvidence(stopped.uid === normal.uid && recovered.uid === normal.uid);
      blocked(stopped);
      route(recovered, probe);
    }
    return result;
  });
}
