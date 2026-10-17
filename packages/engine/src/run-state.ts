import type { Operation, RunPauseReason, RunRecord } from './workflow-types.js';

/** Project legacy records without changing their stored bytes or authorizing replay. */
export function runPauseReason(run: RunRecord, operation?: Operation): RunPauseReason | undefined {
  if (['needs-inspection', 'failed', 'cancelled'].includes(run.status))
    return {
      kind: 'inspection',
      instructions: 'Inspect the phone and retained recovery obligations before another reviewed operation.',
    };
  if (run.status !== 'pending') return undefined;
  if (run.manualGate)
    return run.pauseReason?.kind === 'manual-step' && run.pauseReason.gate === run.manualGate
      ? run.pauseReason
      : { kind: 'manual-step', gate: run.manualGate };
  if (operation === 'install-os' || run.pauseReason?.kind === 'reenrollment')
    return {
      kind: 'reenrollment',
      instructions:
        'Finish phone setup, authorize USB debugging and re-enroll before preparing provisioning.',
    };
  return {
    kind: 'acceptance',
    instructions: 'Complete the required acceptance checks before finalization and recipient custody.',
  };
}

export function withRunPauseReason(run: RunRecord, operation?: Operation): RunRecord {
  const { pauseReason: _previous, ...record } = run;
  void _previous;
  const pauseReason = runPauseReason(run, operation);
  return { ...record, ...(pauseReason ? { pauseReason } : {}) };
}
