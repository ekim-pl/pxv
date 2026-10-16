import {
  canonicalJson,
  digest,
  parseDocument,
  validateSeedvaultAdapter,
  validateSeedvaultAcceptance,
  validateUserIdentity,
  type SeedvaultAdapterDefinition,
  type RecoveryObligation,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter, CleanupOptions } from './android.js';
import { AdapterError } from './command.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { foregroundUser } from './seedvault-inspection.js';
import { seedvaultQuiescent } from './seedvault-ui.js';

export async function cleanupSeedvault(
  android: AndroidAdapter,
  target: SelectedTarget,
  obligation: RecoveryObligation,
  options: CleanupOptions,
): Promise<void> {
  guardCleanupScope(target, obligation, options);
  if (!obligation.user) throw new AdapterError('Seedvault cleanup needs its stable Android user');
  await android.guardUser(target, obligation.user, options.signal);
  if (obligation.kind === 'seedvault-job') {
    const adapter = validateSeedvaultAdapter(obligation.payload['adapter']);
    const operation = obligation.payload['operation'];
    if (operation !== 'backup' && operation !== 'restore')
      throw new AdapterError('Invalid Seedvault job obligation');
    await verifySeedvaultAcceptance(adapter, options.signal);
    await seedvaultQuiescent(android, target, obligation.user, adapter, operation, options.signal);
    return;
  }
  if (obligation.kind !== 'seedvault-foreground')
    throw new AdapterError('Unknown Seedvault cleanup capability');
  const previous = validateUserIdentity(obligation.payload['previousForeground']);
  await android.guardUser(target, previous, options.signal);
  if ((await foregroundUser(android, target, options.signal)) !== previous.userId)
    await android.shell(target, ['am', 'switch-user', String(previous.userId)], {
      ...options,
      mutation: true,
    });
  await android.guardUser(target, previous, options.signal);
  if ((await foregroundUser(android, target, options.signal)) !== previous.userId)
    throw new AdapterError('Previous Android foreground user was not restored');
}
function guardCleanupScope(
  target: SelectedTarget,
  obligation: RecoveryObligation,
  options: CleanupOptions,
): void {
  if (
    obligation.deviceSerial !== target.device.canonicalSerial ||
    obligation.ownerOperationId !== options.operationId ||
    !['pending', 'blocked'].includes(obligation.status)
  )
    throw new AdapterError('Seedvault cleanup is outside the recorded operation scope');
}
export async function verifySeedvaultAcceptance(
  definition: SeedvaultAdapterDefinition,
  signal?: AbortSignal,
): Promise<void> {
  const { acceptance: location, ...recipe } = definition;
  const bytes = await acceptanceBytes(location.path, signal);
  if (createHash('sha256').update(bytes).digest('hex') !== location.sha256)
    throw new AdapterError('Seedvault UI acceptance evidence changed');
  const acceptance = validateSeedvaultAcceptance(parseDocument(bytes.toString('utf8')));
  if (
    acceptance.adapterId !== definition.id ||
    acceptance.buildFingerprint !== definition.buildFingerprint ||
    canonicalJson(acceptance.package) !== canonicalJson(definition.package) ||
    acceptance.recipeDigest !== digest(recipe)
  )
    throw new AdapterError('Seedvault acceptance does not qualify this exact recipe, build and package');
}
async function acceptanceBytes(path: string, signal?: AbortSignal): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 * 1024)
      throw new AdapterError('Seedvault acceptance must be a bounded regular file');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new AdapterError('Seedvault acceptance exceeds its byte limit');
      chunks.push(bytes);
    }
    if (size !== stat.size) throw new AdapterError('Seedvault acceptance changed while reading');
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
