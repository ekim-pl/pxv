import { toPolicyDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi, type Mock } from './../test-api.js';
import {
  connectSeedvaultEndpoint,
  createProject,
  loadProject,
  saveInventory,
  seedvaultConnections,
  writePolicyLock,
  type ProjectContext,
  type SeedvaultConnectionPort,
} from '@pxv/engine';
import { CommandRunner, DeviceLease, SqliteStore } from '@pxv/runtime';
import { SeedvaultConnectionSession } from '../../packages/engine/src/seedvault-sessions.js';
import { NativeDeviceOwnership } from '../../packages/engine/src/ownership.js';
import { device, product } from '../contracts/fixtures.js';
import { basePolicy } from './fixtures.js';

let root: string;
let project: ProjectContext;
let store: SqliteStore;
let port: SeedvaultConnectionPort;
let connected: Mock<SeedvaultConnectionPort['connect']>;
let disconnected: Mock<SeedvaultConnectionPort['disconnect']>;
const endpoint = '192.0.2.10:39111';
beforeEach(async () => {
  root = await mkdtemp('/tmp/pxv-seedvault-connection-');
  vi.stubEnv('PXV_CONTROL_ROOT', join(root, 'control'));
  const code = join(root, 'code');
  await mkdir(join(code, 'packages/core'), { recursive: true });
  await writeFile(join(code, 'packages/core/index.js'), 'export const version=1;');
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()), code);
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  project = await loadProject(created.root, product, code);
  await writePolicyLock(project);
  store = await SqliteStore.open(join(root, 'connections.sqlite3'));
  connected = vi.fn().mockResolvedValue(undefined);
  disconnected = vi.fn().mockResolvedValue(undefined);
  port = {
    pair: vi.fn().mockResolvedValue(undefined),
    connect: connected,
    disconnect: disconnected,
  };
});
afterEach(async () => {
  await store.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const target = () => ({ device, transport: device.transports[0]! });
for (const fault of ['missing', 'corrupt', 'stale', 'replaced'])
  it(`rejects ${fault} approval before connection records or pairing, while disconnect remains available`, async () => {
    const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
    const path = join(project.root, 'policy.lock.json');
    if (fault === 'missing') await rm(path);
    else if (fault === 'corrupt') await writeFile(path, '{invalid');
    else {
      const value = JSON.parse(await readFile(path, 'utf8')) as { digest: string };
      if (fault === 'stale')
        await writeFile(join(project.codeRoot!, 'packages/core/index.js'), 'export const version=2;');
      else await writeFile(path, JSON.stringify({ ...value, digest: 'c'.repeat(64) }));
      if (fault === 'stale') project = await loadProject(project.root, product, project.codeRoot);
    }
    const pair = vi.fn<SeedvaultConnectionPort['pair']>().mockResolvedValue(undefined);
    port.pair = pair;
    await expect(
      connectSeedvaultEndpoint(
        project,
        target(),
        { endpoint, pairEndpoint: '192.0.2.10:39112', pairingCode: '123456' },
        port,
        join(root, 'control'),
        store,
      ),
    ).rejects.toThrow('explicitly renew policy lock');
    expect(pair).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(await seedvaultConnections(store, target())).toHaveLength(1);
    await connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    );
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
async function retainedHistory(session: SeedvaultConnectionSession, count: number, matching = [count - 1]) {
  const record = await store.get<Record<string, unknown>>('seedvault-connections', session.operationId);
  const changes = Array.from({ length: count }, (_, i) => ({
    kind: 'set' as const,
    collection: 'seedvault-connections',
    key: `history-${String(i).padStart(5, '0')}`,
    value: {
      ...record,
      operationId: `history-${String(i).padStart(5, '0')}`,
      endpoint: matching.includes(i) ? endpoint : '192.0.2.11:39111',
    },
  }));
  for (let offset = 0; offset < changes.length; offset += 200)
    await store.transition({ expected: [], changes: changes.slice(offset, offset + 200), events: [] });
}
it('measures the new endpoint under native ownership before atomically enrolling it', async () => {
  port.connect = vi.fn().mockImplementation((selected, _endpoint, options) => {
    expect(selected).toMatchObject({
      device: { canonicalSerial: 'PIXEL1' },
      transport: { kind: 'wifi', serial: endpoint },
    });
    expect((options as { lease: unknown }).lease).toBeInstanceOf(DeviceLease);
    return Promise.resolve();
  });
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, pairEndpoint: '192.0.2.10:39112', pairingCode: '123456' },
      port,
      join(root, 'control'),
      store,
    ),
  ).resolves.toEqual({ connected: true, endpoint });
  const loaded = await loadProject(project.root, product, project.codeRoot);
  expect(loaded.config.id).toBe(project.config.id);
  expect(loaded.inventory.devices[0]?.transports).toEqual([
    { kind: 'usb', serial: 'PIXEL1' },
    { kind: 'wifi', serial: endpoint },
  ]);
  expect(await readFile(join(project.root, 'inventory.json'), 'utf8')).not.toContain('123456');
  expect(await seedvaultConnections(store, target())).toMatchObject([
    { status: 'connected', cleanupRequired: true, pairingRequested: true },
  ]);
  expect(JSON.stringify(await store.entries('seedvault-connections'))).not.toContain('123456');
  await expect(
    connectSeedvaultEndpoint(
      loaded,
      { device: loaded.inventory.devices[0]!, transport: loaded.inventory.devices[0]!.transports[0]! },
      { endpoint, disconnect: true },
      port,
      join(root, 'control'),
      store,
    ),
  ).resolves.toEqual({ connected: false, endpoint });
  expect(disconnected).toHaveBeenCalled();
  const sessions = await seedvaultConnections(store, target());
  expect(sessions).toHaveLength(2);
  expect(sessions.every((value) => value.status === 'disconnected' && !value.cleanupRequired)).toBe(true);
  expect(await store.events(sessions.find((value) => value.pairingRequested)!.operationId)).toHaveLength(3);
});
it('recovers a failed new endpoint using only its durable operation, without enrolling an unverified phone', async () => {
  const signal = new AbortController().signal;
  port.connect = vi.fn().mockImplementation(async (_target, _endpoint, options: { lease: DeviceLease }) => {
    expect(await seedvaultConnections(store, target())).toMatchObject([
      { status: 'connecting', cleanupRequired: true },
    ]);
    await new CommandRunner().run(['/bin/sh', '-c', 'exit 7'], { mutation: true, lease: options.lease });
  });
  await expect(
    connectSeedvaultEndpoint(project, target(), { endpoint }, port, join(root, 'control'), store, signal),
  ).rejects.toThrow();
  const session = (await seedvaultConnections(store, target()))[0]!;
  expect(project.inventory.devices[0]?.transports).not.toContainEqual({ kind: 'wifi', serial: endpoint });
  await expect(
    connectSeedvaultEndpoint(project, target(), { endpoint }, port, join(root, 'control'), store),
  ).rejects.toThrow();
  disconnected.mockImplementationOnce(async (_endpoint, options) => {
    await new CommandRunner().run(['/bin/sh', '-c', 'exit 8'], { mutation: true, lease: options.lease });
  });
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow();
  expect(
    (await seedvaultConnections(store, target())).find((value) => value.operationId === session.operationId),
  ).toMatchObject({ cleanupRequired: true, status: 'disconnecting' });
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    ),
  ).resolves.toEqual({ connected: false, endpoint });
  expect(
    (await seedvaultConnections(store, target())).find((value) => value.operationId === session.operationId),
  ).toMatchObject({ cleanupRequired: false, status: 'disconnected' });
  expect(disconnected).toHaveBeenCalledTimes(2);
});
it('cleans a connection that failed before mutation', async () => {
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    ),
  ).resolves.toEqual({ connected: false, endpoint });
  expect(await seedvaultConnections(store, target())).toHaveLength(1);
});
for (const count of [999, 1000, 1001])
  it(`reconciles connection history across ${count} records without touching unrelated sessions`, async () => {
    const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint, disconnect: true });
    await retainedHistory(session, count);
    expect(await seedvaultConnections(store, target())).toHaveLength(count + 1);
    await session.complete(true);
    expect(
      await store.get('seedvault-connections', `history-${String(count - 1).padStart(5, '0')}`),
    ).toMatchObject({ status: 'disconnected', cleanupRequired: false });
    expect(await store.get('seedvault-connections', 'history-00000')).toMatchObject({
      cleanupRequired: true,
    });
    expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
      status: 'disconnected',
      cleanupRequired: false,
    });
  });

