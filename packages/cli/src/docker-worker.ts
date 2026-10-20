import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import type { CommandRunner } from '@pxv/adapters';
import { DockerWorkerControl, type DockerWorkerIdentity } from './docker-worker-control.js';

export interface DockerWorkerOptions {
  container?: DockerWorkerIdentity;
  control?: CommandRunner;
  timeoutMs?: number;
  graceMs?: number;
  controlTimeoutMs?: number;
  reapMs?: number;
}
export type DockerWorkerRunner = (args: string[], options?: DockerWorkerOptions) => Promise<number>;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Interrupt = 'SIGINT' | 'SIGTERM';

function waitForClose(closed: Promise<Exit>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
function killClient(child: ChildProcess): void {
  try {
    if (child.pid && process.platform === 'linux') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
/** Cancellation retains the worker identity even if the attached Docker client exits first. */
class WorkerShutdown {
  private readonly control: DockerWorkerControl | undefined;
  constructor(
    readonly child: ChildProcess,
    readonly closed: Promise<Exit>,
    readonly options: DockerWorkerOptions,
  ) {
    if (options.container)
      this.control = new DockerWorkerControl(options.container, options.control, options.controlTimeoutMs);
  }
  private report(error: unknown): void {
    const name = this.options.container?.name ?? 'attached client';
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Docker worker cleanup unresolved (${name}): ${reason}. Inspect this worker explicitly with docker container inspect ${name}; preserve recovery records and native fences before continuing.\n`,
    );
  }
  async finish(): Promise<void> {
    const deadline = performance.now() + (this.options.graceMs ?? 90_000);
    const exited = await waitForClose(this.closed, Math.max(1, deadline - performance.now()));
    if (exited && !this.control) return;
    if (exited && (await this.alreadyStopped())) return;
    if (performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, deadline - performance.now()));
    await this.forceShutdown(exited);
  }
  private async forceShutdown(exited: boolean): Promise<void> {
    const before = await this.forceStop();
    if (!(await waitForClose(this.closed, 1))) {
      try {
        killClient(this.child);
      } catch (error) {
        this.report(error);
      }
    }
    const reaped = await waitForClose(this.closed, this.options.reapMs ?? 5000);
    if (!reaped) {
      this.child.unref();
      this.report(new Error('Attached client did not exit within the shutdown deadline'));
    }
    const after = await this.forceStop();
    if (this.control && !this.control.observed && before === 'missing' && after === 'missing' && !exited)
      this.report(
        new Error('Container creation may still be in flight; startup cancellation could not be confirmed'),
      );
  }
  private async alreadyStopped(): Promise<boolean> {
    try {
      const state = await this.control!.state();
      if (state.kind === 'missing' && !this.control!.observed)
        this.report(
          new Error('Container creation may still be in flight; startup cancellation could not be confirmed'),
        );
      return state.kind !== 'running';
    } catch {
      return false;
    }
  }
  private async forceStop(): Promise<string | undefined> {
    if (!this.control) return undefined;
    try {
      return (await this.control.forceStop()).kind;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }
}
function validateOptions(options: DockerWorkerOptions): void {
  for (const value of [options.timeoutMs, options.graceMs, options.controlTimeoutMs, options.reapMs])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000))
      throw new Error('Invalid Docker worker timeout');
}
function exitStatus(exit: Exit): number {
  return exit.code ?? 128 + (exit.signal ? constants.signals[exit.signal] : 0);
}
/** Attached workers stream all I/O; inspection/control commands remain independently bounded. */
export async function runDockerWorker(args: string[], options: DockerWorkerOptions = {}): Promise<number> {
  if (!args[0]) throw new Error('Docker worker command is required');
  validateOptions(options);
  const child = spawn(args[0], args.slice(1), { stdio: 'inherit', detached: process.platform === 'linux' });
  const closed = new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let interrupted: Interrupt | undefined;
  let timedOut = false;
  let cancel: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const interrupt = (signal: Interrupt): void => {
    if (interrupted) return;
    interrupted = signal;
    clearTimeout(timer);
    child.kill(signal);
    cancel();
  };
  const onInt = (): void => interrupt('SIGINT');
  const onTerm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timer = setTimeout(() => {
    timedOut = true;
    interrupt('SIGTERM');
  }, options.timeoutMs ?? 86_400_000);
  timer.unref();
  try {
    const exit = await Promise.race([closed, cancelled.then(() => undefined)]);
    if (interrupted) {
      await new WorkerShutdown(child, closed, options).finish();
      return timedOut ? 124 : 128 + constants.signals[interrupted];
    }
    return exitStatus(exit!);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}
