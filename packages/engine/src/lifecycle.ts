import { randomUUID } from 'node:crypto';
import { hostControlRoot, type Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { NativeDeviceOwnership, NativeProjectOwnership, type DeviceOwnership } from './ownership.js';
import { planGeneration } from './plan-generation.js';
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
type LifecycleInput = Omit<LifecycleRecord, 'schemaVersion' | 'id' | 'at'>;
function validateInput(project: ProjectContext, input: LifecycleInput) {
  const device = project.inventory.devices.find((value) => value.assetId === input.assetId);
  if (!device) throw new Error('Unknown enrolled asset');
  if (!['maintenance', 'policy-change', 'loss', 'retirement'].includes(input.type))
    throw new Error('Unknown lifecycle event');
  if (!input.operator.trim() || input.note.length > 1000 || !input.note.trim())
    throw new Error('Operator and bounded non-secret note required');
  if (input.type === 'retirement' && !input.confirmedErasure)
    throw new Error('Retirement requires confirmed on-device erasure and custody review');
  return device;
}
async function commitLifecycle(store: Store, record: LifecycleRecord): Promise<void> {
  const keys = ['workflow', 'handoff', 'attestations'];
  const generation = await planGeneration(store, record.assetId);
  const values = await Promise.all(keys.map((collection) => store.get<unknown>(collection, record.assetId)));
  const expected = keys.map((collection, index) => ({
    collection,
    key: record.assetId,
    value: values[index],
  }));
  const archive = {
    record,
    workflow: values[0] ?? null,
    handoff: values[1] ?? null,
    attestations: values[2] ?? [],
  };
  const committed = await store.transition({
    expected: [...expected, { collection: 'plan-generations', key: record.assetId, value: generation }],
    changes: [
      { kind: 'set', collection: 'lifecycle-evidence', key: record.id, value: archive },
      ...keys.map((collection) => ({ kind: 'delete' as const, collection, key: record.assetId })),
      { kind: 'set', collection: 'lifecycle', key: record.id, value: record },
      { kind: 'set', collection: 'plan-generations', key: record.assetId, value: record.id },
    ],
    events: [{ runId: `asset:${record.assetId}`, value: record }],
  });
  if (!committed) throw new Error('Asset evidence changed; reload before recording lifecycle');
}
async function recordLifecycleOwned(
  project: ProjectContext,
  store: Store,
  input: LifecycleInput,
  clock: () => Date,
  ownership: DeviceOwnership,
): Promise<LifecycleRecord> {
  const device = validateInput(project, input);
  const transport = device.transports.find((value) => value.kind === 'usb') ?? device.transports[0];
  if (!transport) throw new Error('Enrolled asset has no transport');
  return ownership.run({ device, transport }, `lifecycle-${randomUUID()}`, async () => {
    const record: LifecycleRecord = {
      ...input,
      schemaVersion: 1,
      id: randomUUID(),
      at: clock().toISOString(),
    };
    await commitLifecycle(store, record);
    return record;
  });
}
export function recordLifecycle(
  project: ProjectContext,
  store: Store,
  input: LifecycleInput,
  clock: () => Date = () => new Date(),
  controlRoot = hostControlRoot(),
): Promise<LifecycleRecord> {
  return new NativeProjectOwnership(project, controlRoot).run(() =>
    recordLifecycleOwned(project, store, input, clock, new NativeDeviceOwnership(controlRoot)),
  );
}
