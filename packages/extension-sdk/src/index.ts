import type { Action } from '@pxv/contracts';
export type {
  Action,
  PolicyPack,
  ProductDescriptor,
  AndroidUserIdentity,
  DeviceTarget,
} from '@pxv/contracts';

export const EXTENSION_API_VERSION = 1 as const;
export interface ExtensionDefinition {
  apiVersion: 1;
  commands: Readonly<Record<string, (input: unknown) => readonly Action[] | Promise<readonly Action[]>>>;
}
export interface IntegrationAdapterDefinition {
  apiVersion: 1;
  plan(input: unknown): readonly Action[] | Promise<readonly Action[]>;
}

/** Integration adapters propose core actions; the host reviews and executes them. */
export function defineIntegrationAdapter(
  plan: IntegrationAdapterDefinition['plan'],
): IntegrationAdapterDefinition {
  if (typeof plan !== 'function') throw new Error('Integration adapter must provide a planning function');
  return Object.freeze({ apiVersion: EXTENSION_API_VERSION, plan });
}

/** Bundle this small SDK with the extension; installed extensions have no runtime dependencies. */
export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition {
  if (definition.apiVersion !== EXTENSION_API_VERSION) throw new Error('Unsupported extension API');
  for (const [name, command] of Object.entries(definition.commands)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name) || typeof command !== 'function')
      throw new Error('Invalid extension command');
  }
  return Object.freeze({
    apiVersion: EXTENSION_API_VERSION,
    commands: Object.freeze({ ...definition.commands }),
  });
}
