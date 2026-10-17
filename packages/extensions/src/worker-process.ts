import { Worker } from 'node:worker_threads';
import type { WorkerRequest } from './worker-handler.js';

/** Resolve only after termination so callers never race worker teardown. */
export function invokeWorker(path: string, workerData: WorkerRequest, timeoutMs: number): Promise<unknown> {
  const instrumentation = process.env['NODE_V8_COVERAGE'];
  const env: Record<string, string> = {};
  if (instrumentation) env['NODE_V8_COVERAGE'] = instrumentation;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path, {
      workerData,
      env,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = async (error?: Error, response?: unknown): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await worker.terminate();
        if (error) reject(error);
        else resolve(response);
      } catch (failure) {
        reject(failure instanceof Error ? failure : new Error('Extension worker termination failed'));
      }
    };
    const timer = setTimeout(() => void finish(new Error('Extension worker timed out')), timeoutMs);
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.once('message', (message: unknown) => void finish(undefined, message));
    worker.once('error', () => void finish(new Error('Extension worker failed')));
    worker.once('exit', () => void finish(new Error('Extension worker exited without planned actions')));
  });
}
