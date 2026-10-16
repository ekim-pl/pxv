import { observationDigest } from '@pxv/contracts';
import type { DeviceObservation, OperatorAttestation } from '@pxv/contracts';
import type { SetupReceiptRef } from './workflow-types.js';
export function normalReceiptMatches(
  value: OperatorAttestation,
  planDigest: string,
  live: DeviceObservation,
  completed: readonly SetupReceiptRef[] = [],
): boolean {
  if (value.check !== 'normal_credentials') return false;
  const current = value.planDigest === planDigest && value.observationDigest === observationDigest(live);
  return (
    current ||
    completed.some(
      (item) =>
        item.check === value.check && item.receiptId === value.id && item.planDigest === value.planDigest,
    )
  );
}
export function checkLanguageDelta(
  expected: DeviceObservation,
  actual: DeviceObservation,
  profileId: string,
): 'en-US' | 'pl-PL' | undefined {
  const normalized = structuredClone(actual);
  const profile = normalized.profiles.find((value) => value.profileId === profileId);
  const prior = expected.profiles.find((value) => value.profileId === profileId);
  if (!profile || !prior) throw new Error('Manual language profile identity changed');
  const language = profile.language;
  if (prior.language) profile.language = prior.language;
  else delete profile.language;
  if (observationDigest(normalized) !== observationDigest(expected))
    throw new Error('Other live requirements changed during manual language setup');
  return language;
}
