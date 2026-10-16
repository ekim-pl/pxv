import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { qualityToolRoot, qualityTools, sha256 } from './lib/quality-tools.mjs';
/** @param {Response} response @param {string} name */
async function boundedArchive(response, name) {
  const limit = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body)
    throw new Error(`Download size failure: ${name}`);
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new Error(`Download size failure: ${name}`);
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Quality tools require Linux x86_64');
const directory = qualityToolRoot();
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const [name, tool] of Object.entries(await qualityTools())) {
  const executable = join(directory, tool.executable);
  const existing = await readFile(executable).catch(() => undefined);
  if (existing && sha256(existing) === tool.sha256) continue;
  const response = await fetch(tool.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Unable to download ${name}: ${response.status}`);
  const bytes = await boundedArchive(response, name);
  if (sha256(bytes) !== tool.archiveSha256) throw new Error(`Download integrity failure: ${name}`);
  const archive = join(directory, `${name}.download`);
  await writeFile(archive, bytes, { mode: 0o600 });
  try {
    execFileSync('tar', ['-xf', archive, '-C', directory], { timeout: 60_000 });
    if (sha256(await readFile(executable)) !== tool.sha256)
      throw new Error(`Extracted tool mismatch: ${name}`);
  } finally {
    await rm(archive, { force: true });
  }
}
process.stdout.write(`Pinned quality tools ready: ${directory}\n`);
