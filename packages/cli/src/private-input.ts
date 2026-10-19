import { stdin, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ApplicationCliContext } from './arguments.js';

async function hiddenInput(label: string, signal: AbortSignal): Promise<string> {
  if (!stdin.isTTY || !stderr.isTTY) throw new Error('Private entry requires a local terminal');
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({ input: stdin, output: muted, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  prompt.once('SIGINT', interrupt);
  stderr.write(`${label} (empty to skip): `);
  try {
    return await prompt.question('', { signal: AbortSignal.any([signal, controller.signal]) });
  } catch {
    throw new Error('Private entry cancelled or interrupted');
  } finally {
    prompt.close();
    muted.destroy();
    stderr.write('\n');
  }
}

/** An empty response explicitly skips; validation errors never echo the supplied value. */
export async function privateCollectionInput(
  context: ApplicationCliContext,
  label: string,
  normalize: (value: string) => string | undefined,
): Promise<string | undefined> {
  while (true) {
    context.signal.throwIfAborted();
    const value = await (context.io.privateInput
      ? context.io.privateInput(label, context.signal)
      : hiddenInput(label, context.signal));
    context.signal.throwIfAborted();
    if (value === undefined || !value.trim()) return undefined;
    const normalized = normalize(value);
    if (normalized !== undefined) return normalized;
    context.io.error('Invalid private value. Enter it again or leave empty to skip.');
  }
}
