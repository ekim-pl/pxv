import { runExitCode } from './device-command.js';
import { type RunRecord } from '@pxv/engine';
import { readBounded } from '@pxv/runtime';
import { takeCoverage } from 'node:v8';
import type { ApplicationCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { agentBackend } from './backend.js';

function runListOptions(context: ApplicationCliContext) {
  return {
    ...(context.values['cursor'] !== undefined ? { cursor: context.value('cursor') } : {}),
    ...(context.values['limit'] !== undefined ? { limit: Number(context.value('limit')) } : {}),
  };
}
export async function internalWorker(context: ApplicationCliContext): Promise<number> {
  const { value } = context;

  const { app, signal } = context;
  const runId = value('run');
  process.send?.({ type: 'ready', runId });
  if (process.connected) process.disconnect();
  try {
    const run = await app.engine.execute(runId, signal);
    return run.status === 'completed' ? 0 : run.status === 'pending' ? 4 : 3;
  } catch (error) {
    const prior = await app.store.get<RunRecord>('runs', runId);
    if (prior)
      await app.store.set('runs', runId, {
        ...prior,
        status: 'needs-inspection',
        error: 'Worker stopped; inspect retained evidence before another review',
      });
    throw error;
  } finally {
    if (process.env['NODE_V8_COVERAGE']) takeCoverage();
    await app.store.delete('worker-launch', runId);
  }
}
export async function agentCommand(context: ApplicationCliContext): Promise<number> {
  const { io, value, flag, output, command } = context;

  const { app, signal } = context;

  if (command === 'refresh') {
    const prepared = await app.engine.refreshReview(value('run'), signal);
    output({
      planId: prepared.plan.id,
      reviewSummary: prepared.reviewSummary,
      expiresAt: prepared.expiresAt,
      ...('capabilities' in prepared && prepared.capabilities ? { capabilities: prepared.capabilities } : {}),
    });
    return 0;
  }
  if (command === 'runs') {
    output(await app.engine.listRuns(runListOptions(context)));
    return 0;
  }
  if (command === 'status') {
    const cursor = Number(value('after', '0'));
    output(await app.engine.runStatus(value('run'), cursor));
    return 0;
  }
  if (command === 'cancel') {
    await app.engine.cancel(value('run'));
    output({ cancellationRequested: true });
    return 0;
  }
  if (command === 'resume') {
    await confirmation(
      io,
      'Resume the approved run after completing its explicit manual checkpoint?',
      flag('yes'),
    );
    const run = await app.engine.execute(value('run'), signal);
    output(await app.engine.describeRun(run));
    return runExitCode([run]);
  }
  if (command === 'execute') return executePlan(context);
  throw new Error('Unknown agent command');
}

async function executePlan(context: ApplicationCliContext): Promise<number> {
  const { value, app, signal, output, dockerMode, resources, launcher } = context;

  const summary = (await readBounded(value('review-file'), 8 * 1024 * 1024)).toString('utf8');
  if (dockerMode) {
    // An ephemeral Docker worker must own its run until completion or a
    // durable manual pause; detaching would orphan it when PID 1 exits.
    const submitted = await app.engine.submit(value('plan'), summary, value('operator'));
    const run = await app.engine.execute(submitted.id, signal);
    output(await app.engine.describeRun(run));
    return runExitCode([run]);
  }
  const run = await agentBackend(app.engine, resources, launcher, true).executePlan(
    value('plan'),
    summary,
    value('operator'),
  );
  output(run);
  return 0;
}
