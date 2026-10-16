import { isIP } from 'node:net';
import type { SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, checked, type OperationOptions } from './command.js';

/** Wireless debugging endpoints are TLS pairing/connect services, never legacy tcpip ports. */
export function seedvaultEndpoint(value: string): string {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9._-]*):(\d{1,5})$/u.exec(value);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) throw new AdapterError('Invalid wireless ADB endpoint');
  if (match[1]?.startsWith('[') && isIP(match[1].slice(1, -1)) !== 6)
    throw new AdapterError('Invalid wireless ADB IPv6 address');
  return value;
}

export class SeedvaultConnectionAdapter {
  constructor(readonly android: AndroidAdapter) {}

  private async advertised(endpoint: string, type: 'pairing' | 'connect', options: OperationOptions) {
    seedvaultEndpoint(endpoint);
    const output = checked(
      await this.android.runAdb(['mdns', 'services'], options.signal ? { signal: options.signal } : {}),
      'Wireless ADB service discovery',
    );
    const service = `_adb-tls-${type}._tcp`;
    if (
      !output
        .split('\n')
        .some((line) => line.includes(service) && line.trim().split(/\s+/u).at(-1) === endpoint)
    )
      throw new AdapterError(`The endpoint is not an advertised TLS ADB ${type} service`);
  }

  async pair(endpoint: string, code: string, options: OperationOptions): Promise<void> {
    if (!/^\d{6}$/u.test(code)) throw new AdapterError('A six-digit wireless pairing code is required');
    await this.advertised(endpoint, 'pairing', options);
    const output = checked(
      await this.android.runAdb(['pair', endpoint], { ...options, mutation: true, input: `${code}\n` }),
      'Wireless ADB pairing',
    );
    if (!output.includes('Successfully paired')) throw new AdapterError('Wireless pairing was not confirmed');
  }

  async connect(target: SelectedTarget, endpoint: string, options: OperationOptions): Promise<void> {
    await this.advertised(endpoint, 'connect', options);
    const output = checked(
      await this.android.runAdb(['connect', endpoint], { ...options, mutation: true }),
      'Wireless ADB connection',
    );
    if (!/\bconnected to\b/u.test(output)) throw new AdapterError('Wireless connection was not confirmed');
    await this.android.guardTarget(target, options.signal);
  }

  async disconnect(endpoint: string, options: OperationOptions): Promise<void> {
    seedvaultEndpoint(endpoint);
    checked(
      await this.android.runAdb(['disconnect', endpoint], { ...options, mutation: true }),
      'Wireless ADB disconnection',
    );
  }
}
