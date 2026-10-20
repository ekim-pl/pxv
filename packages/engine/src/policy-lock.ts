import { parseDocument, verifyResolvedPolicy } from '@pxv/contracts';
import { readBounded } from '@pxv/runtime';
import { containedPath, assertProjectFresh, type ProjectContext } from './project.js';

export type PolicyLockStatus = 'current' | 'missing' | 'stale' | 'invalid';

/** A lock approves normalized semantics, including the executable identity, rather than JSON layout. */
export async function policyLockStatus(project: ProjectContext): Promise<PolicyLockStatus> {
  try {
    const path = await containedPath(project.root, 'policy.lock.json');
    const limit = Buffer.byteLength(JSON.stringify(project.resolved, null, 2)) + 64 * 1024;
    const value = verifyResolvedPolicy(parseDocument((await readBounded(path, limit)).toString('utf8')));
    return value.digest === project.resolved.digest ? 'current' : 'stale';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

export async function assertPolicyLocked(project: ProjectContext): Promise<void> {
  const status = await policyLockStatus(project);
  if (status !== 'current')
    throw new Error(
      `Policy lock is ${status}; run policy validate and explicitly renew policy lock before planning or continuing reviewed work`,
    );
}

/** Preparation rechecks both the loaded source revisions and the approved baseline. */
export async function assertApprovedProject(project: ProjectContext): Promise<void> {
  await assertProjectFresh(project);
  await assertPolicyLocked(project);
}
