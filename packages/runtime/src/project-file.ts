import { randomUUID } from 'node:crypto';
import { hostControlRoot, withDeviceLease } from './commands.js';
import { atomicWritePrivate, hashFile } from './files.js';

function withProjectLease<T>(controlRoot: string, projectId: string, action: () => Promise<T>): Promise<T> {
  return withDeviceLease(
    controlRoot,
    `project-${projectId}`,
    `project-${projectId}`,
    `${randomUUID()}-project`,
    action,
  );
}
export interface ProjectFileCommit {
  signal?: AbortSignal;
  controlRoot?: string;
  projectId: string;
  path: string;
  expectedSha256: string | undefined;
  expectedSources?: readonly { path: string; sha256: string }[];
  data: string | Uint8Array;
}
async function revision(path: string): Promise<string | undefined> {
  try {
    return await hashFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function commitProjectFile(input: ProjectFileCommit): Promise<void> {
  input.signal?.throwIfAborted();
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedSha256))
    throw new Error('Invalid expected project file revision');
  for (const source of input.expectedSources ?? [])
    if (!/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error('Invalid expected source revision');
  await withProjectLease(input.controlRoot ?? hostControlRoot(), input.projectId, async () => {
    if ((await revision(input.path)) !== input.expectedSha256)
      throw new Error('Project file changed; reload and review before writing');
    for (const source of input.expectedSources ?? [])
      if ((await revision(source.path)) !== source.sha256)
        throw new Error('Project source changed; reload and review before writing');
    await atomicWritePrivate(input.path, input.data, input.signal);
  });
}
