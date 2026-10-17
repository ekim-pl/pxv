import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJson } from './personal-files.mjs';

/** @typedef {{bin:string,root:string,project:string,asset:string,operator:string,prompt:(question:string)=>Promise<string>,signal:AbortSignal,adapter?:any}} Session */
/** @returns {{ask:(question:string)=>Promise<string>,close:()=>void}} */
export function terminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.pause();
  return {
    ask: async (question) => {
      const answer = await input.question(question + '\n> ');
      input.pause();
      return answer;
    },
    close: () => input.close(),
  };
}
/** @param {Session} session @param {string[]} args @returns {Promise<{code:number,stdout:string,stderr:string}>} */
export async function invoke(session, args) {
  const full = [...args, '--json', '--resource-root', session.root, '--project-root', session.project];
  return new Promise((resolveResult, reject) => {
    const child = spawn(session.bin, full, {
      env: {
        ...process.env,
        PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':' + process.env['PATH'],
      },
      stdio: ['inherit', 'pipe', 'pipe'],
      signal: session.signal,
    });
    let stdout = '',
      stderr = '',
      size = 0;
    /** @param {string} kind @param {Buffer} chunk */
    const collect = (kind, chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        child.kill('SIGTERM');
        return;
      }
      if (kind === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect('out', chunk));
    child.stderr.on('data', (chunk) => collect('err', chunk));
    if (args.includes('--pair-endpoint')) child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code: code ?? 130, stdout, stderr }));
  });
}
/** @param {Session} session @param {string[]} args @returns {Promise<any>} */
export async function jsonCommand(session, args) {
  const result = await invoke(session, args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || 'PXV command failed: ' + args.slice(0, 2).join(' '));
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('PXV returned malformed JSON for ' + args.slice(0, 2).join(' '));
  }
}
/** @param {Session} session @param {string} question @param {string} [word] */
export async function checkpoint(session, question, word = 'done') {
  if ((await session.prompt(question + '\nType ' + word + ' to continue; anything else stops.')) !== word)
    throw new Error('Stopped at the physical checkpoint; retained project and backup files are unchanged');
}
/** @param {Session} session @param {any} prepared */
async function approve(session, prepared) {
  if (
    typeof prepared.planId !== 'string' ||
    typeof prepared.reviewSummary !== 'string' ||
    !Number.isFinite(Date.parse(prepared.expiresAt))
  )
    throw new Error('Malformed reviewed PXV plan');
  const folder = join(session.project, 'state/personal-recovery', randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await privateJson(join(folder, 'prepared.json'), prepared);
  const file = join(folder, 'review.txt');
  await writeFile(file, prepared.reviewSummary, { flag: 'wx', mode: 0o600 });
  process.stdout.write('\n' + prepared.reviewSummary + '\n');
  await checkpoint(
    session,
    'Review this exact plan, including the selected phone and destructive effects.',
    'EXECUTE',
  );
  const run = await jsonCommand(session, [
    'agent',
    'execute',
    '--plan',
    prepared.planId,
    '--review-file',
    file,
    '--operator',
    session.operator,
  ]);
  if (typeof run.id !== 'string') throw new Error('PXV did not return an exact run identity');
  return run.id;
}
/** @param {Session} session @param {string[]} args @param {'os'|'provision'|'seedvault'} kind */
export async function reviewedOperation(session, args, kind) {
  const prepared = await jsonCommand(session, [...args, '--dry-run']);
  const id = await approve(session, prepared);
  return monitor(session, id, kind);
}
/** @param {Session} session @param {string} id */
async function refresh(session, id) {
  const prepared = await jsonCommand(session, ['agent', 'refresh', '--run', id]);
  return approve(session, prepared);
}
/** @param {Session} session @param {any} run */
async function resumeCheckpoint(session, run) {
  const gate = run.manualGate;
  if (gate.startsWith('seedvault')) await showSeedvaultInstructions(session, run.id);
  await checkpoint(
    session,
    'Complete the phone checkpoint: ' +
      gate +
      '.\nUnlock only the intended profile; enter passwords and recovery words privately on the phone.',
  );
  if (!gate.startsWith('language:') && !gate.startsWith('seedvault'))
    await jsonCommand(session, [
      'device',
      'attest',
      '--asset',
      session.asset,
      '--check',
      gate,
      '--operator',
      session.operator,
      '--yes',
    ]);
  const result = await invoke(session, ['agent', 'resume', '--run', run.id, '--yes']);
  if (result.code && /Reviewed plan expired/u.test(result.stderr)) return refresh(session, run.id);
  if (result.code !== 0 && result.code !== 4)
    throw new Error(result.stderr.trim() || 'Resume failed; inspect the retained run');
  const updated = JSON.parse(result.stdout);
  if (['failed', 'needs-inspection', 'cancelled'].includes(updated.status))
    throw new Error('Run ' + run.id + ' requires inspection: ' + updated.status);
  return run.id;
}
/** @param {Session} session @param {string} id */
async function showSeedvaultInstructions(session, id) {
  const report = await jsonCommand(session, ['seedvault', 'report', '--run', id]);
  const profile = report.profiles[report.cursor];
  if (profile?.instructions) process.stdout.write(profile.instructions + '\n');
}
/** @param {any} status @param {'os'|'provision'|'seedvault'} kind */
export function terminalRun(status, kind) {
  const run = status.run;
  if (!run || typeof run.id !== 'string') throw new Error('PXV run is missing');
  if (['failed', 'needs-inspection', 'cancelled', 'superseded'].includes(run.status))
    throw new Error(
      'Run ' + run.id + ' stopped: ' + run.status + '. Preserve evidence and inspect; do not replay it.',
    );
  if (run.status === 'completed') return true;
  if (run.status !== 'pending' || run.manualGate) return false;
  if (kind === 'provision') return true;
  if (kind === 'os' && awaitingReenrollment(status)) return true;
  throw new Error('Pending operation has no supported continuation; inspect run ' + run.id);
}
/** @param {any} status */
function awaitingReenrollment(status) {
  return status.events?.some((/** @type {any} */ entry) => entry.event?.type === 'awaiting-os-reenrollment');
}
/** @param {Session} session @param {string} initialId @param {'os'|'provision'|'seedvault'} kind */
async function monitor(session, initialId, kind) {
  let id = initialId;
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let announced = '';
  try {
    while (Date.now() < deadline) {
      session.signal.throwIfAborted();
      const status = await jsonCommand(session, ['agent', 'status', '--run', id]);
      if (terminalRun(status, kind)) return status.run;
      if (status.run.manualGate) {
        id = await resumeCheckpoint(session, status.run);
        continue;
      }
      if (announced !== status.run.status) {
        process.stdout.write('PXV run ' + id + ': ' + status.run.status + '\n');
        announced = status.run.status;
      }
      await delay(2000, undefined, { signal: session.signal });
    }
    throw new Error('Run exceeded the two-hour observation limit; inspect its retained state');
  } catch (error) {
    if (session.signal.aborted || shouldCancel(error)) await cancelRetained(session, id);
    throw error;
  }
}
/** @param {unknown} error */
function shouldCancel(error) {
  return (
    error instanceof Error && /^(?:Stopped at the physical checkpoint|Run exceeded)/u.test(error.message)
  );
}
/** @param {Session} session @param {string} id */
async function cancelRetained(session, id) {
  const controller = new AbortController();
  try {
    await jsonCommand({ ...session, signal: controller.signal }, ['agent', 'cancel', '--run', id]);
  } catch {
    process.stderr.write('Cancellation could not be acknowledged; inspect run ' + id + '.\n');
  }
}
/** @param {Session} session @param {string} adapter @param {string} operation @param {any[]} [sources] */
export async function seedvaultOperation(session, adapter, operation, sources) {
  const folder = join(session.project, 'state/personal-recovery');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, randomUUID() + '-request.json');
  const definition = session.adapter ?? JSON.parse(await readFile(adapter, 'utf8'));
  if (definition.acceptance?.path)
    definition.acceptance.path = resolve(dirname(resolve(adapter)), definition.acceptance.path);
  const request = {
    operation,
    adapter: definition,
    ...(sources ? { sources } : {}),
  };
  await privateJson(file, request);
  const run = await reviewedOperation(
    session,
    ['seedvault', operation, '--asset', session.asset, '--transport', 'wifi', '--file', file],
    'seedvault',
  );
  return jsonCommand(session, ['seedvault', 'report', '--run', run.id]);
}
