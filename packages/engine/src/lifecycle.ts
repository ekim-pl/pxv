import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '@pxv/runtime';
import type { ProjectContext } from './project.js';

export interface LifecycleRecord {
  schemaVersion: 1;
  id: string;
  assetId: string;
  type: 'maintenance' | 'policy-change' | 'loss' | 'retirement';
  operator: string;
  note: string;
  at: string;
  confirmedErasure: boolean;
}

export async function recordLifecycle(
  project: ProjectContext,
  store: SqliteStore,
  input: Omit<LifecycleRecord, 'schemaVersion' | 'id' | 'at'>,
  clock: () => Date = () => new Date(),
): Promise<LifecycleRecord> {
  if (!project.inventory.devices.some((value) => value.assetId === input.assetId))
    throw new Error('Unknown enrolled asset');
  if (!['maintenance', 'policy-change', 'loss', 'retirement'].includes(input.type))
    throw new Error('Unknown lifecycle event');
  if (!input.operator.trim() || input.note.length > 1000 || !input.note.trim())
    throw new Error('Operator and bounded non-secret note required');
  if (input.type === 'retirement' && !input.confirmedErasure)
    throw new Error('Retirement requires confirmed on-device erasure and custody review');
  const record: LifecycleRecord = { ...input, schemaVersion: 1, id: randomUUID(), at: clock().toISOString() };
  // Begin a fresh maintenance generation; old receipts remain inspectable, not reusable.
  await store.set('lifecycle-evidence', record.id, {
    record,
    workflow: (await store.get('workflow', input.assetId)) ?? null,
    handoff: (await store.get('handoff', input.assetId)) ?? null,
    attestations: (await store.get('attestations', input.assetId)) ?? [],
  });
  await store.delete('workflow', input.assetId);
  await store.delete('handoff', input.assetId);
  await store.delete('attestations', input.assetId);
  await store.set('lifecycle', record.id, record);
  await store.appendEvent(`asset:${input.assetId}`, record);
  return record;
}
