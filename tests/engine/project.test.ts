import { toPolicyDocument } from '@pxv/contracts';
import { recordObligation } from './obligations.js';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containedPath,
  engineIntegrity,
  createProject,
  loadProduct,
  loadProject,
  recordLifecycle,
  ResourceScope,
  saveInventory,
  writePolicyLock,
} from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, hashA, obligation, product } from '../contracts/fixtures.js';
import { basePolicy } from './fixtures.js';

describe('isolated project data', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-project-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('initializes explicit private state and loads from unrelated working directories', async () => {
    const context = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    expect(context.config.format).toBe('pxv-ts');
    expect(context.inventory.devices).toEqual([]);
    expect((await lstat(join(context.root, 'pxv.project.json'))).mode & 0o777).toBe(0o600);
    await saveInventory(context, { schemaVersion: 1, devices: [device] });
    const loaded = await loadProject(context.root, product);
    expect(loaded.inventory.devices).toEqual([device]);
    await writePolicyLock(loaded);
    expect(JSON.parse(await readFile(join(context.root, 'policy.lock.json'), 'utf8')) as unknown).toEqual(
      loaded.resolved,
    );
    const before = await readdir(context.root);
    await loadProject(context.root, product);
    expect(await readdir(context.root)).toEqual(before);
    expect(await loadProduct('product.json')).toEqual({
      ...product,
      features: { extensions: false, seedvault: false },
      defaultPolicy: 'policy-packs/reference-five/policy.json',
      assets: { logo: 'assets/logo.svg' },
      support: { name: 'pxv Community', email: 'support@example.org', url: 'https://example.org/pxv' },
    });
    await expect(createProject(context.root, product, toPolicyDocument(basePolicy()))).rejects.toThrow(
      'existing',
    );
    await expect(loadProject(context.root, { ...product, id: 'fork' })).rejects.toThrow('different product');
  });

  it('rejects stale inventory and policy-lock source revisions without overwriting external edits', async () => {
    const project = await createProject(root, product, toPolicyDocument(basePolicy()));
    const edited = { schemaVersion: 1, devices: [device] };
    await writeFile(join(root, project.config.inventoryFile), JSON.stringify(edited));
    await expect(saveInventory(project, { schemaVersion: 1, devices: [] })).rejects.toThrow('file changed');
    expect(JSON.parse(await readFile(join(root, project.config.inventoryFile), 'utf8'))).toEqual(edited);
    await expect(writePolicyLock(project)).rejects.toThrow('source changed');
    await expect(lstat(join(root, 'policy.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const latest = await loadProject(root, product);
    await writeFile(
      join(root, 'pxv.project.json'),
      JSON.stringify({ ...latest.config, id: 'externally-changed' }),
    );
    await expect(saveInventory(latest, { schemaVersion: 1, devices: [] })).rejects.toThrow('source changed');
    await expect(writePolicyLock(latest)).rejects.toThrow('source changed');
  });

  it('does not initialize, migrate or modify missing and legacy projects during reads', async () => {
    await expect(loadProject(root, product)).rejects.toThrow('marker missing');
    expect(await readdir(root)).toEqual([]);
    await mkdir(join(root, 'config'));
    const legacy = join(root, 'config/manifest.yaml');
    await writeFile(legacy, 'legacy-state-sentinel');
    await expect(loadProject(root, product)).rejects.toThrow('Python pxv');
    await expect(createProject(root, product, toPolicyDocument(basePolicy()))).rejects.toThrow(
      'Python state',
    );
    expect(await readFile(legacy, 'utf8')).toBe('legacy-state-sentinel');
  });

  it('rejects traversal, symlinks, malformed policy and duplicate-key project markers', async () => {
    const context = await createProject(root, product, toPolicyDocument(basePolicy()));
    for (const name of ['/tmp/outside', '../outside', '.', 'nested//file'])
      await expect(containedPath(root, name)).rejects.toThrow();
    await expect(containedPath(root, 'missing')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await containedPath(root, 'new/deep/file', false)).toBe(join(root, 'new/deep/file'));
    await symlink('/tmp', join(root, 'escape'));
    await expect(containedPath(root, 'escape/file', false)).rejects.toThrow('symlinks');
    await writeFile(join(root, context.config.policyFile), '{"unexpected":true}');
    await expect(loadProject(root, product)).rejects.toThrow();
    await writeFile(join(root, 'pxv.project.json'), '{"id":"a","id":"b"}');
    await expect(loadProject(root, product)).rejects.toThrow('Invalid configuration');
  });

  it('binds executable content and rejects symlinked build resources without reading private inputs', async () => {
    const code = join(root, 'code');
    await mkdir(code);
    await expect(engineIntegrity(code)).rejects.toThrow('unavailable');
    await mkdir(join(code, 'packages/core'), { recursive: true });
    await writeFile(join(code, 'packages/core/index.js'), 'export const version=1;');
    const first = await engineIntegrity(code);
    await mkdir(join(code, 'packages/core/node_modules'), { recursive: true });
    await writeFile(join(code, 'packages/core/node_modules/private.json'), '{"TOKEN":"sentinel"}');
    expect(await engineIntegrity(code)).toBe(first);
    await writeFile(join(code, 'packages/core/index.js'), 'export const version=2;');
    expect(await engineIntegrity(code)).not.toBe(first);
    await symlink('/tmp', join(code, 'assets'));
    await expect(engineIntegrity(code)).rejects.toThrow('symlinks');
    await rm(join(code, 'assets'));
    await mkdir(join(code, 'native'));
    await symlink('/bin/true', join(code, 'native/pxv-supervisor'));
    await expect(engineIntegrity(code)).rejects.toThrow('immutable regular');
  });

  it('binds the selected static supervisor bytes and ignores the unused GNU target without an override', async () => {
    const savedSupervisor = process.env['PXV_SUPERVISOR'];
    delete process.env['PXV_SUPERVISOR'];
    try {
      const code = join(root, 'code');
      const musl = join(code, 'native/supervisor/target/x86_64-unknown-linux-musl/release/pxv-supervisor');
      const gnu = join(code, 'native/supervisor/target/release/pxv-supervisor');
      await mkdir(join(code, 'packages/core'), { recursive: true });
      await writeFile(join(code, 'packages/core/index.js'), 'export const version=1;');
      await mkdir(join(code, 'native/supervisor/target/x86_64-unknown-linux-musl/release'), {
        recursive: true,
      });
      await mkdir(join(code, 'native/supervisor/target/release'), { recursive: true });
      await writeFile(musl, 'static-supervisor-v1');
      await writeFile(gnu, 'unused-gnu-v1');
      const first = await engineIntegrity(code);
      await writeFile(gnu, 'unused-gnu-v2');
      expect(await engineIntegrity(code)).toBe(first);
      await writeFile(musl, 'static-supervisor-v2');
      expect(await engineIntegrity(code)).not.toBe(first);
    } finally {
      if (savedSupervisor === undefined) delete process.env['PXV_SUPERVISOR'];
      else process.env['PXV_SUPERVISOR'] = savedSupervisor;
    }
  });
});

describe('durable resource ownership and local lifecycle', () => {
  let root = '';
  let store: SqliteStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-resources-'));
    store = await SqliteStore.open(join(root, 'state.sqlite'));
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('does not release a parent keep-awake resource when its child probe finishes (regression 3)', async () => {
    const parent = new ResourceScope(store, 'PIXEL1', 'parent');
    const child = parent.child('network-probe');
    await recordObligation(parent, 'setting', 'keep-awake', { original: '0' });
    await recordObligation(child, 'helper', 'network-probe', {});
    const released: string[] = [];
    await child.cleanup(
      (user) => Promise.resolve(user),
      (resource) => {
        released.push(resource.resource);
        return Promise.resolve();
      },
    );
    expect(released).toEqual(['network-probe']);
    expect((await parent.list()).find((value) => value.resource === 'keep-awake')?.status).toBe('pending');
    await parent.cleanup(
      (user) => Promise.resolve(user),
      (resource) => {
        released.push(resource.resource);
        return Promise.resolve();
      },
    );
    expect(released).toEqual(['network-probe', 'keep-awake']);
  });

  it('retains blocked cleanup when an Android user ID/name was reused (regression 1)', async () => {
    const scope = new ResourceScope(store, 'PIXEL1', 'run');
    await recordObligation(scope, 'helper', 'probe', {}, { userId: 10, serialNo: 17, name: 'Work' });
    const released: string[] = [];
    await expect(
      scope.cleanup(
        (user) => Promise.resolve({ ...user, serialNo: 18 }),
        (resource) => {
          released.push(resource.id);
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow('identity changed');
    expect(released).toEqual([]);
    expect((await scope.list())[0]?.status).toBe('blocked');
    await scope.cleanup(
      (user) => Promise.resolve(user),
      () => Promise.resolve(),
    );
    expect((await scope.list())[0]?.status).toBe('resolved');
  });

  it('does not lose obligations under concurrent registration or cleanup writes', async () => {
    const scope = new ResourceScope(store, 'PIXEL1', 'run');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => recordObligation(scope, 'helper', `helper-${index}`, {})),
    );
    expect(await scope.list()).toHaveLength(8);
    await scope.cleanup(
      (user) => Promise.resolve(user),
      () => Promise.resolve(),
    );
    expect((await scope.list()).every((value) => value.status === 'resolved')).toBe(true);
  });

  it('preserves malformed records and refuses cross-device and duplicate obligation identities', async () => {
    const scope = new ResourceScope(store, 'PIXEL1', 'run');
    for (const value of [
      { invalid: 'sentinel' },
      [{ ...obligation, unknown: true }],
      [{ ...obligation, deviceSerial: 'OTHER' }],
      [obligation, obligation],
    ]) {
      await store.set('obligations', 'PIXEL1', value);
      await expect(scope.list()).rejects.toThrow();
      expect(await store.get('obligations', 'PIXEL1')).toEqual(value);
    }
    await store.delete('obligations', 'PIXEL1');
    const empty = new ResourceScope(store, 'PIXEL1', 'run');
    expect(await empty.list()).toEqual([]);
    await expect(empty.resolve('missing')).rejects.toThrow('outside this operation');
    const valid = await recordObligation(empty, 'helper', 'helper', {});
    await expect(empty.record(valid)).rejects.toThrow('Duplicate');
    await expect(empty.record({ ...valid, id: 'other', operationId: 'other-run' })).rejects.toThrow(
      'outside this operation',
    );
    await empty.resolve(valid.id);
    expect((await empty.list())[0]?.status).toBe('resolved');
  });

  it('records explicit maintenance/loss/retirement and archives evidence before invalidating it', async () => {
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const context = await loadProject(created.root, product);
    await store.set('workflow', 'all', { proof: hashA });
    await store.set('handoff', 'all', { custody: true });
    await store.set('attestations', 'all', [{ old: true }]);
    const input = {
      assetId: 'all',
      type: 'maintenance' as const,
      operator: 'Alice',
      note: 'Check policy changes and renew handoff.',
      confirmedErasure: false,
    };
    const record = await recordLifecycle(context, store, input, () => new Date('2026-10-16T09:00:00Z'));
    expect(record.at).toBe('2026-10-16T09:00:00.000Z');
    expect(await store.get('workflow', 'all')).toBeUndefined();
    expect(await store.get('handoff', 'all')).toBeUndefined();
    expect(await store.get('attestations', 'all')).toBeUndefined();
    expect(await store.get('lifecycle-evidence', record.id)).toEqual({
      record,
      workflow: { proof: hashA },
      handoff: { custody: true },
      attestations: [{ old: true }],
    });
    expect(await store.events('asset:all')).toHaveLength(1);
    await expect(recordLifecycle(context, store, { ...input, assetId: 'unknown' })).rejects.toThrow(
      'Unknown enrolled',
    );
    await expect(recordLifecycle(context, store, { ...input, operator: ' ' })).rejects.toThrow('Operator');
    await expect(recordLifecycle(context, store, { ...input, note: 'x'.repeat(1001) })).rejects.toThrow(
      'bounded',
    );
    await expect(recordLifecycle(context, store, { ...input, type: 'invalid' as never })).rejects.toThrow(
      'Unknown lifecycle',
    );
    await expect(recordLifecycle(context, store, { ...input, type: 'retirement' })).rejects.toThrow(
      'confirmed on-device',
    );
    expect(
      (await recordLifecycle(context, store, { ...input, type: 'retirement', confirmedErasure: true })).type,
    ).toBe('retirement');
  });
  it('restricts record and resolve to the exact child capability and rejects forged ownership', async () => {
    const parent = new ResourceScope(store, 'PIXEL1', 'root');
    const parentRecord = await recordObligation(parent, 'setting', 'keep-awake', {});
    const child = parent.writer().child('probe');
    const sibling = parent.writer().child('recipe');
    const childRecord = {
      ...parentRecord,
      id: 'child-record',
      operationId: child.operationId,
      ownerOperationId: child.ownerOperationId,
    };
    await child.record(childRecord);
    for (const writer of [child, sibling])
      await expect(writer.resolve(parentRecord.id)).rejects.toThrow('outside this operation');
    await expect(sibling.resolve(childRecord.id)).rejects.toThrow('outside this operation');
    await expect(parent.writer().resolve(childRecord.id)).rejects.toThrow('outside this operation');
    await expect(parent.writer().record({ ...childRecord, id: 'forged' })).rejects.toThrow(
      'outside this operation',
    );
    await expect(
      child.record({ ...childRecord, id: 'forged', ownerOperationId: sibling.ownerOperationId }),
    ).rejects.toThrow('outside this operation');
    expect(() => parent.child('../escape')).toThrow('Invalid recovery child');
    await child.resolve(childRecord.id);
    expect((await parent.list()).find((value) => value.id === parentRecord.id)?.status).toBe('pending');
    expect(Object.isFrozen(child)).toBe(true);
    expect(parent.child().ownerOperationId).toBe('root');
  });

  it('retains resources on write contention and refuses a disappearing cleanup owner', async () => {
    const scope = new ResourceScope(store, 'PIXEL1', 'run');
    const compare = vi.spyOn(store, 'compareAndSet').mockResolvedValue(false);
    await expect(recordObligation(scope, 'helper', 'blocked', {})).rejects.toThrow('contention');
    compare.mockRestore();
    await recordObligation(scope, 'helper', 'helper', {});
    await expect(
      scope.cleanup(
        (user) => Promise.resolve(user),
        async () => {
          await store.delete('obligations', 'PIXEL1');
        },
      ),
    ).rejects.toThrow('disappeared');
  });

  it('rolls back a lifecycle archive, invalidation and record when its audit event cannot persist', async () => {
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const project = await loadProject(created.root, product);
    const previous = { proof: 'accepted-generation' };
    await store.set('workflow', 'all', previous);
    const db = new DatabaseSync(join(root, 'state.sqlite'));
    db.exec(
      "CREATE TRIGGER lifecycle_fault BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'lifecycle-event-fault'); END",
    );
    try {
      await expect(
        recordLifecycle(
          project,
          store,
          { assetId: 'all', type: 'loss', operator: 'Alice', note: 'Custody lost', confirmedErasure: false },
          undefined,
          join(root, 'control'),
        ),
      ).rejects.toThrow('lifecycle-event-fault');
      expect(await store.get('workflow', 'all')).toEqual(previous);
      expect(await store.entries('lifecycle')).toEqual([]);
      expect(await store.entries('lifecycle-evidence')).toEqual([]);
      expect(await store.events('asset:all')).toEqual([]);
      db.exec('DROP TRIGGER lifecycle_fault');
      const original = store.transition.bind(store);
      vi.spyOn(store, 'transition').mockImplementationOnce(async (input) => {
        await store.set('workflow', 'all', { proof: 'new-generation' });
        return original(input);
      });
      await expect(
        recordLifecycle(
          project,
          store,
          { assetId: 'all', type: 'loss', operator: 'Alice', note: 'Custody lost', confirmedErasure: false },
          undefined,
          join(root, 'control'),
        ),
      ).rejects.toThrow('evidence changed');
      expect(await store.get('workflow', 'all')).toEqual({ proof: 'new-generation' });
    } finally {
      db.close();
    }
  });
  it('refuses stale lifecycle context before archiving or deleting current asset evidence', async () => {
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(basePolicy()));
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const project = await loadProject(created.root, product);
    await store.set('workflow', 'all', { generation: 'newer-accepted-state' });
    await writeFile(
      join(project.root, project.config.inventoryFile),
      JSON.stringify({ schemaVersion: 1, devices: [] }),
    );
    await expect(
      recordLifecycle(
        project,
        store,
        { assetId: 'all', type: 'loss', operator: 'Alice', note: 'Custody lost', confirmedErasure: false },
        undefined,
        join(root, 'control'),
      ),
    ).rejects.toThrow('Project source changed');
    expect(await store.get('workflow', 'all')).toEqual({ generation: 'newer-accepted-state' });
    expect(await store.entries('lifecycle-evidence')).toEqual([]);
    expect(await store.entries('lifecycle')).toEqual([]);
  });
});
