import type { SelectedTarget } from '@pxv/contracts';
import type { ApplicationCliContext } from './arguments.js';
import { collectCommand } from './collect-command.js';

/** Existing programmatic entry point, using the shared collection orchestration. */
export function collectOblivionCommand(
  context: ApplicationCliContext,
  target: SelectedTarget,
): Promise<number> {
  return collectCommand({ ...context, command: 'collect-oblivion' }, target);
}
