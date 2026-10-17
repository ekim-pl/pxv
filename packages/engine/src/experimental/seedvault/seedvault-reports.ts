import {
  digest,
  sameAndroidUser,
  validateSeedvaultEvidence,
  validateSeedvaultProgress,
  type SeedvaultProfileResult,
  type SeedvaultEvidence,
  type SeedvaultProgress,
} from '@pxv/contracts';
import type { RunRecord } from '../../workflow-types.js';
import type { PreparedSeedvaultOperation, SeedvaultReport } from './seedvault-types.js';

export function initialSeedvaultReport(
  run: RunRecord,
  prepared: PreparedSeedvaultOperation,
): SeedvaultReport {
  const previous = prepared.refreshedFrom?.progress;
  if (previous)
    return { ...structuredClone(previous), runId: run.id, planId: run.planId, status: run.status };
  return {
    schemaVersion: 1,
    runId: run.id,
    planId: run.planId,
    operation: prepared.request.operation,
    deviceSerial: prepared.target.device.canonicalSerial,
    status: run.status,
    cursor: 0,
    profiles: prepared.baseline.profiles.map(({ profileId, user }) => ({
      profileId,
      user,
      status: 'queued',
    })),
  };
}

export function validateSeedvaultReport(
  report: SeedvaultReport,
  run: RunRecord,
  prepared: PreparedSeedvaultOperation,
): void {
  const { refreshedFrom: _lineage, ...original } = prepared;
  void _lineage;
  const expected = initialSeedvaultReport(run, original);
  validateReportIdentity(report, run, expected);
  if (
    digest(report.profiles.map(({ profileId, user }) => ({ profileId, user }))) !==
    digest(expected.profiles.map(({ profileId, user }) => ({ profileId, user })))
  )
    throw new Error('Seedvault progress Android identities changed');
  if (run.cursor !== undefined && run.cursor !== report.cursor)
    throw new Error('Seedvault run and profile cursors disagree');
  report.profiles.forEach((profile, index) => validateReportProfile(profile, index, report.cursor, prepared));
}

function validateReportIdentity(report: SeedvaultReport, run: RunRecord, expected: SeedvaultReport): void {
  if (
    report.schemaVersion !== 1 ||
    report.runId !== run.id ||
    report.planId !== run.planId ||
    report.operation !== expected.operation ||
    report.deviceSerial !== expected.deviceSerial ||
    !Number.isSafeInteger(report.cursor) ||
    report.cursor < 0 ||
    report.cursor > expected.profiles.length
  )
    throw new Error('Malformed Seedvault progress retained for inspection');
}

function validateReportProfile(
  profile: SeedvaultReport['profiles'][number],
  index: number,
  cursor: number,
  prepared: PreparedSeedvaultOperation,
): void {
  if ((profile.status === 'completed') !== index < cursor)
    throw new Error('Seedvault completed profile cursor is inconsistent');
  if (profile.progress) validateSeedvaultProgress(profile.progress);
  if (profile.status !== 'completed') return;
  if (!profile.evidence || !profile.progress)
    throw new Error('Completed Seedvault profile has no durable evidence');
  validateSeedvaultResult(
    { status: 'measured', evidence: profile.evidence, progress: profile.progress },
    prepared,
    index,
  );
}

export function validateSeedvaultResult(
  result: SeedvaultProfileResult,
  prepared: PreparedSeedvaultOperation,
  index: number,
): void {
  if (result.progress) validateProgressBinding(result.progress, prepared);
  if (result.status === 'manual-pending') {
    if (!result.instructions.trim() || result.instructions.length > 4096)
      throw new Error('Seedvault manual checkpoint instructions are invalid');
    return;
  }
  const evidence = validateSeedvaultEvidence(result.evidence);
  if (result.progress.phase !== 'completed') throw new Error('Seedvault completion evidence is incomplete');
  validateEvidenceIdentity(evidence, prepared, index);
  validateEvidenceSource(evidence, prepared);
}

function validateProgressBinding(progress: SeedvaultProgress, prepared: PreparedSeedvaultOperation): void {
  validateSeedvaultProgress(progress);
  if (!prepared.request.adapter || progress.adapterDigest !== digest(prepared.request.adapter))
    throw new Error('Seedvault progress differs from the reviewed adapter');
}

function validateEvidenceIdentity(
  evidence: SeedvaultEvidence,
  prepared: PreparedSeedvaultOperation,
  index: number,
): void {
  const profile = prepared.baseline.profiles[index];
  if (!profile || evidence.profileId !== profile.profileId || !sameAndroidUser(evidence.user, profile.user))
    throw new Error('Seedvault evidence belongs to a different Android profile');
  if (evidence.operation !== prepared.request.operation)
    throw new Error('Seedvault completion operation differs from review');
  if (!prepared.request.adapter || evidence.adapterDigest !== digest(prepared.request.adapter))
    throw new Error('Seedvault evidence is not bound to the reviewed exact-build adapter');
}

function validateEvidenceSource(evidence: SeedvaultEvidence, prepared: PreparedSeedvaultOperation): void {
  if (evidence.source.profileId !== evidence.profileId || evidence.source.token !== evidence.token)
    throw new Error('Seedvault durable backup identity is inconsistent');
  const source = prepared.request.sources?.find((item) => item.profileId === evidence.profileId);
  if (prepared.request.operation === 'restore' && (!source || digest(source) !== digest(evidence.source)))
    throw new Error('Seedvault restored a different backup source');
}
