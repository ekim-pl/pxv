import { mkdir, writeFile } from 'node:fs/promises';
import { checkGraph } from './lib/repository-graph.mjs';
const reports = /** @type {const} */ (['development', 'production']).map((mode) =>
  checkGraph(process.cwd(), mode),
);
await mkdir('.quality', { recursive: true });
await writeFile('.quality/deadcode.json', JSON.stringify({ reports }, null, 2) + '\n');
const failed = reports.filter((r) => r.status !== 'passed');
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exitCode = 1;
} else console.log('Repository development and production graphs passed.');
