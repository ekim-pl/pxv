import { extname } from 'node:path';
import { assetLabelMonth, writeAssetLabel } from '@pxv/guides';
import type { ProjectCliContext } from './arguments.js';
import { registryOutputPath } from './registry-output.js';

export async function exportInventoryLabel(context: ProjectCliContext): Promise<void> {
  if (context.dockerMode || context.value('execution', 'host') !== 'host')
    throw new Error('Asset label export requires local host execution');
  if (context.flag('all') || context.values['group'] !== undefined)
    throw new Error('Asset label export requires one exact --asset');
  const device = context.project.inventory.devices.find((entry) => entry.assetId === context.value('asset'));
  if (!device) throw new Error('Label asset is not enrolled');
  const locale = context.value('locale', 'en');
  if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
  const output = registryOutputPath(context);
  if (extname(output)) throw new Error('Label output must be an extensionless basename');
  const month = assetLabelMonth(context.values['date'] === undefined ? undefined : context.value('date'));
  await writeAssetLabel({ assetId: device.assetId, canonicalSerial: device.canonicalSerial, month }, output, {
    locale,
    chromiumExecutable: context.value('chromium'),
    pdftoppmExecutable: context.value('pdftoppm', 'pdftoppm'),
  });
  context.output({
    exported: true,
    assetId: device.assetId,
    month,
    pdf: output + '.pdf',
    png: output + '.png',
  });
}
