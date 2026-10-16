#!/usr/bin/env node
import { createCandidate } from './candidate.js';
import { buildFormats, promoteNpm, type DistributionFormat } from './formats.js';

export async function runRelease(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    process.stdout.write(
      'Build preview: --formats portable,deb,npm,oci[,sea] [--source-root PATH] [--output-root PATH] [--signing-key KEY] [--no-oci-load]\nStable artifacts: --release --signing-key KEY\nPublish verified npm artifact: promote --artifacts PATH --package FILE.tgz --registry HTTPS --allowed-signers FILE --signer ID [--dry-run]\n',
    );
    return;
  }
  const args = [...argv];
  const command = args[0] === 'promote' ? args.shift() : 'preview';
  const values = new Set(
    command === 'promote'
      ? ['--artifacts', '--package', '--registry', '--allowed-signers', '--signer']
      : ['--formats', '--source-root', '--output-root', '--supervisor', '--signing-key', '--postject'],
  );
  const switches = new Set(command === 'promote' ? ['--dry-run'] : ['--release', '--no-oci-load']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (values.has(argument)) {
      index++;
      continue;
    }
    if (!switches.has(argument)) throw new Error(`Unsupported release argument: ${argument}`);
  }
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const result = args[index + 1];
    if (!result || result.startsWith('--')) throw new Error(`Missing --${name} value`);
    return result;
  };
  const required = (name: string): string => {
    const result = value(name);
    if (!result) throw new Error(`Required --${name}`);
    return result;
  };
  if (command === 'promote') {
    await promoteNpm({
      artifactDirectory: required('artifacts'),
      packageFile: required('package'),
      registry: required('registry'),
      allowedSigners: required('allowed-signers'),
      signer: required('signer'),
      dryRun: args.includes('--dry-run'),
    });
    return;
  }
  const formats = (value('formats') ?? 'portable,deb,npm,oci').split(',');
  if (formats.some((format) => !['portable', 'deb', 'npm', 'oci', 'sea'].includes(format)))
    throw new Error('Formats: portable,deb,npm,oci,sea');
  const sourceRoot = value('source-root');
  const outputRoot = value('output-root');
  const nativeBinary = value('supervisor');
  const candidate = await createCandidate({
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(outputRoot ? { outputRoot } : {}),
    ...(nativeBinary ? { nativeBinary } : {}),
    preview: !args.includes('--release'),
  });
  const signingKey = value('signing-key');
  const postject = value('postject');
  const artifacts = await buildFormats(candidate, {
    formats: formats as DistributionFormat[],
    loadDockerImage: !args.includes('--no-oci-load'),
    ...(signingKey ? { signingKey } : {}),
    ...(postject ? { postject } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ candidate: candidate.directory, version: candidate.manifest.version, artifacts }, null, 2)}\n`,
  );
}

runRelease(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Release build failed'}\n`);
  process.exitCode = 1;
});