it('retains partial cleanup and retries safely after a later history-page failure', async () => {
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint, disconnect: true });
  await retainedHistory(session, 1001, [0, 1000]);
  const pages = store.entriesPage.bind(store);
  const spy = vi
    .spyOn(store, 'entriesPage')
    .mockImplementation((collection, options) =>
      options?.cursor ? Promise.reject(new Error('Later page unavailable')) : pages(collection, options),
    );
  await expect(session.complete(true)).rejects.toThrow('Later page unavailable');
  expect(await store.get('seedvault-connections', 'history-00000')).toMatchObject({ cleanupRequired: false });
  expect(await store.get('seedvault-connections', 'history-01000')).toMatchObject({ cleanupRequired: true });
  expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
    cleanupRequired: true,
  });
  spy.mockRestore();
  await session.complete(true);
  expect(await store.get('seedvault-connections', 'history-01000')).toMatchObject({ cleanupRequired: false });
  expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
    cleanupRequired: false,
  });
  expect(await store.events('history-00000')).toHaveLength(1);
});

it('rolls back reconciled records when their audit insertion fails', async () => {
  const prior = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint, disconnect: true });
  const database = new DatabaseSync(join(root, 'connections.sqlite3'));
  try {
    database.exec(
      "CREATE TRIGGER cleanup_fault BEFORE INSERT ON events WHEN json_extract(NEW.value,'$.status')='disconnected' BEGIN SELECT RAISE(ABORT,'connection-audit-fault'); END",
    );
    await expect(session.complete(true)).rejects.toThrow('connection-audit-fault');
    for (const id of [prior.operationId, session.operationId])
      expect(await store.get('seedvault-connections', id)).toMatchObject({ cleanupRequired: true });
    expect(await store.events(prior.operationId)).toHaveLength(1);
    database.exec('DROP TRIGGER cleanup_fault');
    await session.complete(true);
    expect((await seedvaultConnections(store, target())).every((value) => !value.cleanupRequired)).toBe(true);
  } finally {
    database.close();
  }
});

