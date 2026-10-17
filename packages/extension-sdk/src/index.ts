import {
  EXTENSION_API_VERSION,
  isExtensionCommandName,
  type ExtensionDefinition,
  type IntegrationAdapterDefinition,
} from '@pxv/contracts/extensions';
export { EXTENSION_API_VERSION } from '@pxv/contracts/extensions';
export type {
  Action,
  AndroidUserIdentity,
  DeviceTarget,
  ExtensionDefinition,
  IntegrationAdapterDefinition,
  ExecutionPolicy,
  ProductDescriptor,
} from '@pxv/contracts';

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
    if (!isExtensionCommandName(name) || typeof command !== 'function')
      throw new Error('Invalid extension command');
  }
  return Object.freeze({
    apiVersion: EXTENSION_API_VERSION,
    commands: Object.freeze({ ...definition.commands }),
  });
}
