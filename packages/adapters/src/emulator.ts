import type { SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, sha256Pin } from './command.js';
import { fileDigest } from './files.js';

export interface EmulatorImagePin {
  path: string;
  sha256: string;
  fingerprint: string;
  source: string;
}
export interface EmulatorProvenance {
  schemaVersion: 1;
  acceptance: 'emulator-only';
  canonicalSerial: string;
  fingerprint: string;
  imageSha256: string;
  source: string;
  capabilities: string[];
  observedAt: string;
}
/** Capability lists replace numeric workflow scopes, including final language/duress setup. */
export async function observeEmulatorProvenance(
  android: AndroidAdapter,
  target: SelectedTarget,
  image: EmulatorImagePin,
  capabilities: readonly string[],
  signal?: AbortSignal,
): Promise<EmulatorProvenance> {
  if (target.device.kind !== 'emulator' || target.transport.kind !== 'emulator')
    throw new AdapterError('Emulator provenance cannot certify a physical device');
  await android.guardTarget(target, signal);
  const expected = sha256Pin(image.sha256);
  if (
    !image.source ||
    !image.fingerprint ||
    (await fileDigest(image.path, 8 * 1024 ** 3, signal)) !== expected
  )
    throw new AdapterError('Emulator image does not match its accepted provenance pin');
  const fingerprint = (
    await android.shell(target, ['getprop', 'ro.build.fingerprint'], signal ? { signal } : {})
  ).trim();
  const qemu = (await android.shell(target, ['getprop', 'ro.kernel.qemu'], signal ? { signal } : {})).trim();
  if (fingerprint !== image.fingerprint || qemu !== '1')
    throw new AdapterError('Running emulator build differs from the accepted image provenance');
  return {
    schemaVersion: 1,
    acceptance: 'emulator-only',
    canonicalSerial: target.device.canonicalSerial,
    fingerprint,
    imageSha256: expected,
    source: image.source,
    capabilities: [...new Set(capabilities)].sort(),
    observedAt: new Date().toISOString(),
  };
}
