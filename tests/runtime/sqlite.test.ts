import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { SqliteStore } from '../../packages/runtime/src/index.js';

describe('dedicated SQLite worker', () => {
  test('pages every retained key beyond the legacy entry cap with stable exclusive cursors', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-pages-');
    const store = await SqliteStore.open(join(directory, 'db'));
    try {
      for (let index = 0; index < 1005; index++)
        await store.set('runs', `run-${String(index).padStart(4, '0')}`, index);
      expect(await store.entriesPage('absent')).toEqual({ items: [], nextCursor: null });
      const first = await store.entriesPage<number>('runs');
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).toBe('run-0099');
      const second = await store.entriesPage<number>('runs', { cursor: first.nextCursor!, limit: 900 });
      expect(second.items[0]?.value).toBe(100);
      const last = await store.entriesPage<number>('runs', { cursor: second.nextCursor! });
      expect(last.items.map((item) => item.value)).toEqual([1000, 1001, 1002, 1003, 1004]);
      expect(last.nextCursor).toBeNull();
      const all = [...first.items, ...second.items, ...last.items];
      expect(new Set(all.map((item) => item.key)).size).toBe(1005);
      expect(await store.entriesPage('runs', { cursor: 'zzz' })).toEqual({ items: [], nextCursor: null });
      expect((await store.entriesPage('runs', { cursor: 'run-1000', limit: 4 })).nextCursor).toBeNull();
      for (const cursor of ['', 'a\0b', 'a'.repeat(1025)])
        await expect(store.entriesPage('runs', { cursor })).rejects.toThrow('cursor');
      for (const limit of [0, -1, 1001, 1.5, NaN])
        await expect(store.entriesPage('runs', { limit })).rejects.toThrow('limit');
    } finally {
      await store.close();
    }
  });
  test('persists records, ordered cursor events and deletion', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const store = await SqliteStore.open(path);
    try {
      expect(await store.get('devices', 'missing')).toBeUndefined();
      await store.set('nullable', 'value', null);
      expect(await store.get('nullable', 'value')).toBeNull();
      await store.set('devices', 'all', { identity: 'exact', permissions: [true, false] });
      expect(await store.get('devices', 'all')).toEqual({ identity: 'exact', permissions: [true, false] });
      const first = await store.appendEvent('a', { type: 'intent' });
      await store.appendEvent('b', { type: 'other' });
      await store.appendEvent('a', { type: 'receipt' });
      expect(await store.events('a', first, 1)).toEqual([{ sequence: 3, event: { type: 'receipt' } }]);
      expect(await store.delete('devices', 'all')).toBe(true);
      expect(await store.delete('devices', 'all')).toBe(false);
      await expect(store.events('a', -1)).rejects.toThrow('cursor');
      await expect(store.events('a', 0, 1001)).rejects.toThrow('cursor');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await store.close();
    }
    await store.close();
    await expect(store.get('a', 'b')).rejects.toThrow('closed');
  });
  test('read-only missing opens create no directory or file', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'absent', 'db');
    await expect(SqliteStore.open(path, { readOnly: true })).rejects.toThrow('does not exist');
    await expect(stat(join(directory, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('read-only opens never initialize schema and reject writes', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const writable = await SqliteStore.open(path);
    await writable.set('c', 'k', 'v');
    await writable.close();
    const before = await readFile(path);
    const readonly = await SqliteStore.open(path, { readOnly: true });
    try {
      expect(await readonly.get('c', 'k')).toBe('v');
      await expect(readonly.set('c', 'x', 'no')).rejects.toThrow('readonly');
    } finally {
      await readonly.close();
    }
    expect(await readFile(path)).toEqual(before);
  });
  test('malformed JSON remains available as original evidence', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const store = await SqliteStore.open(path);
    await store.close();
    const raw = new DatabaseSync(path);
    raw.prepare('INSERT INTO records(collection,key,value) VALUES(?,?,?)').run('damaged', 'key', '{broken');
    raw.close();
    const inspect = await SqliteStore.open(path);
    try {
      await expect(inspect.get('damaged', 'key')).rejects.toThrow('original record retained');
      await expect(inspect.entriesPage('damaged')).rejects.toThrow('damaged/key');
    } finally {
      await inspect.close();
    }
    const retained = new DatabaseSync(path);
    expect(retained.prepare('SELECT value FROM records').get()?.['value']).toBe('{broken');
    retained.close();
  });
  test('concurrent duplicate submissions bind one immutable value', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const a = await SqliteStore.open(path);
    const b = await SqliteStore.open(path);
    try {
      const results = await Promise.all([
        a.submitAndSet('same', { plan: 'approved' }, 'runs', 'same'),
        b.submitAndSet('same', { plan: 'approved' }, 'runs', 'same'),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      await expect(b.submitAndSet('same', { plan: 'changed' }, 'runs', 'same')).rejects.toThrow(
        'different submission',
      );
      expect((await a.submitAndSet('same', { plan: 'approved' }, 'runs', 'same')).created).toBe(false);
      expect(await b.entries('runs')).toEqual([{ key: 'same', value: { plan: 'approved' } }]);
    } finally {
      await a.close();
      await b.close();
    }
  });
  test('does not follow database symlinks', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const store = await SqliteStore.open(path);
    await store.close();
    const link = join(directory, 'link');
    await symlink(path, link);
    await expect(SqliteStore.open(link)).rejects.toThrow('regular file');
  });
  test('atomic submission rolls back both receipt and run record on conflicting keys', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const store = await SqliteStore.open(path);
    try {
      await store.set('runs', 'occupied', { plan: 'existing' });
      await expect(store.submitAndSet('new', { plan: 'wrong' }, 'runs', 'occupied')).rejects.toThrow(
        'UNIQUE',
      );
      expect(await store.submitAndSet('new', { plan: 'correct' }, 'runs', 'available')).toEqual({
        created: true,
        value: { plan: 'correct' },
      });
      expect(await store.submitAndSet('new', { plan: 'correct' }, 'runs', 'available')).toEqual({
        created: false,
        value: { plan: 'correct' },
      });
      expect(await store.get('runs', 'available')).toEqual({ plan: 'correct' });
      expect(await store.entries('runs')).toEqual([
        { key: 'available', value: { plan: 'correct' } },
        { key: 'occupied', value: { plan: 'existing' } },
      ]);
      expect(await store.entries('runs', 1)).toHaveLength(1);
      await expect(store.entries('runs', 0)).rejects.toThrow('limit');
      expect(() => store.set('bad', 'undefined', undefined)).toThrow('JSON values');
    } finally {
      await store.close();
    }
  });
  test('compare-and-set serializes concurrent monotonic updates without losing evidence', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const a = await SqliteStore.open(path);
    const b = await SqliteStore.open(path);
    try {
      const results = await Promise.all([
        a.compareAndSet('floors', 'repo', undefined, 10),
        b.compareAndSet('floors', 'repo', undefined, 20),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const current = await a.get<number>('floors', 'repo');
      expect(await a.compareAndSet('floors', 'repo', current, 30)).toBe(true);
      expect(await b.compareAndSet('floors', 'repo', current, 5)).toBe(false);
      expect(await b.get('floors', 'repo')).toBe(30);
    } finally {
      await a.close();
      await b.close();
    }
  });
  test('native receipt ingestion is idempotent and rejects changed evidence', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'db');
    const store = await SqliteStore.open(path);
    try {
      const first = await store.ingestReceipt('native-token', 'run', { cleanup_proven: true });
      expect(await store.ingestedReceipt('native-token')).toEqual({ cleanup_proven: true });
      expect(await store.ingestedReceipt('missing')).toBeUndefined();
      expect(await store.ingestReceipt('native-token', 'run', { cleanup_proven: true })).toEqual({
        created: false,
        sequence: first.sequence,
      });
      await expect(store.ingestReceipt('native-token', 'other', { cleanup_proven: true })).rejects.toThrow(
        'different evidence',
      );
      expect(await store.events('run')).toEqual([
        { sequence: first.sequence, event: { cleanup_proven: true } },
      ]);
    } finally {
      await store.close();
    }
  });
  test('invalid database fails initialization without silently replacing the bytes', async () => {
    const directory = await mkdtemp('/tmp/pxv-db-');
    const path = join(directory, 'broken');
    await writeFile(path, 'original-corrupt-database');
    await expect(SqliteStore.open(path)).rejects.toThrow('not a database');
    expect(await readFile(path, 'utf8')).toBe('original-corrupt-database');
    await expect(SqliteStore.open(directory)).rejects.toThrow('regular file');
  });
});
