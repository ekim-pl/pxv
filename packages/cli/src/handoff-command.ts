import { recordLifecycle } from '@pxv/engine';
import { writeHandoff } from '@pxv/guides';
import { resolve } from 'node:path';
import type { ApplicationCliContext } from './arguments.js';
import { confirmation } from './arguments.js';

export async function lifecycleCommand(context: ApplicationCliContext): Promise<number> {
  const { io, value, flag, output, command } = context;
  const { project } = context;
  const { app } = context;

  if (!['maintenance', 'policy-change', 'loss', 'retirement'].includes(command ?? ''))
    throw new Error('Unknown lifecycle operation');
  await confirmation(io, `Record ${command} and invalidate previous handoff evidence?`, flag('yes'));
  output(
    await recordLifecycle(
      project,
      app.store,
      {
        assetId: value('asset'),
        type: command as 'maintenance' | 'policy-change' | 'loss' | 'retirement',
        operator: value('operator'),
        note: value('note'),
        confirmedErasure: flag('erased'),
      },
      undefined,
      app.engine.controlRoot,
    ),
  );
  return 0;
}
export async function handoffCommand(context: ApplicationCliContext): Promise<number | undefined> {
  const { io, value, flag, output, command } = context;

  const { app } = context;

  if (command === 'export') {
    const { record, snapshot } = await app.engine.acceptedHandoff(value('asset'));
    const locale = value('locale', record.locale);
    if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
    output(
      await writeHandoff(
        {
          product: snapshot.resolvedPolicy.product,
          policy: snapshot.resolvedPolicy.policy,
          resolvedPolicy: snapshot.resolvedPolicy,
          record,
          assetId: snapshot.assetId,
        },
        resolve(value('output')),
        { locale },
      ),
    );
    return 0;
  }
  if (command === 'accept') {
    await confirmation(
      io,
      'Confirm both debugging toggles are physically off and transfer recipient custody?',
      flag('yes'),
    );
    output(await app.engine.acceptCustody(value('asset'), value('recipient'), flag('debugging-off')));
    return 0;
  }
  return undefined;
}
