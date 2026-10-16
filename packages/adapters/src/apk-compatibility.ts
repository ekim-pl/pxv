import { AdapterError } from './command.js';
export interface ApkCompatibility {
  minSdk: number;
  maxSdk?: number;
  abis: string[];
}
export function parseApkCompatibility(badging: string): ApkCompatibility {
  const minSdk = sdkMetadata(badging, 'sdkVersion') ?? 1;
  const maxSdk = sdkMetadata(badging, 'maxSdkVersion');
  validateSdkRange(minSdk, maxSdk);
  return { minSdk, ...(maxSdk === undefined ? {} : { maxSdk }), abis: abiMetadata(badging) };
}
function sdkMetadata(badging: string, key: 'sdkVersion' | 'maxSdkVersion'): number | undefined {
  const matches = [...badging.matchAll(new RegExp(`^${key}:'(\\d+)'$`, 'gm'))];
  if (new RegExp(`^${key}:`, 'm').test(badging) && matches.length !== 1)
    throw new AdapterError('APK requires numeric, unambiguous SDK compatibility metadata');
  const value = matches[0]?.[1];
  return value === undefined ? undefined : Number(value);
}
function validateSdkRange(minSdk: number, maxSdk?: number): void {
  if (!Number.isSafeInteger(minSdk) || minSdk < 1)
    throw new AdapterError('APK SDK compatibility metadata is invalid');
  if (maxSdk !== undefined && (!Number.isSafeInteger(maxSdk) || maxSdk < minSdk))
    throw new AdapterError('APK SDK compatibility metadata is invalid');
}
function abiMetadata(badging: string): string[] {
  const native = [...badging.matchAll(/^native-code:\s*(.*)$/gm)];
  if (native.length > 1) throw new AdapterError('APK compatibility metadata is ambiguous');
  const raw = native[0]?.[1] ?? '';
  if (raw && !/^(?:'[A-Za-z0-9_-]+'\s*)+$/.test(raw))
    throw new AdapterError('APK ABI compatibility metadata is invalid');
  return [...raw.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}
