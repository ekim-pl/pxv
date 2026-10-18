import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { existingIdentity, identity, sameIdentity, type Identity } from './supervisor-process.js';
import type { Kernel } from './supervisor-native.js';
export const safeId = (value: string): boolean => /^[A-Za-z0-9_-]{1,160}$/u.test(value);
export const digest = (value: string): boolean => /^[a-fA-F0-9]{64}$/u.test(value);
export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function privateDirectory(path: string): void {
  if (!exists(path)) {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!())
    throw new Error('Control path must be an operator-owned real directory');
  if (stat.mode & 0o077) throw new Error('Control directory must have private permissions (0700)');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durable(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
function readRecord(path: string): Record<string, unknown> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Malformed recovery evidence retained');
    const value: unknown = JSON.parse(readRecoveryBytes(fd));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Malformed recovery evidence retained');
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}
function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v['pid']) &&
    Number(v['pid']) > 0 &&
    Number(v['pid']) <= 2147483647 &&
    typeof v['start_ticks'] === 'string' &&
    typeof v['boot_id'] === 'string' &&
    Number.isInteger(v['uid']) &&
    Number(v['uid']) >= 0 &&
    Number(v['uid']) <= 4294967295
  );
}
function verifyOwner(record: Record<string, unknown>): void {
  const prior = record['supervisor'];
  if (!validIdentity(prior)) throw new Error('Malformed recovery owner retained');
  if (identity(process.pid).boot_id !== prior.boot_id) return;
  if (sameIdentity(existingIdentity(prior.pid), prior)) throw new Error('Native owner is still alive');
  if (record['cleanup_proven'] !== true)
    throw new Error('Process cleanup is unproven; reboot the host before releasing this reservation');
}
export class Lease {
  readonly supervisor = identity(process.pid);
  readonly reservations: string[] = [];
  readonly locks: number[] = [];
  uncertain = false;
  mutated = false;
  constructor(
    readonly root: string,
    readonly device: string,
    readonly transport: string,
    readonly operation: string,
    kernel: Kernel,
    readonly previous?: string,
  ) {
    validateLease(device, transport, operation, previous);
    for (const path of [root, ...['locks', 'reservations', 'receipts'].map((v) => join(root, v))])
      privateDirectory(path);
    this.lockResources(kernel);
    if (previous) this.savePrevious(previous);
    for (const path of this.reservations) durable(path, this.record('reserved'));
  }
  private lockResources(kernel: Kernel): void {
    for (const key of [`device-${this.device}`, `transport-${this.transport}`].sort()) {
      const fd = openSync(
        join(this.root, 'locks', `${key}.lock`),
        constants.O_RDWR | constants.O_NOFOLLOW | (this.previous ? 0 : constants.O_CREAT),
        0o600,
      );
      this.locks.push(fd);
      kernel.closeOnExec(fd);
      kernel.lock(fd);
      const path = join(this.root, 'reservations', `${key}.json`);
      if (!this.previous && exists(path)) throw new Error('Device has unresolved recovery reservation');
      this.reservations.push(path);
    }
  }
  record(status: string): Record<string, unknown> {
    return {
      schema: 1,
      operation_id: this.operation,
      previous_operation_id: this.previous ?? null,
      device_key: this.device,
      transport_key: this.transport,
      supervisor: this.supervisor,
      status,
    };
  }
  receiptPath(id: string): string {
    return join(this.root, 'receipts', `${this.operation}-${id}.json`);
  }
  finish(requested: boolean, clean: boolean): boolean {
    const success = requested && !this.uncertain && clean;
    const record = {
      ...this.record(success ? 'completed' : 'recovery_required'),
      cleanup_proven: clean,
      mutation_started: this.mutated,
    };
    durable(this.receiptPath('operation'), record);
    if (success || (!this.mutated && !this.previous && clean)) {
      for (const path of this.reservations) unlinkSync(path);
      syncDirectory(join(this.root, 'reservations'));
    } else for (const path of this.reservations) durable(path, record);
    return success;
  }
  private savePrevious(previous: string): void {
    let first: string | undefined;
    let record: Record<string, unknown> | undefined;
    for (const path of this.reservations) {
      record = readRecord(path);
      if (
        record['schema'] !== 1 ||
        record['device_key'] !== this.device ||
        record['transport_key'] !== this.transport ||
        record['operation_id'] !== previous
      )
        throw new Error('Matching recovery reservation is unavailable');
      verifyOwner(record);
      const normalized = canonical(record);
      if (first !== undefined && first !== normalized)
        throw new Error('Conflicting recovery evidence retained');
      first = normalized;
    }
    durable(this.receiptPath('previous-reservation'), record);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

function validateLease(
  device: string,
  transport: string,
  operation: string,
  previous: string | undefined,
): void {
  if (!digest(device) || !digest(transport) || !safeId(operation)) throw new Error('Invalid lease identity');
  if (previous !== undefined && (!safeId(previous) || previous === operation))
    throw new Error('Invalid prior recovery operation identity');
}

function readRecoveryBytes(fd: number): string {
  const bytes = Buffer.alloc(65537);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length > 65536) throw new Error('Malformed recovery evidence retained');
  return bytes.subarray(0, length).toString('utf8');
}
