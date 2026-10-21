import { canonicalJson, resolvePolicy } from '@pxv/contracts';
import type { PreparedOperation, Operation } from '@pxv/engine';
import { preparedDigest, summaryData } from '../../packages/engine/src/reviewed-plan.js';
import { device, observation, product, project } from '../contracts/fixtures.js';
import { basePolicy } from './fixtures.js';

export const custodyBaseline = resolvePolicy(basePolicy(), project, product);
export function sealPrepared(
  draft: Omit<PreparedOperation, 'reviewSummary'>,
  extensions: unknown = custodyBaseline.project.extensions,
): PreparedOperation {
  const plan = { ...draft.plan, digest: preparedDigest(draft, extensions) };
  return { ...draft, plan, reviewSummary: canonicalJson({ ...summaryData(draft), planDigest: plan.digest }) };
}
export function preparedFixture(operation: Operation = 'provision'): PreparedOperation {
  return sealPrepared({
    schemaVersion: 1,
    operation,
    plan: {
      schemaVersion: 1,
      id: 'plan',
      projectId: project.id,
      device,
      digest: '0'.repeat(64),
      policyDigest: custodyBaseline.digest,
      actions: [],
      createdAt: '2026-10-20T10:00:00.000Z',
    },
    target: { device, transport: device.transports[0]! },
    baseline: observation,
    sharedEffects: [],
    expiresAt: '2026-10-20T10:15:00.000Z',
  });
}

export function alteredPrepared(value: PreparedOperation): Record<string, unknown> {
  return {
    actions: {
      ...value,
      plan: {
        ...value.plan,
        actions: value.plan.actions.map(() => ({
          kind: 'manual',
          capability: 'operator_signoff',
          instructions: 'Changed',
        })),
      },
    },
    baseline: { ...value, baseline: { ...value.baseline, os: { ...value.baseline.os, release: 'changed' } } },
    transport: { ...value, target: { ...value.target, transport: device.transports[1] } },
    target: { ...value, target: { ...value.target, device: { ...device, model: 'Changed' } } },
    operation: { ...value, operation: value.operation === 'extension' ? 'provision' : 'extension' },
    effects: { ...value, sharedEffects: [{ packageId: 'org.example.other', users: [] }] },
    expiry: { ...value, expiresAt: '2026-11-20T10:15:00.000Z' },
    lineage: {
      ...value,
      refreshedFrom: {
        runId: 'parent',
        planDigest: 'a'.repeat(64),
        completedActions: 0,
        completedSetup: [],
        capabilityEvidence: [],
      },
    },
    summary: { ...value, reviewSummary: value.reviewSummary + ' ' },
    incomplete: { plan: value.plan, target: value.target, operation: value.operation },
  };
}
