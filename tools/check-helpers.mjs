import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildJavaEnvironment, buildJavaExecutable, runBuildCommand } from './lib/build-command.mjs';
const directory = await mkdtemp(join(tmpdir(), 'pxv-helper-quality-'));
/** @type {{component:string,sha256:string,signerSha256:string}[]} */
const helpers = [];
try {
  await runBuildCommand(
    [
      buildJavaExecutable('javac'),
      '-Xlint:all',
      '-Werror',
      '--release',
      '17',
      '-d',
      directory,
      'resources/VerifyRepositoryIndex.java',
    ],
    { env: buildJavaEnvironment() },
  );
  const component = 'probe';
  const result = await runBuildCommand(
    [
      process.execPath,
      'tools/build-android.mjs',
      '--component',
      component,
      '--project-root',
      directory,
      '--resource-root',
      process.cwd(),
    ],
    { env: process.env, timeoutMs: 120_000 },
  );
  const parsed = JSON.parse(result);
  if (!/^[a-f0-9]{64}$/u.test(parsed.sha256) || !/^[a-f0-9]{64}$/u.test(parsed.signerSha256))
    throw new Error('Helper signature evidence is missing');
  helpers.push({ component, sha256: parsed.sha256, signerSha256: parsed.signerSha256 });
  await mkdir('.quality', { recursive: true });
  await writeFile(
    '.quality/helpers.json',
    JSON.stringify(
      { status: 'passed', ephemeralSigningKeys: true, verifierCompiled: true, helpers },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write('Java verifier and Android probe compiled; APK signature verified.\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
