import type { Action } from './types.js';

export const EXTENSION_API_VERSION = 1 as const;
export type ExtensionPlanner = (input: unknown) => readonly Action[] | Promise<readonly Action[]>;
export interface ExtensionDefinition {
  apiVersion: typeof EXTENSION_API_VERSION;
  commands: Readonly<Record<string, ExtensionPlanner>>;
}
export interface IntegrationAdapterDefinition {
  apiVersion: typeof EXTENSION_API_VERSION;
  plan: ExtensionPlanner;
}

/** API v1 keeps every command name accepted by existing installation metadata. */
export function isExtensionCommandName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}
