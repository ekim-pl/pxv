import {
  assertProjectFresh,
  beginRegistryCommit,
  finishRegistryCommit,
  type RegistryAnchor,
} from '@pxv/engine';
import type { Store } from '@pxv/runtime';
import type { ProjectCliContext } from './arguments.js';

export function registryCommitHooks(
  context: ProjectCliContext,
  store: Store,
  expected: RegistryAnchor | undefined,
  guard?: () => Promise<void>,
): readonly [(hash: string) => Promise<void>, (hash: string) => Promise<void>] {
  let pending: RegistryAnchor | undefined;
  return [
    async (hash) => {
      await assertProjectFresh(context.project);
      await guard?.();
      pending = await beginRegistryCommit(store, context.project.config.id, expected, hash);
    },
    async (hash) => {
      if (!pending || pending.ciphertextRevision !== hash)
        throw new Error('Registry commit requires inspection');
      await finishRegistryCommit(store, context.project.config.id, pending);
    },
  ];
}
