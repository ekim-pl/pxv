import { runExitCode } from './device-command.js';
import {
  ownedWorkerClaim,
  recordWorkerFailure,
  releaseWorkerClaim,
  type RunRecord,
  type WorkerLaunchClaim,
} from '@pxv/engine';
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
function workerExitCode(status: RunRecord['status']): number {
  return status === 'completed' ? 0 : status === 'pending' ? 4 : 3;
}
export async function internalWorker(context: ApplicationCliContext): Promise<number> {
  const { value } = context;

  const { app, signal } = context;
  const runId = value('run');
  let expected: RunRecord | undefined;
  let claim: WorkerLaunchClaim | undefined;
  let exit = 3;
  const errors: unknown[] = [];
  try {
    claim = await ownedWorkerClaim(app.store, runId, process.env['PXV_WORKER_ATTEMPT']);
    expected = await app.store.get<RunRecord>('runs', runId);
    process.send?.({ type: 'ready', runId });
    if (process.connected) process.disconnect();
    const run = await app.engine.execute(runId, signal);
    exit = workerExitCode(run.status);
  } catch (error) {
    errors.push(error);
    try {
      await recordWorkerFailure(
        app.store,
        expected,
        claim,
        'Worker stopped; inspect retained evidence before another review',
      );
    } catch (secondary) {
      errors.push(secondary);
    }
  } finally {
    try {
      if (process.env['NODE_V8_COVERAGE']) takeCoverage();
    } catch (secondary) {
      errors.push(secondary);
    }
    try {
      await releaseWorkerClaim(app.store, runId, claim);
    } catch (secondary) {
      errors.push(secondary);
    }
  }
  if (errors.length > 1)
    throw new AggregateError(errors, 'Worker stopped; secondary evidence or cleanup failure');
  if (errors.length) throw errors[0];
  return exit;
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
