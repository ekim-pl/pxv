import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {{version:string,url:string,archiveSha256:string,executable:string,sha256:string}} QualityTool */
/** @returns {Promise<Record<string,QualityTool>>} */
export async function qualityTools() {
  return JSON.parse(await readFile(new URL('../quality-tools.json', import.meta.url), 'utf8'));
}
export function qualityToolRoot() {
  return (
    process.env['PXV_QUALITY_TOOLS'] ??
    join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'pxv/quality-tools')
  );
}
/** @param {Uint8Array} bytes */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** @param {string} name */
export async function qualityExecutable(name) {
  const tool = (await qualityTools())[name];
  if (!tool) throw new Error(`Unknown quality tool ${name}`);
  const executable = join(qualityToolRoot(), tool.executable);
  const bytes = await readFile(executable).catch(() => {
    throw new Error(`Run pnpm quality:setup to install pinned ${name}`);
  });
  if (sha256(bytes) !== tool.sha256) throw new Error(`Quality tool integrity mismatch: ${name}`);
  return executable;
}
