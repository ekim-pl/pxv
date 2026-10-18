import { execFileSync } from 'node:child_process';
import { writeMetrics, sourceFiles } from './lib/metrics.mjs';
import { qualityExecutable } from './lib/quality-tools.mjs';
import { shellLauncher, dockerEntrypoint } from '../packages/release/dist/launchers.js';
const root = process.cwd();
const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !['--metrics-only', '--checks-only'].includes(mode)))
  throw new Error('Use --metrics-only, --checks-only, or no flags');
if (mode !== '--metrics-only') await checkTools();
if (mode !== '--checks-only') {
  const report = await writeMetrics(root);
  if (report.failures.length) {
    process.stderr.write(report.failures.join('\n') + '\n');
    process.exitCode = 1;
  } else process.stdout.write(`Strict metrics passed for ${report.modules.length} first-party modules.\n`);
}

async function checkTools() {
  const legacyFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /\.(?:py|pyc|pyo)$/u.test(path));
  if (legacyFiles.length) throw new Error(`Repository-owned Python leftovers: ${legacyFiles.join(', ')}`);
  const shellcheck = await qualityExecutable('shellcheck');
  const shell = await sourceFiles('bin', /./u);
  execFileSync(shellcheck, shell, { stdio: 'inherit', timeout: 60_000 });
  for (const path of shell) execFileSync('bash', ['-n', path], { stdio: 'inherit', timeout: 60_000 });
  for (const script of [shellLauncher(undefined), shellLauncher('quality-preview'), dockerEntrypoint()]) {
    execFileSync(shellcheck, ['--shell=sh', '-'], {
      input: script,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 60_000,
    });
    execFileSync('sh', ['-n'], { input: script, stdio: ['pipe', 'inherit', 'inherit'], timeout: 60_000 });
  }
}
