import { digest, observationDigest, sameAndroidUser, validateAttestation } from '@pxv/contracts';
import type { Action, AndroidUserIdentity, DeviceObservation } from '@pxv/contracts';
import type { PreparedOperation, RunRecord, VpnSettingsProof } from './workflow-types.js';

export function pausedVpnAction(
  prepared: PreparedOperation | undefined,
  run: RunRecord | undefined,
): Extract<Action, { kind: 'vpn' }> | undefined {
  if (run?.status !== 'pending' || run.manualGate !== 'vpn_settings' || !Number.isSafeInteger(run.cursor))
    return undefined;
  const action = prepared?.plan.actions[run.cursor ?? -1];
  return action?.kind === 'vpn' ? action : undefined;
}
/** Only the active profile's reviewed VPN transition is allowed at this checkpoint. */
export function checkVpnDelta(
  expected: DeviceObservation,
  actual: DeviceObservation,
  action: Extract<Action, { kind: 'vpn' }>,
): void {
  const normalized = structuredClone(actual);
  const profile = normalized.profiles.find((value) => value.profileId === action.profileId);
  const prior = expected.profiles.find((value) => value.profileId === action.profileId);
  if (!profile || !prior) throw new Error('VPN checkpoint profile identity changed');
  if (![digest(prior.vpn), digest(action.vpn)].includes(digest(profile.vpn)))
    throw new Error('VPN change differs from the reviewed configuration');
  profile.vpn = prior.vpn;
  if (observationDigest(normalized) !== observationDigest(expected))
    throw new Error('Other live requirements changed during VPN Settings verification');
}
export function vpnProofDigest(proof: Omit<VpnSettingsProof, 'proofDigest'>): string {
  return digest(proof);
}
function proofIdentity(proof: VpnSettingsProof, evidenceId: string, status: string): boolean {
  return (
    proof.kind === 'vpn-settings' &&
    proof.scope === 'operator-witnessed-settings' &&
    proof.status === 'manual-completed' &&
    proof.status === status &&
    typeof proof.planId === 'string' &&
    proof.planId.length > 0 &&
    Number.isSafeInteger(proof.actionIndex) &&
    proof.actionIndex >= 0 &&
    evidenceId === `${proof.runId}:vpn:${proof.actionIndex}`
  );
}
function proofReceipt(proof: VpnSettingsProof, profileId: string): boolean {
  const receipt = validateAttestation(proof.receipt);
  return (
    receipt.check === 'vpn_settings' &&
    receipt.planDigest === proof.planDigest &&
    receipt.observationDigest === proof.observationDigest &&
    receipt.profileIds.length === 1 &&
    receipt.profileIds[0] === profileId
  );
}
interface VpnBinding {
  profileId: string;
  user: AndroidUserIdentity | undefined;
  configurationDigest: string;
  policyDigest: string;
  assetId: string;
  deviceSerial: string;
  status: string;
}
function proofBinding(proof: VpnSettingsProof, binding: VpnBinding): boolean {
  return (
    !!binding.user &&
    proof.profileId === binding.profileId &&
    proof.policyDigest === binding.policyDigest &&
    proof.configurationDigest === binding.configurationDigest &&
    proof.assetId === binding.assetId &&
    proof.deviceSerial === binding.deviceSerial &&
    sameAndroidUser(proof.user, binding.user)
  );
}
export function validVpnProof(
  value: unknown,
  evidenceId: string,
  binding: VpnBinding,
): value is VpnSettingsProof {
  try {
    const proof = value as VpnSettingsProof;
    const { proofDigest, ...body } = proof;
    return (
      proofDigest === vpnProofDigest(body) &&
      proofIdentity(proof, evidenceId, binding.status) &&
      proofBinding(proof, binding) &&
      proofReceipt(proof, binding.profileId)
    );
  } catch {
    return false;
  }
}
