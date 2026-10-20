import { lstat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { containedPath } from '@pxv/engine';

/** Resolve approved mount aliases at access time, leaving reviewed evidence unchanged. */
export async function retainedHelperPath(root: string, path: string): Promise<string> {
  assertRetainedPath(path);
  let local = relative(root, path);
  if (!local.startsWith('state/plans/') && path.startsWith('/project/state/plans/')) {
    await verifyProjectAlias(root);
    local = path.slice('/project/'.length);
  }
  if (!local.startsWith('state/plans/'))
    throw new Error('Recovery helper must belong to the retained reviewed plan');
  return containedPath(root, local);
}
function assertRetainedPath(path: string): void {
  if (
    !isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Recovery helper path is unsafe');
}
async function verifyProjectAlias(root: string): Promise<void> {
  if (!['direct', 'host-adb'].includes(process.env['PXV_DOCKER_MODE'] ?? ''))
    throw new Error('Recovery project alias requires a verified Docker mount');
  const [project, alias] = await Promise.all([lstat(root), lstat('/project')]);
  if (
    !alias.isDirectory() ||
    alias.isSymbolicLink() ||
    project.dev !== alias.dev ||
    project.ino !== alias.ino
  )
    throw new Error('Recovery project alias differs from the selected project');
}
