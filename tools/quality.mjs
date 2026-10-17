import { spawn } from 'node:child_process';
import { sourceIdentity, writeMetrics } from './lib/metrics.mjs';
import { qualityReport } from './lib/quality-report.mjs';
import { packageManagerCommand } from './lib/package-manager.mjs';
/** @param {string} stage */
async function run(stage) {
  // The final report measures metrics once, after every source-bound check.
  const command = packageManagerCommand([stage === 'check' ? 'check:static' : stage]);
  const child = spawn(command.file, command.args, { stdio: 'inherit', env: process.env });
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  if (code !== 0) throw new Error(`Quality stage failed: ${stage}`);
}
const report = await qualityReport(process.cwd(), { run, metrics: writeMetrics, source: sourceIdentity });
if (report.status === 'failed') {
  process.stderr.write(report.failures.join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    'All strict quality gates passed. Reports: .quality/report.json and .quality/report.md\n',
  );
