import { randomUUID } from 'node:crypto';
import type { SelectedTarget } from '@pxv/contracts';
import type { Store } from '@pxv/runtime';

interface ConnectionSession {
  schemaVersion: 1;
  operationId: string;
  assetId: string;
  deviceSerial: string;
  endpoint: string;
  pairingRequested: boolean;
  recoveryOperationId?: string;
  status: 'connecting' | 'connected' | 'disconnecting' | 'disconnected';
  cleanupRequired: boolean;
  at: string;
}
const collection = 'seedvault-connections';
async function sessions(store: Store): Promise<ConnectionSession[]> {
  const rows = await store.entries<ConnectionSession>(collection, 1000);
  if (rows.length === 1000)
    throw new Error('Connection history reached its inspection limit; retain and reconcile it');
  return rows.map(({ value }) => value);
}

export async function seedvaultConnections(
  store: Store,
  target: SelectedTarget,
): Promise<ConnectionSession[]> {
  return (await sessions(store)).filter(
    (value) =>
      value.assetId === target.device.assetId && value.deviceSerial === target.device.canonicalSerial,
  );
}

/** Host socket obligations stay visible; paired-host trust must be removed privately on the phone. */
export class SeedvaultConnectionSession {
  private constructor(
    readonly store: Store,
    private value: ConnectionSession,
  ) {}

  static async begin(
    store: Store,
    target: SelectedTarget,
    request: { endpoint: string; pairEndpoint?: string; disconnect?: boolean; recoverOperationId?: string },
  ): Promise<SeedvaultConnectionSession> {
    if (request.recoverOperationId) {
      const previous = await store.get<ConnectionSession>(collection, request.recoverOperationId);
      if (
        !previous ||
        !request.disconnect ||
        !previous.cleanupRequired ||
        previous.assetId !== target.device.assetId ||
        previous.deviceSerial !== target.device.canonicalSerial ||
        previous.endpoint !== request.endpoint
      )
        throw new Error('Connection recovery must disconnect its exact recorded session');
      return new SeedvaultConnectionSession(store, previous);
    }
    const session = new SeedvaultConnectionSession(store, {
      schemaVersion: 1,
      operationId: `seedvault-connect-${randomUUID()}`,
      assetId: target.device.assetId,
      deviceSerial: target.device.canonicalSerial,
      endpoint: request.endpoint,
      pairingRequested: Boolean(request.pairEndpoint),
      status: request.disconnect ? 'disconnecting' : 'connecting',
      cleanupRequired: true,
      at: new Date().toISOString(),
    });
    await session.save(undefined, session.value);
    return session;
  }

  get operationId(): string {
    return this.value.operationId;
  }
  get recoveryOperationId(): string | undefined {
    return this.value.recoveryOperationId;
  }
  async recovering(operationId: string): Promise<void> {
    const next: ConnectionSession = {
      ...this.value,
      status: 'disconnecting',
      recoveryOperationId: operationId,
    };
    await this.save(this.value, next);
    this.value = next;
  }

  async complete(disconnected: boolean): Promise<void> {
    const next: ConnectionSession = {
      ...this.value,
      at: new Date().toISOString(),
      status: disconnected ? 'disconnected' : 'connected',
      cleanupRequired: !disconnected,
    };
    await this.save(this.value, next);
    this.value = next;
    if (disconnected) await this.resolvePrevious();
  }

  private async resolvePrevious(): Promise<void> {
    for (const previous of await sessions(this.store)) {
      if (
        previous.operationId === this.operationId ||
        !previous.cleanupRequired ||
        previous.deviceSerial !== this.value.deviceSerial ||
        previous.endpoint !== this.value.endpoint
      )
        continue;
      await this.save(previous, {
        ...previous,
        status: 'disconnected',
        cleanupRequired: false,
        at: this.value.at,
      });
    }
  }

  private async save(previous: ConnectionSession | undefined, next: ConnectionSession): Promise<void> {
    const committed = await this.store.transition({
      expected: [{ collection, key: next.operationId, value: previous }],
      changes: [{ kind: 'set', collection, key: next.operationId, value: next }],
      events: [{ runId: next.operationId, value: { type: 'seedvault-connection', ...next } }],
    });
    if (!committed) throw new Error('Wireless session changed; inspect its durable connection record');
  }
}
