import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readBounded } from './files.js';
import { RecoveryRequiredError, validExpectedExitCodes } from './command-contracts.js';
export interface RecoveryReservation {
  schema: number;
  operation_id: string;
  previous_operation_id?: string | null;
  device_key: string;
  transport_key: string;
  supervisor: { pid: number; start_ticks: string; boot_id: string; uid: number };
  status: string;
  cleanup_proven?: boolean;
  mutation_started?: boolean;
}

interface ProcessIdentity {
  pid: number;
  start_ticks: string;
  boot_id: string;
  uid: number;
}
export interface NativeReceipt {
  id: string;
  operationId: string;
  commandId: string;
  status: 'gated' | 'authorized' | 'running' | 'completed';
  supervisor: ProcessIdentity;
  child?: ProcessIdentity;
  code?: number;
  cleanupProven?: boolean;
  interrupted?: boolean;
  expectedExitCodes?: number[];
}

async function evidenceFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function readEvidence(
  directory: string,
  file: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readBounded(join(directory, file), 64 * 1024)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid evidence object');
    return value as Record<string, unknown>;
  } catch {
    throw new RecoveryRequiredError(`Malformed ${label} retained: ${file}`);
  }
}
function validIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as ProcessIdentity;
  return (
    Number.isInteger(item.pid) &&
    item.pid > 0 &&
    Number.isInteger(item.uid) &&
    item.uid >= 0 &&
    typeof item.start_ticks === 'string' &&
    /^[0-9]+$/u.test(item.start_ticks) &&
    typeof item.boot_id === 'string' &&
    item.boot_id.length > 0
  );
}
const RECEIPT_FIELDS = new Set([
  'schema',
  'operation_id',
  'command_id',
  'supervisor',
  'status',
  'child',
  'code',
  'cleanup_proven',
  'interrupted',
  'expected_exit_codes',
]);
function validReceiptIdentity(
  value: Record<string, unknown>,
  operationId: string,
  commandId: string,
): boolean {
  return (
    value['schema'] === 1 &&
    value['operation_id'] === operationId &&
    value['command_id'] === commandId &&
    Object.keys(value).every((key) => RECEIPT_FIELDS.has(key)) &&
    validIdentity(value['supervisor']) &&
    ['gated', 'authorized', 'running', 'completed'].includes(String(value['status']))
  );
}
function validReceiptOptions(value: Record<string, unknown>): boolean {
  return (
    (value['child'] === undefined || validIdentity(value['child'])) &&
    (value['expected_exit_codes'] === undefined || validExpectedExitCodes(value['expected_exit_codes']))
  );
}
function validCompletion(value: Record<string, unknown>): boolean {
  return (
    value['status'] !== 'completed' ||
    (Number.isInteger(value['code']) &&
      typeof value['cleanup_proven'] === 'boolean' &&
      typeof value['interrupted'] === 'boolean')
  );
}
function commandIdentity(file: string, operationId: string): string | undefined {
  if (!file.startsWith(`${operationId}-`) || !file.endsWith('.json')) return undefined;
  const id = file.slice(operationId.length + 1, -5);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id) ? id : undefined;
}
function projectReceipt(
  value: Record<string, unknown>,
  operationId: string,
  commandId: string,
): NativeReceipt {
  return {
    id: `${operationId}:${commandId}`,
    operationId,
    commandId,
    status: value['status'] as NativeReceipt['status'],
    supervisor: value['supervisor'] as ProcessIdentity,
    ...(value['child'] !== undefined ? { child: value['child'] as ProcessIdentity } : {}),
    ...(value['code'] !== undefined ? { code: value['code'] as number } : {}),
    ...(value['cleanup_proven'] !== undefined ? { cleanupProven: value['cleanup_proven'] as boolean } : {}),
    ...(value['interrupted'] !== undefined ? { interrupted: value['interrupted'] as boolean } : {}),
    ...(value['expected_exit_codes'] !== undefined
      ? { expectedExitCodes: value['expected_exit_codes'] as number[] }
      : {}),
  };
}
/** Only completed receipts are immutable and eligible for idempotent ingestion. */
export async function nativeReceipts(controlRoot: string, operationId: string): Promise<NativeReceipt[]> {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(operationId)) throw new Error('Invalid native operation identity');
  const directory = join(controlRoot, 'receipts');
  const output: NativeReceipt[] = [];
  for (const file of await evidenceFiles(directory)) {
    const commandId = commandIdentity(file, operationId);
    if (!commandId) continue;
    const value = await readEvidence(directory, file, 'native receipt');
    if (!validReceiptIdentity(value, operationId, commandId) || !validReceiptOptions(value))
      throw new RecoveryRequiredError(`Malformed native receipt retained: ${file}`);
    if (!validCompletion(value))
      throw new RecoveryRequiredError(`Malformed native completion retained: ${file}`);
    output.push(projectReceipt(value, operationId, commandId));
  }
  return output;
}
function validReservation(value: Record<string, unknown>): boolean {
  const supervisor = value['supervisor'];
  return (
    value['schema'] === 1 &&
    typeof value['operation_id'] === 'string' &&
    typeof value['device_key'] === 'string' &&
    typeof value['transport_key'] === 'string' &&
    !!supervisor &&
    typeof supervisor === 'object' &&
    typeof (supervisor as Record<string, unknown>)['boot_id'] === 'string'
  );
}
/** Read-only inspection never creates the shared control directory. */
export async function recoveryReservations(controlRoot: string): Promise<RecoveryReservation[]> {
  const directory = join(controlRoot, 'reservations');
  const seen = new Set<string>();
  const records: RecoveryReservation[] = [];
  for (const file of await evidenceFiles(directory)) {
    if (!file.endsWith('.json')) continue;
    const value = await readEvidence(directory, file, 'recovery evidence');
    if (!validReservation(value))
      throw new RecoveryRequiredError(`Malformed recovery evidence retained: ${file}`);
    const record = value as unknown as RecoveryReservation;
    if (!seen.has(record.operation_id)) {
      seen.add(record.operation_id);
      records.push(record);
    }
  }
  return records;
}
