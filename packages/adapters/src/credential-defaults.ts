import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseDocument,
  type AndroidUserIdentity,
  type ExecutionPolicy,
  type ProfilePolicy,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, cancelled, shellQuote, type OperationOptions } from './command.js';

const INPUT_LIMIT = 64 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PASSWORD = /^[\x20-\x7e]{4,128}$/u;
const PIN = /^[0-9]{4,128}$/u;
const INPUT_ERROR = 'Credential defaults require a valid private device input file';
type PrivateValues = ReadonlyMap<string, string>;

function inputFailure(): AdapterError {
  return new AdapterError(INPUT_ERROR, 'CREDENTIAL_DEFAULT_INPUT');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function privateEntries(data: Buffer): [string, unknown][] {
  const source = data.toString('utf8');
  JSON.parse(source);
  const parsed = parseDocument(source);
  if (!record(parsed) || parsed['schemaVersion'] !== 1 || !record(parsed['values'])) throw inputFailure();
  if (Object.keys(parsed).sort().join(',') !== 'schemaVersion,values') throw inputFailure();
  const entries = Object.entries(parsed['values']);
  if (!entries.length || entries.length > 128) throw inputFailure();
  return entries;
}
function privateValues(data: Buffer): PrivateValues {
  const values = new Map<string, string>();
  for (const [ref, value] of privateEntries(data)) {
    if (!IDENTIFIER.test(ref) || typeof value !== 'string' || !PASSWORD.test(value)) throw inputFailure();
    values.set(ref, value);
  }
  return values;
}
function valueFor(values: PrivateValues, ref: string, kind: 'pin' | 'password' = 'password'): string {
  const value = values.get(ref);
  if (!IDENTIFIER.test(ref) || value === undefined || !(kind === 'pin' ? PIN : PASSWORD).test(value))
    throw inputFailure();
  return value;
}
function validateValues(policy: ExecutionPolicy, values: PrivateValues): void {
  const normal = new Set<string>();
  for (const profile of policy.profiles) {
    const credential = profile.defaultCredential;
    if (credential) normal.add(valueFor(values, credential.secretRef, credential.type));
    if (profile.defaultDuress) normal.add(valueFor(values, profile.defaultDuress.ownerCredentialRef));
  }
  for (const profile of policy.profiles) validateDuress(profile, values, normal);
}
function validateDuress(profile: ProfilePolicy, values: PrivateValues, normal: ReadonlySet<string>): void {
  const duress = profile.defaultDuress;
  if (!duress) return;
  if (profile.kind !== 'owner') throw inputFailure();
  const pin = valueFor(values, duress.pinRef, 'pin');
  const password = valueFor(values, duress.passwordRef);
  if (normal.has(pin) || normal.has(password)) throw inputFailure();
}
function validatePrivateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(INPUT_LIMIT)) throw inputFailure();
  if (stat.uid !== BigInt(process.geteuid?.() ?? -1) || (stat.mode & 0o7777n) !== 0o600n)
    throw inputFailure();
}
async function directory(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(process.geteuid?.() ?? -1) || (stat.mode & 0o022n) !== 0n)
      throw inputFailure();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
