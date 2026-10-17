import { expect, it } from 'vitest';
import { runPauseReason, withRunPauseReason, type RunRecord } from '@pxv/engine';

const legacy: RunRecord = {
  id: 'run',
  planId: 'plan',
  status: 'pending',
  createdAt: '2026-10-17T09:00:00Z',
  operator: 'Operator',
};

it('projects legacy manual, re-enrollment and acceptance pauses without modifying stored records', () => {
  const manual = { ...legacy, cursor: 2, manualGate: 'language:work' };
  expect(runPauseReason(manual)).toEqual({ kind: 'manual-step', gate: 'language:work' });
  expect(withRunPauseReason(legacy, 'install-os').pauseReason?.kind).toBe('reenrollment');
  expect(withRunPauseReason(legacy, 'provision').pauseReason?.kind).toBe('acceptance');
  expect(legacy).not.toHaveProperty('pauseReason');
  expect(manual).not.toHaveProperty('pauseReason');
});

it('never presents failed or cancelled work as a resumable manual step', () => {
  for (const status of ['failed', 'needs-inspection', 'cancelled'] as const)
    expect(runPauseReason({ ...legacy, status, manualGate: 'app_setup' })?.kind).toBe('inspection');
  const enriched = withRunPauseReason({ ...legacy, manualGate: 'app_setup' });
  expect(withRunPauseReason({ ...enriched, status: 'completed' })).not.toHaveProperty('pauseReason');
  expect(withRunPauseReason({ ...enriched, status: 'running' })).not.toHaveProperty('pauseReason');
});
