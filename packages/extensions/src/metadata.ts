import { validateExtension } from '@pxv/contracts';
import type { Action } from '@pxv/contracts';

export interface ExtensionMetadata {
  schemaVersion: 1;
  id: string;
  version: string;
  apiVersion: 1;
  entry: string;
  contributions: { commands: string[]; policyPacks: string[]; guides: string[]; adapters: string[] };
}

/** Extensions are trusted code. A worker isolates failures, not malicious behavior. */
export interface ExtensionDefinition {
  apiVersion: 1;
  commands: Record<string, (input: unknown) => Action[] | Promise<Action[]>>;
}

export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition {
  return definition;
}

export function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Extension metadata must be an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key)) || fields.some((key) => !(key in record)))
    throw new Error('Extension metadata has missing or unknown fields');
  return record;
}

export function validateMetadata(value: unknown): ExtensionMetadata {
  const record = object(value, ['schemaVersion', 'id', 'version', 'apiVersion', 'entry', 'contributions']);
  if (record['schemaVersion'] !== 1 || record['apiVersion'] !== 1)
    throw new Error('Incompatible extension API');
  const lock = validateExtension({
    id: record['id'],
    version: record['version'],
    apiVersion: record['apiVersion'],
    entry: record['entry'],
    integrity: `sha512-${'A'.repeat(86)}==`,
    installPath: 'validation-only',
  });
  const contributions = object(record['contributions'], ['commands', 'policyPacks', 'guides', 'adapters']);
  const result: ExtensionMetadata['contributions'] = {
    commands: [],
    policyPacks: [],
    guides: [],
    adapters: [],
  };
  for (const key of ['commands', 'policyPacks', 'guides', 'adapters'] as const) {
    const values: unknown = contributions[key];
    if (
      !Array.isArray(values) ||
      values.some((item) => typeof item !== 'string') ||
      new Set(values).size !== values.length
    )
      throw new Error('Invalid or duplicate extension contributions');
    const strings = values as string[];
    if (
      strings.some((item) =>
        key === 'commands'
          ? !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(item)
          : !safeRelativePath(item) || (key === 'adapters' && !/\.(?:m?js)$/u.test(item)),
      )
    )
      throw new Error('Invalid extension contribution name or path');
    result[key] = [...strings];
  }
  return {
    schemaVersion: 1,
    id: lock.id,
    version: lock.version,
    apiVersion: 1,
    entry: lock.entry,
    contributions: result,
  };
}
