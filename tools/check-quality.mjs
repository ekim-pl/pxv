import { execFileSync } from 'node:child_process';
import { writeMetrics, sourceFiles } from './lib/metrics.mjs';
import { qualityExecutable } from './lib/quality-tools.mjs';
import { shellLauncher, dockerEntrypoint } from '../packages/release/dist/launchers.js';
const root = process.cwd();
const legacyFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => /\.(?:py|pyc|pyo)$/u.test(path));
if (legacyFiles.length) throw new Error(`Repository-owned Python leftovers: ${legacyFiles.join(', ')}`);
const report = await writeMetrics(root);
const shellcheck = await qualityExecutable('shellcheck');
const shell = [...(await sourceFiles('bin', /./u)), 'guides/rebuild.sh'];
execFileSync(shellcheck, shell, { stdio: 'inherit', timeout: 60_000 });
for (const script of [shellLauncher(undefined), shellLauncher('quality-preview'), dockerEntrypoint()]) {
  execFileSync(shellcheck, ['--shell=sh', '-'], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 60_000,
  });
  execFileSync('sh', ['-n'], { input: script, stdio: ['pipe', 'inherit', 'inherit'], timeout: 60_000 });
}
execFileSync('bash', ['bin/check-shell-syntax'], { stdio: 'inherit', timeout: 60_000 });
execFileSync('cargo', ['fmt', '--manifest-path', 'native/supervisor/Cargo.toml', '--check'], {
  stdio: 'inherit',
  timeout: 60_000,
});
execFileSync(
  'cargo',
  [
    'clippy',
    '--manifest-path',
    'native/supervisor/Cargo.toml',
    '--locked',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ],
  { stdio: 'inherit', timeout: 60_000 },
);
if (report.failures.length) {
  process.stderr.write(report.failures.join('\n') + '\n');
  process.exitCode = 1;
} else process.stdout.write(`Strict metrics passed for ${report.modules.length} first-party modules.\n`);
