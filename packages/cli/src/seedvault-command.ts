import { assertCommandFeature } from './command-registry.js';
import { SeedvaultConnectionAdapter, seedvaultEndpoint } from '@pxv/adapters';
import {
  parseDocument,
  validateSeedvaultAdapter,
  validateSeedvaultRequest,
  type SelectedTarget,
} from '@pxv/contracts';
import { connectSeedvaultEndpoint, seedvaultConnections, type SeedvaultConnectionRequest } from '@pxv/engine';
import { readBounded } from '@pxv/runtime';
import { dirname, resolve } from 'node:path';
import { stdin, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { confirmation, type ApplicationCliContext } from './arguments.js';
import { runExitCode } from './device-command.js';

function exactTarget(context: ApplicationCliContext): SelectedTarget {
  if (context.flag('all') || context.values['group']) throw new Error('Seedvault requires one exact device');
  const selected = context.targets();
  if (selected.length !== 1 || !selected[0]) throw new Error('Seedvault requires one enrolled device');
  return selected[0];
}

async function document(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = parseDocument((await readBounded(path, 2 * 1024 * 1024)).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Expected a Seedvault JSON object');
  return parsed as Record<string, unknown>;
}

async function request(context: ApplicationCliContext, operation: 'backup' | 'restore') {
  const input = context.values['file'] ? await document(context.value('file')) : {};
  if (input['operation'] !== undefined && input['operation'] !== operation)
    throw new Error('Seedvault request operation differs from the selected command');
  if (context.values['seedvault-adapter']) {
    const path = resolve(context.value('seedvault-adapter'));
    const adapter = validateSeedvaultAdapter(await document(path));
    input['adapter'] = {
      ...adapter,
      acceptance: { ...adapter.acceptance, path: resolve(dirname(path), adapter.acceptance.path) },
    };
  }
  return validateSeedvaultRequest({ ...input, operation });
}

async function pairingCode(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Pair privately in a terminal before connecting wireless ADB');
  const terminal = createInterface({ input: stdin, output: stderr });
  try {
    return (await terminal.question('Wireless debugging pairing code (six digits, never saved): ')).trim();
  } finally {
    terminal.close();
  }
}

function connectionInput(context: ApplicationCliContext, target: SelectedTarget): SeedvaultConnectionRequest {
  const endpoint = seedvaultEndpoint(context.value('endpoint'));
  if (context.value('serial', target.device.canonicalSerial) !== target.device.canonicalSerial)
    throw new Error('Wireless canonical serial differs from the enrolled phone');
  const input: SeedvaultConnectionRequest = { endpoint, disconnect: context.command === 'disconnect' };
  if (context.values['pair-endpoint']) input.pairEndpoint = seedvaultEndpoint(context.value('pair-endpoint'));
  if (context.values['run']) input.recoverOperationId = context.value('run');
  if (input.disconnect && input.pairEndpoint) throw new Error('Disconnect cannot pair an endpoint');
  if (input.recoverOperationId && (!input.disconnect || !context.flag('inspected')))
    throw new Error('Connection recovery requires disconnect --run ID --inspected');
  return input;
}
async function connection(context: ApplicationCliContext, target: SelectedTarget): Promise<number> {
  const input = connectionInput(context, target);
  const { endpoint, pairEndpoint } = input;
  if (context.flag('dry-run')) {
    context.output({ action: context.command, assetId: target.device.assetId, endpoint, pairEndpoint });
    return 0;
  }
  await confirmation(
    context.io,
    `${context.command ?? 'connect'} TLS wireless ADB ${endpoint} for ${target.device.assetId}?`,
    context.flag('yes'),
  );
  const code = pairEndpoint ? await pairingCode() : undefined;
  context.output(
    await connectSeedvaultEndpoint(
      context.project,
      target,
      {
        ...input,
        ...(code ? { pairingCode: code } : {}),
      },
      new SeedvaultConnectionAdapter(context.app.android),
      context.app.engine.controlRoot,
      context.app.store,
      context.signal,
    ),
  );
  return 0;
}

async function executeSeedvault(
  context: ApplicationCliContext,
  command: 'backup' | 'restore',
  target: SelectedTarget,
): Promise<number> {
  const { app, value, output, signal } = context;
  const prepared = await app.engine.prepareSeedvault(target, await request(context, command), signal);
  output({ planId: prepared.plan.id, reviewSummary: prepared.reviewSummary, expiresAt: prepared.expiresAt });
  if (context.flag('dry-run')) return 0;
  await confirmation(
    context.io,
    'Execute the exact reviewed Seedvault operation for every listed profile?',
    context.flag('yes'),
  );
  const run = await app.engine.submit(
    prepared.plan.id,
    prepared.reviewSummary,
    value('operator', process.env['USER'] ?? 'owner'),
  );
  const result = await app.engine.execute(run.id, signal);
  output(result);
  return runExitCode([result]);
}

export async function seedvaultCommand(context: ApplicationCliContext): Promise<number> {
  const { command, app, value, output, signal } = context;
  assertCommandFeature(['seedvault', String(context.command)], context.product);
  if (command === 'report') {
    output(await app.engine.seedvaultReport(value('run')));
    return 0;
  }
  if (!['inspect', 'backup', 'restore', 'connect', 'disconnect', 'connections'].includes(command ?? ''))
    throw new Error('Choose seedvault inspect, backup, restore, report, connections, connect or disconnect');
  const target = exactTarget(context);
  if (command === 'connections') {
    output(await seedvaultConnections(app.store, target));
    return 0;
  }
  if (command === 'connect' || command === 'disconnect') return connection(context, target);
  if (command === 'inspect') {
    output(await app.engine.inspectSeedvault(target, signal));
    return 0;
  }
  if (command !== 'backup' && command !== 'restore') throw new Error('Unknown Seedvault operation');
  return executeSeedvault(context, command, target);
}
