/** The injected executor owns process supervision. Adapters never spawn directly. */
export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string | Uint8Array;
  inputFile?: string;
  env?: Record<string, string>;
  cwd?: string;
  mutation?: boolean;
  lease?: object;
  check?: boolean;
  expectedExitCodes?: readonly number[];
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CommandRunner {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}
export interface OperationOptions {
  lease: object;
  signal?: AbortSignal;
}
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code = 'ADAPTER_ERROR',
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
export function checked(result: CommandResult, label: string): string {
  if (result.code !== 0)
    throw new AdapterError(`${label} failed; inspect retained operation evidence`, 'COMMAND_FAILED');
  return result.stdout;
}
export function cancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
export function shellQuote(value: string): string {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n'))
    throw new AdapterError('Unsafe Android shell argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function sha256Pin(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new AdapterError('An exact SHA-256 pin is required');
  return value.toLowerCase();
}
export function packageId(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value))
    throw new AdapterError('Invalid Android package ID');
  return value;
}
