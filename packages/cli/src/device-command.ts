import type { EmulatorImagePin } from '@pxv/adapters';
import { parseDocument, type SelectedTarget } from '@pxv/contracts';
import type { Operation, PreparedOperation, RunRecord } from '@pxv/engine';
import { hostControlRoot, readBounded, recoveryReservations } from '@pxv/runtime';
import type { ApplicationCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { guidedNextSteps, renderProjectGuide } from './guided.js';

function selectedTargets(context: ApplicationCliContext): SelectedTarget[] {
  if (context.section !== 'device' && context.section !== 'fleet')
    throw new Error('Unknown command; use --help');
  const selected = context.targets();
  if (context.section === 'device' && selected.length !== 1)
    throw new Error('Device commands require exactly one asset');
  if (!selected[0]) throw new Error('No enrolled targets');
  return selected;
}
async function observationCommand(
  context: ApplicationCliContext,
  selected: SelectedTarget[],
): Promise<number | undefined> {
  if (context.command === 'inspect') {
    context.output(await context.app.engine.observe(selected[0]!));
    return 0;
  }
  if (context.command === 'report') {
    context.output(
      await Promise.all(
        selected.map(async (item) => ({
          assetId: item.device.assetId,
          ...(await context.app.engine.readiness(item)),
          currentStateVerified: false,
        })),
      ),
    );
    return 0;
  }
  return undefined;
}
async function attest(context: ApplicationCliContext, target: SelectedTarget): Promise<number> {
  const { io, value, flag, output, app, values } = context;
  await confirmation(io, `Confirm the named check was actually performed: ${value('check')}`, flag('yes'));
  const evidence =
    value('check') === 'emulator_image_provenance'
      ? (parseDocument(
          (await readBounded(value('evidence'), 1024 * 1024)).toString('utf8'),
        ) as EmulatorImagePin)
      : undefined;
  output(
    await app.engine.attest(
      target,
      value('check'),
      value('operator'),
      typeof values['note'] === 'string' ? value('note') : undefined,
      evidence,
    ),
  );
  return 0;
}
async function finalize(context: ApplicationCliContext, target: SelectedTarget): Promise<number> {
  const { io, value, flag, output, app } = context;
  await confirmation(io, 'Disable debugging after fresh full-device signoff?', flag('yes'));
  const locale = value('locale', 'en');
  if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
  output(await app.engine.finalize(target, value('operator'), locale));
  return 0;
}
async function recover(context: ApplicationCliContext, target: SelectedTarget): Promise<number> {
  const { io, value, flag, output, app, signal } = context;
  const reservations = await recoveryReservations(hostControlRoot());
  if (!flag('inspected')) {
    output({
      reservations,
      instructions:
        'Inspect the affected phone and owned cleanup before explicit --inspected --run OPERATION_ID --yes',
    });
    return 4;
  }
  await confirmation(io, 'Confirm physical inspection and all owned cleanup are complete?', flag('yes'));
  await app.engine.recover(target, value('run'), signal);
  output({ recoveryAcknowledged: true });
  return 0;
}
function operationFor(command: string | undefined): Operation {
  const operations = new Map<string, Operation>([
    ['create-users', 'create-users'],
    ['deploy', 'deploy-apps'],
    ['install-os', 'install-os'],
    ['provision', 'provision'],
    ['plan', 'provision'],
    ['guided', 'provision'],
  ]);
  const operation = command === undefined ? undefined : operations.get(command);
  if (!operation) throw new Error('Unknown device workflow');
  return operation;
}
export function runExitCode(runs: Pick<RunRecord, 'status'>[]): number {
  if (runs.some((run) => ['failed', 'needs-inspection'].includes(run.status))) return 3;
  if (runs.some((run) => run.status === 'cancelled')) return 130;
  return runs.some((run) => run.status === 'pending') ? 4 : 0;
}
async function preparePlans(
  context: ApplicationCliContext,
  selected: SelectedTarget[],
  operation: Operation,
): Promise<PreparedOperation[]> {
  const plans: PreparedOperation[] = [];
  for (const item of selected) {
    const prepared = await context.app.engine.prepare(item, operation, context.signal);
    plans.push(prepared);
    context.output({
      assetId: item.device.assetId,
      planId: prepared.plan.id,
      reviewSummary: prepared.reviewSummary,
      expiresAt: prepared.expiresAt,
    });
  }
  return plans;
}
function showResults(
  context: ApplicationCliContext,
  selected: SelectedTarget[],
  results: RunRecord[],
  locale: 'en' | 'pl',
): void {
  const next =
    context.command === 'guided'
      ? {
          next: results.map((run, index) => ({
            runId: run.id,
            steps: guidedNextSteps(
              context.product,
              run,
              locale,
              context.projectRoot,
              selected[index]?.device.assetId ?? '',
            ),
          })),
        }
      : {};
  context.output({ runs: results, ...next });
}
async function provision(context: ApplicationCliContext, selected: SelectedTarget[]): Promise<number> {
  const { value, command, flag, app, signal, io, product, project } = context;
  const { operation, jobs, locale } = provisionOptions(context);
  if (command === 'guided')
    io.out(renderProjectGuide(product, project.policy, selected[0]!.device.kind, locale));
  const plans = await preparePlans(context, selected, operation);
  if (command === 'plan' || flag('dry-run')) return 0;
  await confirmation(
    io,
    operation === 'install-os'
      ? 'DESTRUCTIVE: erase and install the reviewed phones? Attend unlock/relock prompts.'
      : 'Execute the exact reviewed changes?',
    flag('yes'),
  );
  const runs = [];
  for (const plan of plans)
    runs.push(
      await app.engine.submit(
        plan.plan.id,
        plan.reviewSummary,
        value('operator', process.env['USER'] ?? 'operator'),
      ),
    );
  const results = await app.engine.executeFleet(
    runs.map((run) => run.id),
    jobs,
    signal,
  );
  showResults(context, selected, results, locale);
  return runExitCode(results);
}
export async function deviceCommand(context: ApplicationCliContext): Promise<number> {
  const selected = selectedTargets(context);
  const observed = await observationCommand(context, selected);
  if (observed !== undefined) return observed;
  const target = selected[0]!;
  if (context.command === 'attest') return attest(context, target);
  if (context.command === 'finalize') return finalize(context, target);
  if (context.command === 'recover') return recover(context, target);
  return provision(context, selected);
}

function provisionOptions(context: ApplicationCliContext): {
  operation: Operation;
  jobs: number;
  locale: 'en' | 'pl';
} {
  const { command, value } = context;
  const operation = operationFor(command);
  const jobs = Number(value('jobs', '2'));
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('jobs must be 1–8');
  const locale = value('locale', 'en');
  if (locale !== 'en' && locale !== 'pl') throw new Error('Guide locale must be en or pl');

  return { operation, jobs, locale };
}
