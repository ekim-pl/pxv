import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from './../test-api.js';
import {
  createEncryptedRegistry,
  readEncryptedRegistry,
  rekeyEncryptedRegistry,
  writeEncryptedRegistry,
  readRegistryPrivateFile,
  writeRegistryPrivateFile,
  withDeviceLease,
  updateEncryptedRegistry,
} from '@pxv/runtime';
import { REGISTRY_ENVELOPE_LIMIT } from '../../packages/runtime/src/encrypted-registry-crypto.js';

const projectId = 'encrypted-registry-test';
const passphrase = Buffer.from('fixture-key!');
const sentinel = 'SYNTHETIC_PRIVATE_REGISTRY_SENTINEL';
const initial = {
  schemaVersion: 1,
  records: [{ assetId: 'synthetic-phone', credential: sentinel }],
  history: [],
};
const failure = 'Encrypted registry could not be opened or updated';
const decode = (value: unknown) => value as typeof initial;
let root: string;
let directory: string;
let path: string;
let fixture: Buffer;
let fixtureRevision: string;
let savedControlRoot: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-encrypted-registry-'));
  savedControlRoot = process.env['PXV_CONTROL_ROOT'];
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  const original = join(root, 'fixture.enc');
  await createEncryptedRegistry(original, projectId, passphrase, initial);
  fixture = await readFile(original);
  fixtureRevision = createHash('sha256').update(fixture).digest('hex');
});
beforeEach(async () => {
  directory = await mkdtemp(join(root, 'case-'));
  path = join(directory, 'registry.enc');
  await writeFile(path, fixture, { mode: 0o600 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  if (savedControlRoot === undefined) delete process.env['PXV_CONTROL_ROOT'];
  else process.env['PXV_CONTROL_ROOT'] = savedControlRoot;
  await rm(root, { recursive: true, force: true });
});

describe('authenticated encrypted registry storage with the production KDF', () => {
  it('holds a private update transaction, skips cancelled writes and refuses stale or escaped commits', async () => {
    await expect(
      updateEncryptedRegistry(path, projectId, passphrase, decode, () =>
        Promise.reject(new Error('Cancelled')),
      ),
    ).rejects.toThrow('Cancelled');
    expect(await readFile(path)).toEqual(fixture);
    let escaped: ((value: typeof initial) => Promise<void>) | undefined;
    await updateEncryptedRegistry(path, projectId, passphrase, decode, (_current, commit) => {
      escaped = commit;
      return Promise.resolve();
    });
    await expect(escaped!(initial)).rejects.toThrow('while active');
    await expect(
      updateEncryptedRegistry(path, projectId, passphrase, decode, async (_current, commit) => {
        await writeFile(path, Buffer.from('changed externally'));
        await commit(initial);
      }),
    ).rejects.toThrow(failure);
  });

  it('commits private transformations once without retaining plaintext or overwriting caller buffers', async () => {
    await updateEncryptedRegistry(path, projectId, passphrase, decode, async ({ value }, commit) => {
      value.records[0]!.credential = sentinel + '-updated';
      await commit(value);
      await expect(commit(value)).rejects.toThrow('only once');
    });
    const encrypted = await readFile(path);
    expect(encrypted.includes(sentinel)).toBe(false);
    expect(
      (await readEncryptedRegistry(path, projectId, passphrase, decode)).value.records[0]?.credential,
    ).toBe(sentinel + '-updated');
    expect(passphrase.toString()).toBe('fixture-key!');
  });
  it('reopens genuine ciphertext, keeps secrets out of disk and ordinary inspection, and preserves caller key buffers', async () => {
    const loaded = await readEncryptedRegistry(path, projectId, passphrase, decode);
    expect(loaded.value).toEqual(initial);
    expect(loaded.revision).toBe(fixtureRevision);
    expect(fixture.includes(sentinel)).toBe(false);
    expect(inspect(loaded)).not.toContain(sentinel);
    expect(JSON.stringify(loaded)).not.toContain(sentinel);
    expect(Object.keys(loaded)).toEqual(['revision']);
    expect(passphrase.toString()).toBe('fixture-key!');
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
  });

  it('rejects wrong keys and callback failures without disclosing plaintext or attacker values', async () => {
    await expect(
      readEncryptedRegistry(path, projectId, Buffer.from('incorrect-key!'), decode),
    ).rejects.toThrow(failure);
    await expect(
      readEncryptedRegistry(path, projectId, passphrase, () => {
        throw new Error(sentinel);
      }),
    ).rejects.toThrow(failure);
    expect(await readFile(path)).toEqual(fixture);
  });

  it('serializes competing initialization and never replaces an existing registry', async () => {
    const fresh = join(directory, 'nested', 'private', 'new.enc');
    const before = vi.fn<(revision: string) => Promise<void>>(() => Promise.resolve());
    const after = vi.fn<(revision: string) => Promise<void>>(() => Promise.resolve());
    const attempts = await Promise.allSettled([
      createEncryptedRegistry(fresh, projectId, passphrase, initial, before, after),
      createEncryptedRegistry(fresh, projectId, passphrase, { alternate: true }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const hash = createHash('sha256')
      .update(await readFile(fresh))
      .digest('hex');
    expect(before).toHaveBeenCalledExactlyOnceWith(hash);
    expect(after).toHaveBeenCalledExactlyOnceWith(hash);
    expect((await readEncryptedRegistry(fresh, projectId, passphrase, decode)).value).toEqual(initial);
    expect((await stat(join(directory, 'nested/private'))).mode & 0o7777).toBe(0o700);
    await expect(createEncryptedRegistry(path, projectId, passphrase, { alternate: true })).rejects.toThrow(
      failure,
    );
    expect(await readFile(path)).toEqual(fixture);
  });

  it('commits exactly one competing update and rejects stale revisions before running guards', async () => {
    const guard = vi.fn(() => Promise.resolve());
    const update = (value: number) =>
      writeEncryptedRegistry(path, projectId, passphrase, { value }, fixtureRevision, guard);
    const attempts = await Promise.allSettled([update(1), update(2)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(guard).toHaveBeenCalledOnce();
    const loaded = await readEncryptedRegistry(
      path,
      projectId,
      passphrase,
      (value) => value as { value: number },
    );
    expect(loaded.value).toEqual({ value: 1 });
    expect(loaded.revision).not.toBe(fixtureRevision);
    await expect(update(3)).rejects.toThrow(failure);
    expect(guard).toHaveBeenCalledOnce();
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('runs a generation guard under native project ownership and preserves ciphertext when it rejects', async () => {
    const guard = async () => {
      await expect(
        withDeviceLease(
          process.env['PXV_CONTROL_ROOT']!,
          `project-${projectId}`,
          `project-${projectId}`,
          'competing-guard',
          () => Promise.resolve(),
        ),
      ).rejects.toThrow();
      throw new Error(sentinel);
    };
    await expect(
      writeEncryptedRegistry(path, projectId, passphrase, { changed: true }, fixtureRevision, guard),
    ).rejects.toThrow(failure);
    expect(await readFile(path)).toEqual(fixture);
    const uncalled = vi.fn(() => Promise.resolve());
    await expect(
      writeEncryptedRegistry(path, projectId, Buffer.from('incorrect-key!'), {}, fixtureRevision, uncalled),
    ).rejects.toThrow(failure);
    expect(uncalled).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(fixture);
  });

  it('rekeys atomically with fresh salt and nonce, rejects stale rekey, and reopens only with the new key', async () => {
    const next = Buffer.alloc(1024, 's');
    const guard = vi.fn(() => Promise.resolve());
    const after = vi.fn<(revision: string) => Promise<void>>(() => Promise.resolve());
    await rekeyEncryptedRegistry(path, projectId, passphrase, next, fixtureRevision, guard, after);
    expect(guard).toHaveBeenCalledOnce();
    const updated = await readFile(path);
    const hash = createHash('sha256').update(updated).digest('hex');
    expect(guard).toHaveBeenCalledExactlyOnceWith(hash);
    expect(after).toHaveBeenCalledExactlyOnceWith(hash);
    const oldEnvelope = JSON.parse(fixture.toString()) as {
      kdf: { salt: string };
      cipher: { nonce: string };
    };
    const newEnvelope = JSON.parse(updated.toString()) as typeof oldEnvelope;
    expect(newEnvelope.kdf.salt).not.toBe(oldEnvelope.kdf.salt);
    expect(newEnvelope.cipher.nonce).not.toBe(oldEnvelope.cipher.nonce);
    await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
    expect((await readEncryptedRegistry(path, projectId, next, decode)).value).toEqual(initial);
    await expect(
      rekeyEncryptedRegistry(path, projectId, next, passphrase, fixtureRevision, guard),
    ).rejects.toThrow(failure);
    expect(await readFile(path)).toEqual(updated);
    expect(next.equals(Buffer.alloc(1024, 's'))).toBe(true);
  });

  it('keeps post-write hook failures committed for an external pending-anchor fence to reconcile', async () => {
    let pending = '';
    const assertOwned = async () => {
      await expect(
        withDeviceLease(
          process.env['PXV_CONTROL_ROOT']!,
          `project-${projectId}`,
          `project-${projectId}`,
          'hook-ownership',
          () => Promise.resolve(),
        ),
      ).rejects.toThrow();
    };
    const before = async (nextRevision: string) => {
      await assertOwned();
      expect(await readFile(path)).toEqual(fixture);
      pending = nextRevision;
    };
    const after = async (nextRevision: string) => {
      await assertOwned();
      expect(nextRevision).toBe(pending);
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(nextRevision);
      throw new Error(sentinel);
    };
    await expect(
      writeEncryptedRegistry(path, projectId, passphrase, { updated: true }, fixtureRevision, before, after),
    ).rejects.toThrow(failure);
    expect(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ).toBe(pending);
    expect(
      (await readEncryptedRegistry(path, projectId, passphrase, (value) => value as { updated: boolean }))
        .value,
    ).toEqual({ updated: true });
    await expect(
      writeEncryptedRegistry(path, projectId, passphrase, initial, fixtureRevision),
    ).rejects.toThrow(failure);
  });
});

describe('bounded envelopes and authenticated headers', () => {
  it.each(['ciphertext', 'tag', 'nonce', 'salt'] as const)(
    'rejects authenticated %s tampering',
    async (field) => {
      const envelope = JSON.parse(fixture.toString()) as {
        ciphertext: string;
        tag: string;
        cipher: { nonce: string };
        kdf: { salt: string };
      };
      const holder = field === 'nonce' ? envelope.cipher : field === 'salt' ? envelope.kdf : envelope;
      const record = holder as unknown as Record<string, string>;
      const bytes = Buffer.from(record[field]!, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      record[field] = bytes.toString('base64');
      await writeFile(path, JSON.stringify(envelope));
      await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
    },
  );

  it('rejects unsupported KDF parameters, duplicate fields, malformed encodings, truncation and wrong projects', async () => {
    const envelope = JSON.parse(fixture.toString()) as Record<string, unknown>;
    const invalid = [
      fixture.subarray(0, fixture.length - 8),
      Buffer.from(fixture.toString().replace('"version":1', '"version":1,"version":1')),
      Buffer.from(JSON.stringify({ ...envelope, version: 2 })),
      Buffer.from(JSON.stringify({ ...envelope, extra: true })),
      Buffer.from(JSON.stringify({ ...envelope, kdf: { ...(envelope['kdf'] as object), N: 2 ** 30 } })),
      Buffer.from(JSON.stringify({ ...envelope, tag: 'not-base64' })),
    ];
    for (const bytes of invalid) {
      await writeFile(path, bytes);
      await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
    }
    await writeFile(path, fixture);
    await expect(readEncryptedRegistry(path, 'different-project', passphrase, decode)).rejects.toThrow(
      failure,
    );
    await writeFile(path, JSON.stringify({ ...envelope, projectId: 'different-project' }));
    await expect(readEncryptedRegistry(path, 'different-project', passphrase, decode)).rejects.toThrow(
      failure,
    );
    await writeFile(path, Buffer.alloc(REGISTRY_ENVELOPE_LIMIT + 1));
    await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
  });

  it('bounds passphrases, plaintext and expected revisions before expensive cryptography', async () => {
    for (const key of [Buffer.alloc(11), Buffer.alloc(1025)]) {
      await expect(
        createEncryptedRegistry(join(directory, 'new.enc'), projectId, key, initial),
      ).rejects.toThrow(failure);
      await expect(readEncryptedRegistry(path, projectId, key, decode)).rejects.toThrow(failure);
    }
    await expect(
      createEncryptedRegistry(join(directory, 'new.enc'), projectId, passphrase, undefined),
    ).rejects.toThrow(failure);
    await expect(
      createEncryptedRegistry(
        join(directory, 'new.enc'),
        projectId,
        passphrase,
        'x'.repeat(16 * 1024 * 1024),
      ),
    ).rejects.toThrow(failure);
    await expect(writeEncryptedRegistry(path, projectId, passphrase, {}, 'invalid')).rejects.toThrow(failure);
    expect(await readFile(path)).toEqual(fixture);
  });
});

describe('private registry file boundaries', () => {
  it('rejects ambiguous or malformed paths and filesystem-root destinations before opening private data', async () => {
    for (const unsafe of ['', 'x'.repeat(4097), join(directory, 'a\0b'), `${directory}/../registry.enc`]) {
      await expect(readRegistryPrivateFile(unsafe, 1024)).rejects.toThrow('Private registry file');
      await expect(writeRegistryPrivateFile(unsafe, Buffer.from(sentinel))).rejects.toThrow(
        'Private registry file',
      );
    }
    await expect(readRegistryPrivateFile('/pxv-synthetic-private-registry', 1024)).rejects.toThrow(
      'Private registry file',
    );
    expect(await readFile(path)).toEqual(fixture);
  });

  it('bounds private reads and rejects empty export payloads without creating any destination', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, 32 * 1024 * 1024 + 1]) {
      await expect(readRegistryPrivateFile(path, maxBytes)).rejects.toThrow('Private registry file');
    }
    const output = join(directory, 'empty.txt');
    await expect(writeRegistryPrivateFile(output, Buffer.alloc(0))).rejects.toThrow('Private registry file');
    await expect(stat(output)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await readFile(path)).toEqual(fixture);
  });

  it('rejects nonprivate file and parent permissions, symlink files and symlink path components', async () => {
    await chmod(path, 0o644);
    await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
    await chmod(path, 0o600);
    await chmod(directory, 0o755);
    await expect(readEncryptedRegistry(path, projectId, passphrase, decode)).rejects.toThrow(failure);
    await chmod(directory, 0o700);
    const linkPath = join(directory, 'link.enc');
    await symlink(path, linkPath);
    await expect(readEncryptedRegistry(linkPath, projectId, passphrase, decode)).rejects.toThrow(failure);
    await expect(createEncryptedRegistry(linkPath, projectId, passphrase, initial)).rejects.toThrow(failure);
    const linkedParent = join(directory, 'linked-parent');
    await symlink(directory, linkedParent);
    await expect(
      readEncryptedRegistry(join(linkedParent, 'registry.enc'), projectId, passphrase, decode),
    ).rejects.toThrow(failure);
    await expect(
      writeEncryptedRegistry(join(linkedParent, 'registry.enc'), projectId, passphrase, {}, fixtureRevision),
    ).rejects.toThrow(failure);
    expect(await readFile(path)).toEqual(fixture);
  });

  it('rejects writable nonsticky ancestors and exports only through exclusive private destinations', async () => {
    const unsafe = join(directory, 'unsafe');
    await mkdir(unsafe, { mode: 0o700 });
    const child = join(unsafe, 'child');
    await mkdir(child, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    await expect(writeRegistryPrivateFile(join(child, 'secret'), Buffer.from(sentinel))).rejects.toThrow(
      'Private registry file',
    );
    const exported = join(directory, 'export', 'private.txt');
    await writeRegistryPrivateFile(exported, Buffer.from(sentinel));
    expect((await stat(exported)).mode & 0o7777).toBe(0o600);
    expect((await readRegistryPrivateFile(exported, 1024)).toString()).toBe(sentinel);
    await expect(writeRegistryPrivateFile(exported, Buffer.from('replacement'))).rejects.toThrow(
      'Private registry file',
    );
    await expect(readRegistryPrivateFile(exported, 4)).rejects.toThrow('Private registry file');
    expect((await readFile(exported)).toString()).toBe(sentinel);
    expect(await readdir(join(directory, 'export'))).toEqual(['private.txt']);
  });
});
