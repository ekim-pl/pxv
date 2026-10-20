import { AdapterError, packageId } from './command.js';
type Row = Record<string, unknown>;
function suggestedVersion(value: unknown): number | undefined {
  if (value === undefined || value === 0 || value === '0') return undefined;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value)))
    throw new AdapterError('Invalid authenticated suggested version code');
  return positiveInteger(Number(value), 'suggested version code');
}
export function suggestedVersions(value: unknown, selected?: ReadonlySet<string>): Record<string, number> {
  const versions = Object.create(null) as Record<string, number>;
  if (value === undefined) return versions;
  if (!Array.isArray(value)) throw new AdapterError('Malformed authenticated app metadata');
  const seen = new Set<string>();
  for (const raw of value) {
    const app = object(raw, 'app metadata');
    const name = text(app['packageName'], 'app package name');
    if (selected && !selected.has(name)) continue;
    const id = packageId(name);
    if (seen.has(id)) throw new AdapterError('Duplicate authenticated app metadata');
    seen.add(id);
    const code = suggestedVersion(app['suggestedVersionCode']);
    if (code !== undefined) versions[id] = code;
  }
  return versions;
}
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
