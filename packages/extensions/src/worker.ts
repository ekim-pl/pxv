import { parentPort, workerData } from 'node:worker_threads';
import type { ExtensionDefinition } from './metadata.js';

const data = workerData as { entry: string; mode: 'command' | 'adapter'; command: string; input: unknown };
const imported: unknown = await import(data.entry);
if (imported === null || typeof imported !== 'object') throw new Error('Invalid extension module');
const module = imported as { default?: unknown; extension?: unknown };
const definition = module.default ?? module.extension;
let handler: ((input: unknown) => unknown) | undefined;
if (data.mode === 'adapter') {
  const adapter = definition as { apiVersion?: unknown; plan?: unknown } | undefined;
  if (adapter?.apiVersion !== 1 || typeof adapter.plan !== 'function')
    throw new Error('Incompatible integration adapter');
  handler = adapter.plan as (input: unknown) => unknown;
} else {
  const extension = definition as ExtensionDefinition | undefined;
  if (extension?.apiVersion !== 1 || typeof extension.commands !== 'object')
    throw new Error('Incompatible extension definition');
  handler = extension.commands[data.command];
}
if (typeof handler !== 'function') throw new Error('Unknown extension command');
parentPort?.postMessage(await handler(data.input));
