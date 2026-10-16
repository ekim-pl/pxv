import { AdapterError } from './command.js';
type Row = Record<string, unknown>;
export function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AdapterError(`Malformed authenticated ${label}`);
  return value as Row;
}
export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new AdapterError(`Invalid authenticated ${label}`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new AdapterError(`Invalid authenticated ${label}`);
  return value;
}
export function repositoryFilename(value: unknown, suffix: '.json' | '.apk'): string {
  const raw = text(value, 'repository filename');
  const name = raw.startsWith('/') ? raw.slice(1) : raw;
  if (
    name.length > 512 ||
    !name.endsWith(suffix) ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AdapterError('Unsafe authenticated repository filename');
  return name;
}
