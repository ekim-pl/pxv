import { readFile, readdir, open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const prohibited =
  /^(?:@(?:oxc(?:-[a-z-]+)?|oxlint|oxfmt|rolldown|swc|napi-rs|unrs)\/|(?:oxc|oxlint|oxfmt|rolldown|lightningcss|unrs-resolver|@parcel\/watcher|@tailwindcss\/oxide|sass-embedded|rust-code-analysis|@biomejs\/biome)(?:$|[-/]))/u;
/** Audit every lock entry, including optional platform dependencies.
 * @param {string} lock */
export function auditLock(lock) {
  const failures = [];
  for (const match of lock.matchAll(/^ {2}'?([^\s']+)@[^\s]+:$/gmu))
    if (prohibited.test(match[1] ?? '')) failures.push('Prohibited Rust package: ' + match[1]);
  return failures;
}
/** @param {string} directory @returns {Promise<string[]>} */
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
// Identify foreign payloads for rejection, not as supported execution targets.
const machOMagic = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);
/** @param {string} path */
async function binaryKind(path) {
  const fd = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(4);
    await fd.read(bytes, 0, 4, 0);
    const magic = bytes.toString('hex');
    if (bytes.subarray(0, 2).toString() === 'MZ' || machOMagic.has(magic)) return 'foreign';
    if (magic === '0061736d' || magic === '7f454c46' || /\.(?:node|wasm)$/u.test(path)) return 'reviewable';
    return undefined;
  } finally {
    await fd.close();
  }
}
/** @param {string} root */
export async function auditDependencies(root) {
  const failures = auditLock(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
  /** @type {{path:string,sha256:string,reason:string}[]} */
  const reviewed = JSON.parse(await readFile(join(root, 'tools/reviewed-binaries.json'), 'utf8'));
  const seen = new Set();
  for (const path of await walk(join(root, 'node_modules/.pnpm'))) {
    const kind = await binaryKind(path);
    if (!kind) continue;
    const name = relative(join(root, 'node_modules/.pnpm'), path);
    if (kind === 'foreign') {
      failures.push('Non-Linux native artifact is prohibited: ' + name);
      continue;
    }
    const entry = reviewed.find((v) => v.path === name);
    const sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (!entry || entry.sha256 !== sha256 || !entry.reason)
      failures.push('Unreviewed native/WASM artifact: ' + name);
    else seen.add(name);
  }
  for (const entry of reviewed)
    if (!seen.has(entry.path)) failures.push('Stale binary review: ' + entry.path);
  return failures;
}
