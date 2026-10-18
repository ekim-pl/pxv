import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from './../test-api.js';
import { SqliteStore } from '@pxv/runtime';
import { encodeRecord, encodeTransition, type StoreTransition } from '../../packages/runtime/src/store.js';
import { openDatabase, StorageHandler } from '../../packages/runtime/src/storage-handler.js';

const transition = (expected: unknown, next: unknown): StoreTransition => ({
  expected: [{ collection: 'workflow', key: 'phone', value: expected }],
  changes: [
    { kind: 'set', collection: 'archive', key: 'before', value: expected ?? null },
    { kind: 'set', collection: 'workflow', key: 'phone', value: next },
    { kind: 'delete', collection: 'attestations', key: 'phone' },
  ],
  events: [{ runId: 'phone', value: { next } }],
});

describe('atomic record and audit transitions', () => {
  it('commits exactly one competing state transition across workers', async () => {
    const path = join(await mkdtemp('/tmp/pxv-transitions-'), 'db');
    const stores = await Promise.all([SqliteStore.open(path), SqliteStore.open(path)]);
    try {
      const [a, b] = stores;
      if (!a || !b) throw new Error('Missing competing stores');
      await a.set('attestations', 'phone', ['old']);
      const results = await Promise.all([
        a.transition(transition(undefined, 1)),
        b.transition(transition(undefined, 2)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await a.events('phone')).toHaveLength(1);
      expect(await a.get('archive', 'before')).toBeNull();
      expect(await a.get('attestations', 'phone')).toBeUndefined();
      expect(await b.get('workflow', 'phone')).toBe(results[0] ? 1 : 2);
    } finally {
      await Promise.all(stores.map((store) => store.close()));
    }
  });

  it('rolls back state, archive, deletion and event together on database failure', async () => {
    const path = join(await mkdtemp('/tmp/pxv-transitions-'), 'db');
    const store = await SqliteStore.open(path);
    const db = new DatabaseSync(path);
    try {
      await store.set('workflow', 'phone', { accepted: true });
      await store.set('attestations', 'phone', ['accepted']);
      db.exec(
        "CREATE TRIGGER event_fault BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event-storage-fault'); END",
      );
      await expect(store.transition(transition({ accepted: true }, { erased: true }))).rejects.toThrow(
        'event-storage-fault',
      );
      expect(await store.get('workflow', 'phone')).toEqual({ accepted: true });
      expect(await store.get('archive', 'before')).toBeUndefined();
      expect(await store.get('attestations', 'phone')).toEqual(['accepted']);
      expect(await store.events('phone')).toEqual([]);
      db.exec('DROP TRIGGER event_fault');
      expect(await store.transition(transition({ accepted: true }, { erased: true }))).toBe(true);
      db.prepare('UPDATE records SET value=? WHERE collection=?').run('{retained-malformed', 'workflow');
      await expect(store.transition(transition({ erased: true }, null))).rejects.toThrow(
        'original record retained',
      );
      expect(db.prepare("SELECT value FROM records WHERE collection='workflow'").get()?.['value']).toBe(
        '{retained-malformed',
      );
    } finally {
      db.close();
      await store.close();
    }
  });

  it('rejects malformed transition addresses, duplicate writes and non-JSON evidence before IPC', () => {
    const base = transition(undefined, 1);
    expect(() =>
      encodeTransition({ ...base, expected: Array.from({ length: 257 }, () => base.expected[0]!) }),
    ).toThrow('size');
    expect(() => encodeTransition({ ...base, changes: [...base.changes, base.changes[0]!] })).toThrow(
      'Duplicate',
    );
    for (const key of ['', '\0', 'x'.repeat(1025)])
      expect(() =>
        encodeTransition({ ...base, expected: [{ collection: 'workflow', key, value: 1 }] }),
      ).toThrow('address');
    for (const runId of ['', 'x'.repeat(1025)])
      expect(() => encodeTransition({ ...base, events: [{ runId, value: 1 }] })).toThrow('event address');
    expect(() => encodeRecord(undefined)).toThrow('JSON values');
    expect(encodeTransition({ expected: [], changes: [], events: [] })).toEqual({
      expected: [],
      changes: [],
      events: [],
    });
  });

  it('worker handler rejects unknown protocols and retains malformed native/event evidence', async () => {
    const path = join(await mkdtemp('/tmp/pxv-handler-'), 'db');
    const db = openDatabase({ path, readOnly: false });
    const handler = new StorageHandler(db);
    try {
      expect(() => handler.dispatch('__proto__', [])).toThrow('Unsupported');
      expect(() => handler.dispatch('submit', [])).toThrow('Unsupported');
      db.prepare('INSERT INTO records(collection,key,value) VALUES(?,?,?)').run(
        'blob',
        'k',
        Buffer.from('non-JSON-binary'),
      );
      expect(() => handler.dispatch('get', ['blob', 'k'])).toThrow('original record retained');
      db.prepare('INSERT INTO events(run_id,value) VALUES(?,?)').run('r', '{bad');
      expect(() => handler.dispatch('events', ['r', 0, 100])).toThrow('original record retained');
      db.prepare('INSERT INTO submissions(idempotency_key,value) VALUES(?,?)').run('r', '{bad');
      expect(() => handler.dispatch('submitAndSet', ['r', '{bad', 'runs', 'r'])).toThrow(
        'original record retained',
      );
      db.prepare('INSERT INTO records(collection,key,value) VALUES(?,?,?)').run('bad', 'k', '{bad');
      expect(() => handler.dispatch('entries', ['bad', 1])).toThrow('original record retained');
      expect(() => handler.dispatch('compareAndSet', ['bad', 'k', '{bad', '1'])).toThrow(
        'original record retained',
      );
    } finally {
      handler.dispatch('close', []);
    }
  });
  it('enforces idempotent and transactional storage protocol across receipt and state lifetimes', async () => {
    const path = join(await mkdtemp('/tmp/pxv-handler-protocol-'), 'db');
    const db = openDatabase({ path, readOnly: false });
    const handler = new StorageHandler(db);
    const dispatch = (method: string, args: unknown[]) => handler.dispatch(method, args);
    try {
      expect(dispatch('get', ['c', 'missing'])).toEqual({ found: false });
      dispatch('set', ['c', 'k', '1']);
      expect(dispatch('get', ['c', 'k'])).toEqual({ found: true, value: 1 });
      expect(dispatch('entries', ['c', 1])).toEqual([{ key: 'k', value: 1 }]);
      expect(dispatch('compareAndSet', ['c', 'k', '1', '2'])).toBe(true);
      expect(dispatch('compareAndSet', ['c', 'k', '1', '3'])).toBe(false);
      expect(dispatch('compareAndSet', ['c', 'new', null, '3'])).toBe(true);
      expect(dispatch('delete', ['c', 'new'])).toBe(true);
      expect(dispatch('delete', ['c', 'new'])).toBe(false);
      const submission = { created: true, value: { status: 'queued' } };
      expect(dispatch('submitAndSet', ['id', JSON.stringify(submission.value), 'runs', 'run'])).toEqual(
        submission,
      );
      expect(dispatch('submitAndSet', ['id', JSON.stringify(submission.value), 'runs', 'run'])).toEqual({
        ...submission,
        created: false,
      });
      expect(() => dispatch('submitAndSet', ['id', '{}', 'runs', 'run'])).toThrow('different submission');
      expect(dispatch('submitAndSet', ['new', '{}', 'runs', 'new'])).toEqual({ created: true, value: {} });
      expect(dispatch('ingestReceipt', ['native', 'run', '{"native":true}'])).toEqual({
        created: true,
        sequence: 1,
      });
      expect(dispatch('ingestReceipt', ['native', 'run', '{"native":true}'])).toEqual({
        created: false,
        sequence: 1,
      });
      expect(() => dispatch('ingestReceipt', ['native', 'other', '{"native":true}'])).toThrow(
        'different evidence',
      );
      expect(() => dispatch('ingestReceipt', ['native', 'run', '{}'])).toThrow('different evidence');
      expect(dispatch('ingestedReceipt', ['native'])).toEqual({ native: true });
      expect(dispatch('ingestedReceipt', ['missing'])).toBeUndefined();
      expect(dispatch('events', ['run', 0, 1])).toEqual([{ sequence: 1, event: { native: true } }]);
      expect(dispatch('transition', [encodeTransition(transition(undefined, 5))])).toBe(true);
      expect(dispatch('transition', [encodeTransition(transition(undefined, 6))])).toBe(false);
      expect(dispatch('appendEvent', ['run', '{}'])).toBe(3);
    } finally {
      dispatch('close', []);
    }
    const readOnly = openDatabase({ path, readOnly: true });
    try {
      expect(new StorageHandler(readOnly).dispatch('get', ['c', 'k'])).toEqual({ found: true, value: 2 });
    } finally {
      readOnly.close();
    }
  });

  it('retries only idempotent startup SQLITE_BUSY and bounds lock contention without masking other faults', async () => {
    const root = await mkdtemp('/tmp/pxv-db-startup-');
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 });
    });
    try {
      const db = openDatabase({ path: join(root, 'retry'), readOnly: false });
      expect(exec).toHaveBeenCalledTimes(3);
      db.close();
      exec.mockImplementationOnce(() => {
        throw Object.assign(new Error('startup lock deadline'), { errcode: 5 });
      });
      const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6000);
      expect(() => openDatabase({ path: join(root, 'deadline'), readOnly: false })).toThrow(
        'startup lock deadline',
      );
      clock.mockRestore();
      exec.mockImplementationOnce(() => {
        throw new Error('storage permissions fault');
      });
      expect(() => openDatabase({ path: join(root, 'unrelated'), readOnly: false })).toThrow(
        'storage permissions fault',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
