import { resolveSelection, type SelectedTarget, type TargetSelector, type Transport } from '@pxv/contracts';
import type { ProjectContext } from '@pxv/engine';
import type { CliContext, ProjectCliContext } from './arguments.js';
export function selectedContext(context: CliContext, project: ProjectContext): ProjectCliContext {
  const { flag, values, value } = context;
  const selectors = [flag('all'), values['asset'] !== undefined, values['group'] !== undefined];
  const selector: TargetSelector = flag('all')
    ? { kind: 'fleet' }
    : values['group']
      ? { kind: 'group', group: value('group') }
      : { kind: 'asset', assetId: value('asset', '') };
  const transport = typeof values['transport'] === 'string' ? value('transport') : undefined;
  if (transport && !['usb', 'wifi', 'emulator'].includes(transport)) throw new Error('Invalid transport');
  const targets = (): SelectedTarget[] => {
    if (selectors.filter(Boolean).length > 1)
      throw new Error('Choose one exact asset, group or explicit fleet selector');
    return resolveSelection(project.inventory, selector, transport as Transport['kind'] | undefined);
  };

  return { ...context, project, targets };
}