for (const failure of ['page', 'audit', 'conflict'])
  it(`retains initiating cleanup after ${failure} reconciliation failure and supports explicit retry`, async () => {
    const prior = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
    const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint, disconnect: true });
    const transition = store.transition.bind(store);
    if (failure === 'page')
      vi.spyOn(store, 'entriesPage').mockRejectedValueOnce(new Error('Later page unavailable'));
    else
      vi.spyOn(store, 'transition').mockImplementationOnce((input) => {
        expect(input.events[0]?.runId).toBe(prior.operationId);
        return failure === 'audit' ? Promise.reject(new Error('Audit unavailable')) : Promise.resolve(false);
      });
    await expect(session.complete(true)).rejects.toThrow();
    expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
      cleanupRequired: true,
    });
    expect(await store.get('seedvault-connections', prior.operationId)).toMatchObject({
      cleanupRequired: true,
    });
    if (failure !== 'page') vi.spyOn(store, 'transition').mockImplementation(transition);
    await session.complete(true);
    expect((await seedvaultConnections(store, target())).every((value) => !value.cleanupRequired)).toBe(true);
  });

it('authorizes exact recovery directly before traversing cleanup history', async () => {
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  vi.spyOn(store, 'entriesPage').mockRejectedValueOnce(new Error('History unavailable'));
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('History unavailable');
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
    cleanupRequired: true,
  });
  await connectSeedvaultEndpoint(
    project,
    target(),
    { endpoint, disconnect: true, recoverOperationId: session.operationId },
    port,
    join(root, 'control'),
    store,
  );
  expect(await store.get('seedvault-connections', session.operationId)).toMatchObject({
    cleanupRequired: false,
  });
});
it('blocks new connections under older shutdown intent while allowing exact disconnect recovery', async () => {
  const pair = vi.fn<SeedvaultConnectionPort['pair']>().mockResolvedValue(undefined);
  port.pair = pair;
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  const intent = { policyDigest: 'original', pending: ['debugging-shutdown'] };
  await store.set('workflow', device.assetId, intent);
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, pairEndpoint: '192.0.2.10:39112', pairingCode: '123456' },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('finalization-inspection');
  expect(pair).not.toHaveBeenCalled();
  expect(connected).not.toHaveBeenCalled();
  await connectSeedvaultEndpoint(
    project,
    target(),
    { endpoint, disconnect: true, recoverOperationId: session.operationId },
    port,
    join(root, 'control'),
    store,
  );
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(await store.get('workflow', device.assetId)).toEqual(intent);
});
it('does not inherit another operation reservation on the same physical phone and endpoint', async () => {
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  const selected = { ...target(), transport: { kind: 'wifi' as const, serial: endpoint } };
  await expect(
    new NativeDeviceOwnership(join(root, 'control')).run(selected, 'foreign-operation', async (lease) => {
      await new CommandRunner().run(['/bin/sh', '-c', 'exit 9'], { mutation: true, lease });
    }),
  ).rejects.toThrow();
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true, recoverOperationId: session.operationId },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow();
  expect(disconnected).not.toHaveBeenCalled();
});
it('rejects mismatched recovery records and preserves session state on concurrent writes', async () => {
  const session = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  for (const input of [
    { endpoint, disconnect: true, recoverOperationId: 'unknown' },
    { endpoint, recoverOperationId: session.operationId },
    { endpoint: 'other:4321', disconnect: true, recoverOperationId: session.operationId },
  ])
    await expect(SeedvaultConnectionSession.begin(store, target(), input)).rejects.toThrow('exact recorded');
  const differentAsset = { ...target(), device: { ...device, assetId: 'different' } };
  await expect(
    SeedvaultConnectionSession.begin(store, differentAsset, {
      endpoint,
      disconnect: true,
      recoverOperationId: session.operationId,
    }),
  ).rejects.toThrow('exact recorded');
  const differentSerial = { ...target(), device: { ...device, canonicalSerial: 'different' } };
  await expect(
    SeedvaultConnectionSession.begin(store, differentSerial, {
      endpoint,
      disconnect: true,
      recoverOperationId: session.operationId,
    }),
  ).rejects.toThrow('exact recorded');
  expect(await seedvaultConnections(store, differentAsset)).toEqual([]);
  expect(await seedvaultConnections(store, differentSerial)).toEqual([]);
  await session.complete(true);
  await expect(
    SeedvaultConnectionSession.begin(store, target(), {
      endpoint,
      disconnect: true,
      recoverOperationId: session.operationId,
    }),
  ).rejects.toThrow('exact recorded');
  vi.spyOn(store, 'transition').mockResolvedValueOnce(false);
  await expect(SeedvaultConnectionSession.begin(store, target(), { endpoint })).rejects.toThrow(
    'session changed',
  );
});
it('disconnects only the chosen recorded endpoint and retains other session cleanup work', async () => {
  await SeedvaultConnectionSession.begin(store, target(), { endpoint: 'other:4321' });
  const first = await SeedvaultConnectionSession.begin(store, target(), { endpoint });
  await first.complete(false);
  await SeedvaultConnectionSession.begin(
    store,
    { ...target(), device: { ...device, canonicalSerial: 'other' } },
    { endpoint },
  );
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true },
      port,
      join(root, 'control'),
      store,
    ),
  ).resolves.toEqual({ connected: false, endpoint });
  expect(
    (await seedvaultConnections(store, target())).find((value) => value.endpoint === 'other:4321'),
  ).toMatchObject({ cleanupRequired: true });
  expect(disconnected.mock.calls).toHaveLength(1);
  expect(disconnected.mock.calls[0]?.[0]).toBe(endpoint);
});
it('rejects unexpected identities, unpaired requests and unknown disconnect endpoints', async () => {
  await expect(
    connectSeedvaultEndpoint(
      project,
      { ...target(), device: { ...device, kind: 'emulator' } },
      { endpoint },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('Pixel');
  await expect(
    connectSeedvaultEndpoint(
      project,
      { ...target(), device: { ...device, model: 'changed' } },
      { endpoint },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('inventory');
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, pairEndpoint: 'pair:1' },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('Pairing code');
  await expect(
    connectSeedvaultEndpoint(
      project,
      target(),
      { endpoint, disconnect: true },
      port,
      join(root, 'control'),
      store,
    ),
  ).rejects.toThrow('not enrolled');
  expect(connected).not.toHaveBeenCalled();
});
it('never enrolls a mismatched phone or overwrites configuration changed during connection', async () => {
  port.connect = vi.fn().mockRejectedValueOnce(new Error('wrong physical phone'));
  const before = await readFile(join(project.root, 'inventory.json'), 'utf8');
  await expect(
    connectSeedvaultEndpoint(project, target(), { endpoint }, port, join(root, 'control'), store),
  ).rejects.toThrow('wrong physical phone');
  expect(await readFile(join(project.root, 'inventory.json'), 'utf8')).toBe(before);
  port.connect = vi.fn().mockImplementation(async () => {
    await writeFile(join(project.root, 'policy.json'), '{}');
  });
  await expect(
    connectSeedvaultEndpoint(project, target(), { endpoint }, port, join(root, 'control'), store),
  ).rejects.toThrow('Project source changed');
  expect(await readFile(join(project.root, 'inventory.json'), 'utf8')).toBe(before);
});
