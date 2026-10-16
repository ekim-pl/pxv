import { resolveSelection, type SelectedTarget, type TargetSelector, type Transport } from '@pxv/contracts';
import type { ProjectContext } from '@pxv/engine';
import type { CliContext, ProjectCliContext } from './arguments.js';
export function selectedContext(context: CliContext, project: ProjectContext): ProjectCliContext {
  const { flag, values, value } = context;
  const selector: TargetSelector = flag('all')
    ? { kind: 'fleet' }
    : values['group']
      ? { kind: 'group', group: value('group') }
      : { kind: 'asset', assetId: value('asset', '') };
  if (flag('all') && (values['asset'] || values['group']))
    throw new Error('Choose one exact asset, group or explicit fleet selector');
  const transport = typeof values['transport'] === 'string' ? value('transport') : undefined;
  if (transport && !['usb', 'wifi', 'emulator'].includes(transport)) throw new Error('Invalid transport');
  const targets = (): SelectedTarget[] =>
    resolveSelection(project.inventory, selector, transport as Transport['kind'] | undefined);

  return { ...context, project, targets };
}
