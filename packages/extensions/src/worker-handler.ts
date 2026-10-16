import {
  EXTENSION_API_VERSION,
  type Action,
  type ExtensionDefinition,
  type IntegrationAdapterDefinition,
} from '@pxv/contracts';
import { WorkerValidationError, validateWorkerInput, validateWorkerResult } from './worker-protocol.js';
export interface WorkerRequest {
  entry: string;
  mode: 'command' | 'adapter';
  command: string;
  input: unknown;
}
type Loader = (entry: string) => Promise<unknown>;
function moduleDefinition(imported: unknown): unknown {
  if (imported === null || typeof imported !== 'object') throw new Error('Invalid extension module');
  const module = imported as { default?: unknown; extension?: unknown };
  return module.default ?? module.extension;
}
function adapterHandler(definition: unknown): IntegrationAdapterDefinition['plan'] {
  const adapter = definition as Partial<IntegrationAdapterDefinition> | undefined;
  if (adapter?.apiVersion !== EXTENSION_API_VERSION || typeof adapter.plan !== 'function')
    throw new Error('Incompatible integration adapter');
  return adapter.plan;
}
function commandHandler(definition: unknown, command: string): ExtensionDefinition['commands'][string] {
  const extension = definition as Partial<ExtensionDefinition> | undefined;
  if (
    extension?.apiVersion !== EXTENSION_API_VERSION ||
    !extension.commands ||
    typeof extension.commands !== 'object'
  )
    throw new Error('Incompatible extension definition');
  if (!Object.hasOwn(extension.commands, command)) throw new Error('Unknown extension command');
  const handler = extension.commands[command];
  if (typeof handler !== 'function') throw new Error('Unknown extension command');
  return handler;
}
/** @internal Loader injection verifies validation before the worker IPC boundary. */
export async function executeExtension(
  data: WorkerRequest,
  load: Loader = (entry) => import(entry),
): Promise<Action[]> {
  validateWorkerInput(data.input);
  const definition = moduleDefinition(await load(data.entry));
  const handler =
    data.mode === 'adapter' ? adapterHandler(definition) : commandHandler(definition, data.command);
  return validateWorkerResult(await handler(data.input));
}

type WorkerResponse = { ok: true; actions: Action[] } | { ok: false; error: string };
/** Only core validation messages cross IPC; arbitrary extension failures can contain secrets. */
export async function extensionResponse(data: WorkerRequest, load?: Loader): Promise<WorkerResponse> {
  try {
    return { ok: true, actions: await executeExtension(data, load) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof WorkerValidationError ? error.message : 'Extension worker failed',
    };
  }
}
