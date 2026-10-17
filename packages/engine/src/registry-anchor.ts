import type { Store } from '@pxv/runtime';

export interface RegistryAnchor {
  schemaVersion: 1;
  ciphertextRevision: string;
  state: 'ready' | 'pending';
}
type AnchorReader = Pick<Store, 'get'>;
type AnchorStore = AnchorReader & Pick<Store, 'compareAndSet'>;
const collection = 'registry-anchor';
const hash = /^[a-f0-9]{64}$/u;
const failure = (): Error =>
  new Error('Encrypted registry differs from retained state; explicit restore reconciliation is required');

function anchor(value: unknown): RegistryAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'ciphertextRevision,schemaVersion,state' ||
    row['schemaVersion'] !== 1 ||
    typeof row['ciphertextRevision'] !== 'string' ||
    !hash.test(row['ciphertextRevision']) ||
    (row['state'] !== 'ready' && row['state'] !== 'pending')
  )
    throw failure();
  return value as RegistryAnchor;
}

/** Public rollback evidence only: no decrypted values, credential hashes or event payloads. */
export async function readRegistryAnchor(
  store: AnchorReader,
  projectId: string,
): Promise<RegistryAnchor | undefined> {
  const value = await store.get<unknown>(collection, projectId);
  return value === undefined ? undefined : anchor(value);
}

export async function assertRegistryAnchor(
  store: AnchorReader,
  projectId: string,
  fileRevision: string,
): Promise<void> {
  const retained = await readRegistryAnchor(store, projectId);
  if (!retained || retained.state !== 'ready' || retained.ciphertextRevision !== fileRevision)
    throw failure();
}

/** Call under project ownership before publishing ciphertext; interrupted commits stay closed. */
export async function beginRegistryCommit(
  store: AnchorStore,
  projectId: string,
  expected: RegistryAnchor | undefined,
  nextCiphertextRevision: string,
): Promise<RegistryAnchor> {
  if (expected !== undefined) anchor(expected);
  if (typeof nextCiphertextRevision !== 'string' || !hash.test(nextCiphertextRevision)) throw failure();
  const pending: RegistryAnchor = {
    schemaVersion: 1,
    ciphertextRevision: nextCiphertextRevision,
    state: 'pending',
  };
  if (!(await store.compareAndSet(collection, projectId, expected, pending))) throw failure();
  return pending;
}

/** Only the exact pending commit can become ready after the matching file publication. */
export async function finishRegistryCommit(
  store: AnchorStore,
  projectId: string,
  pending: RegistryAnchor,
): Promise<void> {
  const retained = anchor(pending);
  if (retained.state !== 'pending') throw failure();
  const ready: RegistryAnchor = { ...retained, state: 'ready' };
  if (!(await store.compareAndSet(collection, projectId, retained, ready))) throw failure();
}
