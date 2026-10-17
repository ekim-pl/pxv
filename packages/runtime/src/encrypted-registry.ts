import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { inspect } from 'node:util';
import { hostControlRoot, withDeviceLease } from './commands.js';
import {
  closeRegistryDirectory,
  commitRegistryBytes,
  openRegistryDirectory,
  readRegistryBytes,
  registryChild,
  type RegistryDirectory,
} from './encrypted-registry-files.js';
import {
  decryptRegistry,
  encryptedRegistryFailure,
  encryptRegistry,
  REGISTRY_ENVELOPE_LIMIT,
  registryJson,
  validateRegistryInput,
} from './encrypted-registry-crypto.js';

const pendingWrites = new Map<string, Promise<unknown>>();
const revision = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
type CommitHook = (ciphertextRevision: string) => Promise<void>;

async function withRegistryLease<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(projectId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() =>
      withDeviceLease(
        hostControlRoot(),
        `project-${projectId}`,
        `project-${projectId}`,
        `${randomUUID()}-project`,
        action,
      ),
    );
  pendingWrites.set(projectId, operation);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(projectId) === operation) pendingWrites.delete(projectId);
  }
}

async function inDirectory<T>(
  path: string,
  create: boolean,
  action: (directory: RegistryDirectory) => Promise<T>,
): Promise<T> {
  let directory: RegistryDirectory | undefined;
  try {
    directory = await openRegistryDirectory(path, create);
    return await action(directory);
  } catch {
    throw encryptedRegistryFailure();
  } finally {
    if (directory) await closeRegistryDirectory(directory);
  }
}

/** Initial plaintext is caller-owned JSON; only authenticated ciphertext reaches disk. */
export async function createEncryptedRegistry(
  path: string,
  projectId: string,
  passphrase: Buffer,
  value: unknown,
  beforeCommit?: CommitHook,
  afterCommit?: CommitHook,
): Promise<void> {
  let plaintext: Buffer | undefined;
  let secret: Buffer | undefined;
  try {
    validateRegistryInput(projectId, passphrase);
    secret = Buffer.from(passphrase);
    const unlock = secret;
    plaintext = registryJson(value);
    const input = plaintext;
    await withRegistryLease(projectId, () =>
      inDirectory(path, true, async (directory) => {
        const exists = await lstat(registryChild(directory)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (exists) throw encryptedRegistryFailure();
        const encrypted = await encryptRegistry(input, projectId, unlock);
        await commitEncryptedValue(directory, encrypted, false, beforeCommit, afterCommit);
      }),
    );
  } catch {
    throw encryptedRegistryFailure();
  } finally {
    plaintext?.fill(0);
    secret?.fill(0);
  }
}

async function commitEncryptedValue(
  directory: RegistryDirectory,
  encrypted: Buffer,
  replace: boolean,
  beforeCommit: CommitHook | undefined,
  afterCommit: CommitHook | undefined,
): Promise<void> {
  const nextRevision = revision(encrypted);
  await beforeCommit?.(nextRevision);
  await commitRegistryBytes(directory, encrypted, replace);
  await afterCommit?.(nextRevision);
}

function unlockedValue<T>(value: T, ciphertextRevision: string): { value: T; revision: string } {
  const result = { revision: ciphertextRevision } as { value: T; revision: string };
  Object.defineProperty(result, 'value', { value, enumerable: false });
  Object.defineProperty(result, inspect.custom, {
    value: () => '[Unlocked encrypted registry: contents hidden]',
  });
  return result;
}

export async function readEncryptedRegistry<T>(
  path: string,
  projectId: string,
  passphrase: Buffer,
  validate: (value: unknown) => T,
): Promise<{ value: T; revision: string }> {
  let plaintext: Buffer | undefined;
  let secret: Buffer | undefined;
  try {
    validateRegistryInput(projectId, passphrase);
    secret = Buffer.from(passphrase);
    const unlock = secret;
    return await inDirectory(path, false, async (directory) => {
      const encrypted = await readRegistryBytes(directory, REGISTRY_ENVELOPE_LIMIT);
      plaintext = await decryptRegistry(encrypted, projectId, unlock);
      const value: unknown = JSON.parse(plaintext.toString('utf8'));
      return unlockedValue(validate(value), revision(encrypted));
    });
  } catch {
    throw encryptedRegistryFailure();
  } finally {
    plaintext?.fill(0);
    secret?.fill(0);
  }
}

async function replaceRegistry(
  path: string,
  projectId: string,
  oldPassphrase: Buffer,
  newPassphrase: Buffer,
  expectedRevision: string,
  value: Buffer | undefined,
  beforeCommit: CommitHook | undefined,
  afterCommit: CommitHook | undefined,
): Promise<void> {
  validateRegistryInput(projectId, oldPassphrase);
  validateRegistryInput(projectId, newPassphrase);
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) throw encryptedRegistryFailure();
  await withRegistryLease(projectId, () =>
    inDirectory(path, false, async (directory) => {
      const current = await readRegistryBytes(directory, REGISTRY_ENVELOPE_LIMIT);
      if (revision(current) !== expectedRevision) throw encryptedRegistryFailure();
      const previous = await decryptRegistry(current, projectId, oldPassphrase);
      try {
        const encrypted = await encryptRegistry(value ?? previous, projectId, newPassphrase);
        await commitEncryptedValue(directory, encrypted, true, beforeCommit, afterCommit);
      } finally {
        previous.fill(0);
      }
    }),
  );
}

export async function writeEncryptedRegistry(
  path: string,
  projectId: string,
  passphrase: Buffer,
  value: unknown,
  expectedRevision: string,
  beforeCommit?: CommitHook,
  afterCommit?: CommitHook,
): Promise<void> {
  let plaintext: Buffer | undefined;
  let secret: Buffer | undefined;
  try {
    validateRegistryInput(projectId, passphrase);
    secret = Buffer.from(passphrase);
    plaintext = registryJson(value);
    await replaceRegistry(
      path,
      projectId,
      secret,
      secret,
      expectedRevision,
      plaintext,
      beforeCommit,
      afterCommit,
    );
  } catch {
    throw encryptedRegistryFailure();
  } finally {
    plaintext?.fill(0);
    secret?.fill(0);
  }
}

export async function rekeyEncryptedRegistry(
  path: string,
  projectId: string,
  oldPassphrase: Buffer,
  newPassphrase: Buffer,
  expectedRevision: string,
  beforeCommit?: CommitHook,
  afterCommit?: CommitHook,
): Promise<void> {
  let previous: Buffer | undefined;
  let next: Buffer | undefined;
  try {
    validateRegistryInput(projectId, oldPassphrase);
    validateRegistryInput(projectId, newPassphrase);
    previous = Buffer.from(oldPassphrase);
    next = Buffer.from(newPassphrase);
    await replaceRegistry(
      path,
      projectId,
      previous,
      next,
      expectedRevision,
      undefined,
      beforeCommit,
      afterCommit,
    );
  } catch {
    throw encryptedRegistryFailure();
  } finally {
    previous?.fill(0);
    next?.fill(0);
  }
}
