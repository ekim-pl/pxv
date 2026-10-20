import {
  resolveSelection,
  type SelectedTarget,
  type TargetSelector,
  type Transport,
  type Inventory,
} from '@pxv/contracts';
import type { ProjectContext } from '@pxv/engine';
import type { CliContext, ProjectCliContext } from './arguments.js';
export function selectedContext(context: CliContext, project: ProjectContext): ProjectCliContext {
  return { ...context, project, targets: () => selectedTargets(context, project.inventory) };
}

export function selectedTargets(context: CliContext, inventory: Inventory): SelectedTarget[] {
  const { flag, values, value } = context;
  const selectors = [flag('all'), values['asset'] !== undefined, values['group'] !== undefined];
  const selector: TargetSelector = flag('all')
    ? { kind: 'fleet' }
    : values['group']
      ? { kind: 'group', group: value('group') }
      : { kind: 'asset', assetId: value('asset', '') };
  const transport = typeof values['transport'] === 'string' ? value('transport') : undefined;
  if (transport && !['usb', 'wifi', 'emulator'].includes(transport)) throw new Error('Invalid transport');

  if (selectors.filter(Boolean).length > 1)
    throw new Error('Choose one exact asset, group or explicit fleet selector');
  return resolveSelection(inventory, selector, transport as Transport['kind'] | undefined);
}
