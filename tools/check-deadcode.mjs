import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const reports = [];
/** @type {[string,string[]][]} */
const modes = [
  ['development', []],
  ['production', ['--production', '--strict']],
];
for (const [mode, args] of modes) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/knip/bin/knip.js', '--reporter', 'json', '--no-progress', ...args],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  reports.push({
    mode,
    status: result.status === 0 ? 'passed' : 'failed',
    findings: JSON.parse(result.stdout),
    diagnostics: result.stderr,
  });
}
await mkdir('.quality', { recursive: true });
await writeFile('.quality/deadcode.json', JSON.stringify({ reports }, null, 2) + '\n');
const failed = reports.filter((r) => r.status !== 'passed');
if (failed.length) {
  process.stderr.write(JSON.stringify(failed, null, 2) + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    'No unexplained unused files, dependencies or exports in development and strict production graphs.\n',
  );
