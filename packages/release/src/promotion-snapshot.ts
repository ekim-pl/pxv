import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { releaseFailure } from './errors.js';

async function copyRegular(source: string, destination: string, limit = Number.MAX_SAFE_INTEGER) {
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit)
      throw new Error('Promotion input must be a bounded regular file');
    await pipeline(
      file.createReadStream({ autoClose: false, end: before.size }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('Promotion input changed while copying');
    await chmod(destination, 0o400);
  } finally {
    await file.close();
  }
}
/** Publication reads only this private copy; the caller authenticates all copied bytes. */
export async function withPromotionSnapshot<T>(
  directory: string,
  packageFile: string,
  action: (snapshot: string) => Promise<T>,
): Promise<T> {
  const snapshot = await mkdtemp(join(tmpdir(), 'pxv-promotion-'));
  let failure: { error: unknown } | undefined;
  try {
    for (const name of ['SHA256SUMS', 'provenance.json', 'SHA256SUMS.sig'])
      await copyRegular(join(directory, name), join(snapshot, name), name.endsWith('.sig') ? 16384 : 1048576);
    await copyRegular(packageFile, join(snapshot, basename(packageFile)));
    return await action(snapshot);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      await rm(snapshot, { recursive: true });
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure.error, error],
          `${releaseFailure(failure.error, 'Promotion failed')}; snapshot cleanup failed: ${releaseFailure(error, 'Cleanup failed')}`,
          { cause: failure.error },
        );
      throw error;
    }
  }
}
