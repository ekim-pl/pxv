import { AndroidAdapter, HostTools } from '@pxv/adapters';
import { parseDocument, resolveSelection, validateInventory, type SelectedTarget } from '@pxv/contracts';
import { saveInventory } from '@pxv/engine';
import { CommandRunner } from '@pxv/runtime';
import { readFile } from 'node:fs/promises';
import type { ProjectCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { exportInventoryLabel } from './inventory-label.js';

async function checkFastboot(
  context: ProjectCliContext,
  kind: string,
  transport: string,
  runner: CommandRunner,
  tools: HostTools,
): Promise<void> {
  const { value } = context;

  if (kind !== 'pixel' || transport !== 'usb') throw new Error('Fastboot enrollment requires a USB Pixel');
  const tool = await tools.require('fastboot');
  const discovered = await runner.run([tool, 'devices']);
  if (
    discovered.stdout
      .split('\n')
      .filter((line) => line.trim().split(/\s+/u)[0] === value('serial') && line.includes('fastboot'))
      .length !== 1
  )
    throw new Error('Exact fastboot serial is unavailable or ambiguous');
  const observed = await runner.run([tool, '-s', value('serial'), 'getvar', 'product']);
  const combined = `${observed.stdout}\n${observed.stderr}`;
  const codename = /(?:^|\n)(?:\(bootloader\)\s*)?product:\s*([a-z0-9_]+)/u.exec(combined)?.[1];
  if (codename !== value('codename')) throw new Error('Fastboot product differs from enrollment');
}
async function verifyEnrollment(
  context: ProjectCliContext,
  kind: string,
  transport: string,
  selected: SelectedTarget,
): Promise<void> {
  const { value } = context;
  const runner = new CommandRunner();
  const tools = new HostTools({ runner });
  const mode = value('mode', 'adb');
  if (mode === 'fastboot') await checkFastboot(context, kind, transport, runner, tools);
  else if (mode === 'adb')
    await new AndroidAdapter({ runner, adb: (await tools.discover('adb')) ?? 'adb' }).guardTarget(selected);
  else throw new Error('Enrollment mode must be adb or fastboot');
}
async function enroll(context: ProjectCliContext): Promise<number> {
  const { io, values, value, flag, output } = context;
  const { project } = context;
  const kind = value('kind', 'pixel');
  if (kind !== 'pixel' && kind !== 'emulator') throw new Error('Device kind must be pixel or emulator');
  const transport = value('transport', kind === 'emulator' ? 'emulator' : 'usb');
  if (transport !== 'usb' && transport !== 'emulator')
    throw new Error('First enrollment requires USB or a dedicated emulator');
  const inventory = validateInventory({
    schemaVersion: 1,
    devices: [
      ...project.inventory.devices,
      {
        assetId: value('asset'),
        kind,
        canonicalSerial: value('serial'),
        model: value('model'),
        codename: value('codename'),
        groups: values['group'] ? [value('group')] : [],
        transports: [{ kind: transport, serial: value('serial') }],
      },
    ],
  });
  await confirmation(
    io,
    'Confirm the physical asset label and observed serial/model match this enrollment?',
    flag('yes'),
  );
  const selected = resolveSelection(inventory, { kind: 'asset', assetId: value('asset') })[0];
  if (!selected) throw new Error('Enrollment target missing');
  await verifyEnrollment(context, kind, transport, selected);
  await saveInventory(project, inventory);
  output({ enrolled: value('asset') });
  return 0;
}
export async function inventoryCommand(context: ProjectCliContext): Promise<number> {
  const { io, value, flag, output, command } = context;
  const { project } = context;
  if (command === 'list') {
    output(project.inventory);
    return 0;
  }
  if (command === 'enroll') return await enroll(context);
  if (command === 'print-label') {
    await exportInventoryLabel(context);
    return 0;
  }
  if (command === 'import') {
    await confirmation(io, 'Import reviewed enrollment data?', flag('yes'));
    await saveInventory(project, validateInventory(parseDocument(await readFile(value('file'), 'utf8'))));
    output({ imported: true });
    return 0;
  }
  throw new Error('Unknown inventory command');
}
