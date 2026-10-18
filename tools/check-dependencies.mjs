import { mkdir, writeFile } from 'node:fs/promises';
import { auditDependencies } from './lib/dependency-audit.mjs';
const failures = await auditDependencies(process.cwd());
await mkdir('.quality', { recursive: true });
await writeFile(
  '.quality/dependencies.json',
  JSON.stringify({ status: failures.length ? 'failed' : 'passed', failures }, null, 2) + '\n',
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('Lockfile and installed native/WASM artifacts passed review.');
