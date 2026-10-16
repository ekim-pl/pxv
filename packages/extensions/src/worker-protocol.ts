import { validateAction, type Action } from '@pxv/contracts';
export class WorkerValidationError extends Error {}
const MAXIMUM_BYTES = 1024 * 1024;
interface Budget {
  bytes: number;
  ancestors: Set<object>;
}
function spend(budget: Budget, bytes: number, label: string): void {
  budget.bytes += bytes;
  if (budget.bytes > MAXIMUM_BYTES) throw new WorkerValidationError(`Extension ${label} exceeds size limit`);
}
function textSize(value: string, label: string): number {
  if (Buffer.byteLength(value) > MAXIMUM_BYTES)
    throw new WorkerValidationError(`Extension ${label} exceeds size limit`);
  return Buffer.byteLength(JSON.stringify(value));
}
function countJson(value: unknown, budget: Budget, label: string, depth: number): void {
  if (depth > 64) throw new WorkerValidationError(`Extension ${label} exceeds nesting limit`);
  if (value === null) {
    spend(budget, 4, label);
    return;
  }
  if (typeof value === 'string') {
    spend(budget, textSize(value, label), label);
    return;
  }
  if (typeof value === 'boolean') {
    spend(budget, value ? 4 : 5, label);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    spend(budget, String(value).length, label);
    return;
  }
  if (typeof value !== 'object') throw new WorkerValidationError(`Extension ${label} must be JSON data`);
  countContainer(value, budget, label, depth);
}
function countContainer(value: object, budget: Budget, label: string, depth: number): void {
  if (budget.ancestors.has(value))
    throw new WorkerValidationError(`Extension ${label} must not contain cycles`);
  budget.ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new WorkerValidationError('Extension ' + label + ' must not contain symbol keys');
  spend(budget, 2, label);
  if (Array.isArray(value)) countArray(value, budget, label, depth);
  else countObject(value, budget, label, depth);
  budget.ancestors.delete(value);
}
export function validateWorkerInput(input: unknown): void {
  countJson(input, { bytes: 0, ancestors: new Set() }, 'input', 0);
}
export function validateWorkerResult(value: unknown): Action[] {
  if (!Array.isArray(value))
    throw new WorkerValidationError('Extension command must return planned core actions');
  if (value.length > 10_000) throw new WorkerValidationError('Extension result exceeds size limit');
  countJson(value, { bytes: 0, ancestors: new Set() }, 'result', 0);
  return value.map(validateAction);
}

function countArray(value: unknown[], budget: Budget, label: string, depth: number): void {
  if (value.length > MAXIMUM_BYTES)
    throw new WorkerValidationError('Extension ' + label + ' exceeds size limit');
  if (Object.keys(value).length !== value.length)
    throw new WorkerValidationError('Extension ' + label + ' must not contain sparse or decorated arrays');
  for (const item of value) {
    spend(budget, 1, label);
    countJson(item, budget, label, depth + 1);
  }
}
function countObject(value: object, budget: Budget, label: string, depth: number): void {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new WorkerValidationError('Extension ' + label + ' must be plain JSON data');
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    spend(budget, textSize(key, label) + 2, label);
    countJson((value as Record<string, unknown>)[key], budget, label, depth + 1);
  }
}
