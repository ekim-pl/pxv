import { digest, validateInventory, type SelectedTarget } from '@pxv/contracts';
import { randomUUID } from 'node:crypto';
import { atomicWritePrivate, type DeviceLease, type Store } from '@pxv/runtime';
import type { ProjectContext } from './project.js';
import { assertProjectFresh, containedPath } from './project.js';
import { NativeDeviceOwnership, NativeProjectOwnership } from './ownership.js';
import { SeedvaultConnectionSession, seedvaultConnections } from './seedvault-sessions.js';

interface ConnectionOptions {
  lease: DeviceLease;
  signal?: AbortSignal;
}
export interface SeedvaultConnectionPort {
  pair(endpoint: string, code: string, options: ConnectionOptions): Promise<void>;
  connect(target: SelectedTarget, endpoint: string, options: ConnectionOptions): Promise<void>;
  disconnect(endpoint: string, options: ConnectionOptions): Promise<void>;
}
export interface SeedvaultConnectionRequest {
  endpoint: string;
  pairEndpoint?: string;
  pairingCode?: string;
  disconnect?: boolean;
  recoverOperationId?: string;
}

/** Register only the endpoint whose authenticated connection measures as the enrolled phone. */
export async function connectSeedvaultEndpoint(
  project: ProjectContext,
  target: SelectedTarget,
  request: SeedvaultConnectionRequest,
  port: SeedvaultConnectionPort,
  controlRoot: string,
  store: Store,
  signal?: AbortSignal,
): Promise<{ connected: boolean; endpoint: string }> {
  if (project.product.features?.seedvault === false && !request.disconnect)
    throw new Error('Seedvault is an optional experimental recovery module; new connections are disabled');
  if (target.device.kind !== 'pixel') throw new Error('Wireless Seedvault requires an enrolled Pixel');
  // Reuse the normal enrollment guard without inspecting Android or starting ADB.
  const enrolled = project.inventory.devices.find((device) => device.assetId === target.device.assetId);
  if (!enrolled || digest(enrolled) !== digest(target.device))
    throw new Error('Wireless target differs from inventory');
  const transport = { kind: 'wifi' as const, serial: request.endpoint };
  const device = {
    ...enrolled,
    transports: [...enrolled.transports.filter((value) => value.kind !== 'wifi'), transport],
  };
  const inventory = validateInventory({
    ...project.inventory,
    devices: project.inventory.devices.map((value) => (value.assetId === device.assetId ? device : value)),
  });
  const selected = { device, transport };
  return new NativeProjectOwnership(project, controlRoot).run(async () => {
    await assertDisconnect(store, target, request);
    if (request.pairEndpoint && !request.pairingCode) throw new Error('Pairing code is required privately');
    const session = await SeedvaultConnectionSession.begin(store, target, request);
    const ownership = new NativeDeviceOwnership(controlRoot);
    const reservation = request.recoverOperationId
      ? await connectionReservation(ownership, selected, session)
      : undefined;
    const execute = reservation ? ownership.recover.bind(ownership) : ownership.run.bind(ownership);
    const operationId =
      reservation ?? (request.recoverOperationId ? `seedvault-cleanup-${randomUUID()}` : session.operationId);
    const result = await execute(selected, operationId, async (lease) => {
      if (request.recoverOperationId) await session.recovering(lease.operationId);
      const options = { lease, ...(signal ? { signal } : {}) };
      if (request.disconnect) await port.disconnect(request.endpoint, options);
      else {
        if (request.pairEndpoint && request.pairingCode)
          await port.pair(request.pairEndpoint, request.pairingCode, options);
        await port.connect(selected, request.endpoint, options);
        await assertProjectFresh(project);
        await atomicWritePrivate(
          await containedPath(project.root, project.config.inventoryFile),
          JSON.stringify(inventory, null, 2),
        );
      }
      return { connected: !request.disconnect, endpoint: request.endpoint };
    });
    // A successful callback alone does not prove native release completed.
    await session.complete(Boolean(request.disconnect));
    return result;
  });
}
async function connectionReservation(
  ownership: NativeDeviceOwnership,
  target: SelectedTarget,
  session: SeedvaultConnectionSession,
): Promise<string | undefined> {
  const keys = ownership.keys(target);
  const known = new Set<string | null | undefined>(
    [session.operationId, session.recoveryOperationId].filter((value) => value !== undefined),
  );
  const reservation = (await ownership.reservations(target.device)).find(
    (value) =>
      value.device_key === keys.device &&
      value.transport_key === keys.transport &&
      (known.has(value.operation_id) || known.has(value.previous_operation_id)),
  );
  return reservation?.operation_id;
}
async function assertDisconnect(
  store: Store,
  target: SelectedTarget,
  request: SeedvaultConnectionRequest,
): Promise<void> {
  if (!request.disconnect) return;
  const enrolled = target.device.transports.some(
    (value) => value.kind === 'wifi' && value.serial === request.endpoint,
  );
  const recorded = (await seedvaultConnections(store, target)).some(
    (value) => value.endpoint === request.endpoint,
  );
  if (!enrolled && !recorded) throw new Error('Wireless endpoint is not enrolled or recorded for cleanup');
}