async function readPrivateFile(projectRoot: string, assetId: string, signal?: AbortSignal): Promise<Buffer> {
  if (!IDENTIFIER.test(assetId)) throw inputFailure();
  const handles: FileHandle[] = [];
  try {
    let parent = await directory(resolve(projectRoot));
    handles.push(parent);
    for (const component of ['secrets', 'credentials']) {
      parent = await directory(join('/proc/self/fd', String(parent.fd), component));
      handles.push(parent);
    }
    const file = await open(
      join('/proc/self/fd', String(parent.fd), `${assetId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handles.push(file);
    return await boundedRead(file, signal);
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}
async function boundedRead(file: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const before = await file.stat({ bigint: true });
  validatePrivateFile(before);
  const data = Buffer.alloc(INPUT_LIMIT + 1);
  try {
    let bytes = 0;
    while (bytes < data.length) {
      cancelled(signal);
      const result = await file.read(data, bytes, data.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    validatePrivateFile(after);
    if (
      BigInt(bytes) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw inputFailure();
    return data.subarray(0, bytes);
  } catch (error) {
    data.fill(0);
    throw error;
  }
}
function configuredCommands(policy: ExecutionPolicy): string[] {
  const commands = new Set<string>();
  for (const profile of policy.profiles) {
    if (profile.defaultCredential) commands.add(`set-${profile.defaultCredential.type}`);
    if (profile.defaultDuress) commands.add('set-duress-credentials');
  }
  return [...commands];
}

/** Parse only the requested user's public credential type; never retain the dump. */
function credentialType(dump: string, userId: number): string {
  const lines = dump.split(/\r?\n/u);
  const users = lines.flatMap((line, index) => {
    const match = /^(\s*)User ([0-9]+)\s*$/u.exec(line);
    return match && Number(match[2]) === userId ? [{ index, indent: match[1]!.length }] : [];
  });
  if (users.length !== 1)
    throw new AdapterError('Credential state is unavailable; inspect the profile privately');
  const user = users[0]!;
  const types: string[] = [];
  for (const line of lines.slice(user.index + 1)) {
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= user.indent) break;
    if (line.trimStart().startsWith('CredentialType:'))
      types.push(line.trim().slice('CredentialType:'.length).trim());
  }
  if (types.length !== 1 || !['NONE', 'PIN', 'PASSWORD', 'PATTERN'].includes(types[0]!))
    throw new AdapterError('Credential state is unavailable; inspect the profile privately');
  return types[0]!;
}

/** Private values are loaded for each call and never become plan or observation data. */
export class CredentialDefaultsService {
  constructor(
    readonly android: AndroidAdapter,
    readonly projectRoot: string,
    readonly policy: ExecutionPolicy,
  ) {}

  private async values(target: SelectedTarget, signal?: AbortSignal): Promise<PrivateValues> {
    try {
      const data = await readPrivateFile(this.projectRoot, target.device.assetId, signal);
      try {
        const values = privateValues(data);
        validateValues(this.policy, values);
        return values;
      } finally {
        data.fill(0);
      }
    } catch {
      throw inputFailure();
    }
  }

  private async supported(target: SelectedTarget, commands: readonly string[], signal?: AbortSignal) {
    try {
      const help = await this.android.shell(target, ['locksettings', 'help'], signal ? { signal } : {});
      if (commands.every((command) => new RegExp(`^\\s*${command}(?:\\s|$)`, 'mu').test(help))) return;
    } catch {
      // Capability errors must not retain uncontrolled command output.
    }
    throw new AdapterError(
      'Installed Android does not support the configured credential commands',
      'UNSUPPORTED',
    );
  }

  async preflight(target: SelectedTarget, signal?: AbortSignal): Promise<void> {
    const commands = configuredCommands(this.policy);
    if (!commands.length) return;
    await this.values(target, signal);
    await this.android.guardTarget(target, signal);
    await this.supported(target, commands, signal);
  }

  private profile(profile: ProfilePolicy, user: AndroidUserIdentity): ProfilePolicy {
    const configured = this.policy.profiles.find((candidate) => candidate.id === profile.id);
    if (
      !configured ||
      configured.kind !== profile.kind ||
      configured.name !== user.name ||
      (configured.kind === 'owner') !== (user.userId === 0)
    )
      throw new AdapterError('Credential defaults require the configured Android user identity');
    return configured;
  }

  async setCredential(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    options: OperationOptions,
  ): Promise<'command-accepted' | 'existing-lock-preserved'> {
    const credential = this.profile(profile, user).defaultCredential;
    if (!credential) throw new AdapterError('Profile has no configured credential default');
    await this.android.guardUser(target, user, options.signal);
    const state = async () =>
      credentialType(
        await this.android.shell(
          target,
          ['dumpsys', 'lock_settings'],
          options.signal ? { signal: options.signal } : {},
        ),
        user.userId,
      );
    const initialType = await state();
    await this.android.guardUser(target, user, options.signal);
    if (initialType !== 'NONE') return 'existing-lock-preserved';
    const values = await this.values(target, options.signal);
    const command = `set-${credential.type}`;
    await this.supported(target, [command], options.signal);
    await this.android.guardUser(target, user, options.signal);
    const currentType = await state();
    await this.android.guardUser(target, user, options.signal);
    if (currentType !== 'NONE') return 'existing-lock-preserved';
    await this.dispatch(
      target,
      [command, '--user', String(user.userId), '--', valueFor(values, credential.secretRef, credential.type)],
      options,
    );
    return 'command-accepted';
  }

  async setDuress(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    options: OperationOptions,
  ): Promise<void> {
    const duress = this.profile(profile, user).defaultDuress;
    if (!duress || user.userId !== 0) throw new AdapterError('Duress defaults require the configured owner');
    const values = await this.values(target, options.signal);
    await this.supported(target, ['set-duress-credentials'], options.signal);
    await this.android.guardUser(target, user, options.signal);
    await this.dispatch(
      target,
      [
        'set-duress-credentials',
        '--owner-credential',
        valueFor(values, duress.ownerCredentialRef),
        '--duress-pin',
        valueFor(values, duress.pinRef, 'pin'),
        '--duress-password',
        valueFor(values, duress.passwordRef),
      ],
      options,
    );
  }

  private async dispatch(target: SelectedTarget, args: string[], options: OperationOptions): Promise<void> {
    cancelled(options.signal);
    // Suppress Android's echoed credentials before any process output reaches the host.
    const input = `exec ${['locksettings', ...args].map(shellQuote).join(' ')} >/dev/null 2>&1\n`;
    try {
      const result = await this.android.runAdb(['-s', target.transport.serial, 'shell', 'sh', '-s'], {
        ...options,
        mutation: true,
        check: false,
        timeoutMs: 30_000,
        input,
      });
      if (result.code === 0) return;
    } catch {
      // Errors may retain command output or private stdin; do not propagate them.
    }
    throw new AdapterError(
      'Credential configuration was not confirmed; inspect the device privately before any retry',
      'CREDENTIAL_DEFAULT_UNCERTAIN',
    );
  }
}
