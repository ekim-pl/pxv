import { delimiter, join } from 'node:path';
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
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
  /** Declared normal process exit codes. Signals and interrupted cleanup never qualify. */
  expectedExitCodes?: readonly number[];
}
export interface Runtime {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}
export class CommandError extends Error {
  readonly result: CommandResult;
  constructor(result: CommandResult) {
    super(`Command failed with exit code ${result.code}`);
    this.name = 'CommandError';
    this.result = result;
  }
}
export class RecoveryRequiredError extends Error {
  constructor(message = 'Device has unresolved recovery obligations') {
    super(message);
    this.name = 'RecoveryRequiredError';
  }
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;
export function validExpectedExitCodes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)
  );
}
function validateArguments(args: string[]): void {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !args[0]
  )
    throw new Error('Command requires a nonempty argument vector');
}
function validateInput(options: CommandOptions): void {
  if (options.input !== undefined && options.inputFile !== undefined)
    throw new Error('input and inputFile are mutually exclusive');
  if (options.input !== undefined && Buffer.byteLength(options.input) > OUTPUT_LIMIT)
    throw new Error('Command input exceeds IPC limit; use inputFile');
}
export function validateCommand(args: string[], options: CommandOptions): void {
  validateArguments(args);
  validateInput(options);
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 86_400_000)
  )
    throw new Error('Invalid command timeout');
  options.signal?.throwIfAborted();
  if (options.expectedExitCodes !== undefined && !validExpectedExitCodes(options.expectedExitCodes))
    throw new Error('Invalid expected exit codes');
}
export function commandEnvironment(explicit?: Record<string, string>): Record<string, string> {
  if (explicit) return { ...explicit };
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const javaHome = env['PXV_JAVA_HOME'] || env['JAVA_HOME'];
  if (javaHome) {
    env['JAVA_HOME'] = javaHome;
    env['PATH'] = join(javaHome, 'bin') + (env['PATH'] ? delimiter + env['PATH'] : '');
  }
  return env;
}
export function nativeCommand(id: string, args: string[], options: CommandOptions): Record<string, unknown> {
  return {
    type: 'run',
    id,
    args,
    env: commandEnvironment(options.env),
    cwd: options.cwd ?? null,
    input: options.input === undefined ? null : Buffer.from(options.input).toString('base64'),
    input_file: options.inputFile ?? null,
    timeout_ms: options.timeoutMs ?? 120_000,
    ...(options.expectedExitCodes !== undefined ? { expected_exit_codes: options.expectedExitCodes } : {}),
  };
}
