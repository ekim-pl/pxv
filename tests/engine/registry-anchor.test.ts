import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from './../test-api.js';
import { SqliteStore } from '@pxv/runtime';
import {
  assertRegistryAnchor,
  beginRegistryCommit,
  finishRegistryCommit,
  readRegistryAnchor,
  type RegistryAnchor,
} from '../../packages/engine/src/registry-anchor.js';

const firstHash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const failure = 'explicit restore reconciliation is required';
let directory: string;
let store: SqliteStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-registry-anchor-'));
  store = await SqliteStore.open(join(directory, 'state.sqlite3'));
});
afterEach(async () => {
  await store.close();
  await rm(directory, { recursive: true, force: true });
});

describe('ciphertext rollback anchors', () => {
  it('keeps uninitialized, interrupted and rolled-back ciphertext closed until an exact commit finishes', async () => {
    expect(await readRegistryAnchor(store, 'project')).toBeUndefined();
    await expect(assertRegistryAnchor(store, 'project', firstHash)).rejects.toThrow(failure);
    const initial = await beginRegistryCommit(store, 'project', undefined, firstHash);
    expect(initial).toEqual({ schemaVersion: 1, ciphertextRevision: firstHash, state: 'pending' });
    await expect(assertRegistryAnchor(store, 'project', firstHash)).rejects.toThrow(failure);
    await finishRegistryCommit(store, 'project', initial);
    await expect(assertRegistryAnchor(store, 'project', firstHash)).resolves.toBeUndefined();
    const ready = await readRegistryAnchor(store, 'project');
    const pending = await beginRegistryCommit(store, 'project', ready, nextHash);
    await expect(assertRegistryAnchor(store, 'project', firstHash)).rejects.toThrow(failure);
    await expect(assertRegistryAnchor(store, 'project', nextHash)).rejects.toThrow(failure);
    await finishRegistryCommit(store, 'project', pending);
    await expect(assertRegistryAnchor(store, 'project', nextHash)).resolves.toBeUndefined();
    await expect(assertRegistryAnchor(store, 'project', firstHash)).rejects.toThrow(failure);
    expect(await store.entries('registry-anchor')).toEqual([
      { key: 'project', value: { schemaVersion: 1, ciphertextRevision: nextHash, state: 'ready' } },
    ]);
  });

  it('allows exactly one competing initialization or replacement and rejects stale completion', async () => {
    const creations = await Promise.allSettled([
      beginRegistryCommit(store, 'project', undefined, firstHash),
      beginRegistryCommit(store, 'project', undefined, nextHash),
    ]);
    expect(creations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const initial = await readRegistryAnchor(store, 'project');
    if (!initial) throw new Error('Missing initial anchor');
    await finishRegistryCommit(store, 'project', initial);
    const ready = await readRegistryAnchor(store, 'project');
    const attempts = await Promise.allSettled([
      beginRegistryCommit(store, 'project', ready, 'c'.repeat(64)),
      beginRegistryCommit(store, 'project', ready, 'd'.repeat(64)),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(finishRegistryCommit(store, 'project', initial)).rejects.toThrow(failure);
    const pending = await readRegistryAnchor(store, 'project');
    if (!pending) throw new Error('Missing competing anchor');
    await finishRegistryCommit(store, 'project', pending);
    await expect(finishRegistryCommit(store, 'project', pending)).rejects.toThrow(failure);
  });

  it('isolates project anchors and accepts explicitly reviewed recovery from an interrupted pending row', async () => {
    const first = await beginRegistryCommit(store, 'project-one', undefined, firstHash);
    await finishRegistryCommit(store, 'project-one', first);
    await expect(assertRegistryAnchor(store, 'project-two', firstHash)).rejects.toThrow(failure);
    const interrupted = await beginRegistryCommit(store, 'project-two', undefined, nextHash);
    const reconciled = await beginRegistryCommit(store, 'project-two', interrupted, 'c'.repeat(64));
    await expect(finishRegistryCommit(store, 'project-two', interrupted)).rejects.toThrow(failure);
    await finishRegistryCommit(store, 'project-two', reconciled);
    await expect(assertRegistryAnchor(store, 'project-one', firstHash)).resolves.toBeUndefined();
    await expect(assertRegistryAnchor(store, 'project-two', 'c'.repeat(64))).resolves.toBeUndefined();
  });

  it('refuses malformed public rows without echoing unknown private keys or values', async () => {
    const sentinel = 'SYNTHETIC_PRIVATE_ANCHOR_SENTINEL';
    const invalid: unknown[] = [
      null,
      [],
      'invalid',
      {},
      { schemaVersion: 2, ciphertextRevision: firstHash, state: 'ready' },
      { schemaVersion: 1, ciphertextRevision: 3, state: 'ready' },
      { schemaVersion: 1, ciphertextRevision: sentinel, state: 'ready' },
      { schemaVersion: 1, ciphertextRevision: firstHash, state: sentinel },
      { schemaVersion: 1, ciphertextRevision: firstHash, state: 'ready', [sentinel]: sentinel },
    ];
    for (const row of invalid) {
      await store.set('registry-anchor', 'project', row);
      await expect(readRegistryAnchor(store, 'project')).rejects.toThrow(failure);
      await expect(readRegistryAnchor(store, 'project')).rejects.not.toThrow(sentinel);
      await expect(beginRegistryCommit(store, 'project', row as RegistryAnchor, nextHash)).rejects.toThrow(
        failure,
      );
      await expect(finishRegistryCommit(store, 'project', row as RegistryAnchor)).rejects.toThrow(failure);
    }
  });

  it('rejects malformed next revisions, ready-as-pending completion and absent captured anchors', async () => {
    for (const invalid of ['', 'A'.repeat(64), 'short', '../escape'])
      await expect(beginRegistryCommit(store, 'project', undefined, invalid)).rejects.toThrow(failure);
    expect(await readRegistryAnchor(store, 'project')).toBeUndefined();
    const pending = await beginRegistryCommit(store, 'project', undefined, firstHash);
    await expect(finishRegistryCommit(store, 'project', { ...pending, state: 'ready' })).rejects.toThrow(
      failure,
    );
    await expect(beginRegistryCommit(store, 'project', undefined, nextHash)).rejects.toThrow(failure);
    await expect(
      beginRegistryCommit(store, 'project', { ...pending, ciphertextRevision: nextHash }, firstHash),
    ).rejects.toThrow(failure);
    expect(await readRegistryAnchor(store, 'project')).toEqual(pending);
  });
});
