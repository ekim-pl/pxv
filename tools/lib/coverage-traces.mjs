import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param {unknown} value */
function validRange(value) {
  return (
    record(value) &&
    ['startOffset', 'endOffset', 'count'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    ) &&
    Number(value['endOffset']) >= Number(value['startOffset'])
  );
}
/** @param {unknown} value */
function validFunction(value) {
  return (
    record(value) &&
    typeof value['functionName'] === 'string' &&
    typeof value['isBlockCoverage'] === 'boolean' &&
    Array.isArray(value['ranges']) &&
    value['ranges'].every(validRange)
  );
}
/** @param {unknown} value */
function validScript(value) {
  return (
    record(value) &&
    typeof value['url'] === 'string' &&
    Array.isArray(value['functions']) &&
    value['functions'].every(validFunction)
  );
}
/** A worker can create its file before the final write finishes. Retry only for
 * a bounded interval; a persistent malformed trace must fail the coverage gate.
 * @param {string} filename
 * @returns {Promise<import('node:inspector').Profiler.ScriptCoverage[]>} */
export async function readCoverageTrace(filename) {
  let failure = new Error('Empty coverage trace');
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      /** @type {unknown} */
      const data = JSON.parse(await readFile(filename, 'utf8'));
      if (!record(data) || !Array.isArray(data['result']) || !data['result'].every(validScript))
        throw new Error('Invalid V8 coverage result');
      return /** @type {import('node:inspector').Profiler.ScriptCoverage[]} */ (data['result']);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 5) await delay(40);
  }
  throw failure;
}
