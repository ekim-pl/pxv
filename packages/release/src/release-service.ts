import { createCandidate, type CandidateOptions } from './candidate.js';
import { buildFormats, promoteNpm, type DistributionFormat, type BuildFormatsOptions } from './formats.js';

interface ReleaseServices {
  createCandidate: typeof createCandidate;
  buildFormats: typeof buildFormats;
  promoteNpm: typeof promoteNpm;
  write(text: string): void;
}
const services: ReleaseServices = {
  createCandidate,
  buildFormats,
  promoteNpm,
  write: (text) => {
    process.stdout.write(text);
  },
};
class ReleaseArguments {
  readonly command: 'promote' | 'preview';
  readonly args: string[];
  constructor(argv: string[]) {
    this.args = [...argv];
    this.command = this.args[0] === 'promote' ? 'promote' : 'preview';
    if (this.command === 'promote') this.args.shift();
    const values = new Set(
      this.command === 'promote'
        ? ['--artifacts', '--package', '--registry', '--allowed-signers', '--signer']
        : ['--formats', '--source-root', '--output-root', '--supervisor', '--signing-key', '--postject'],
    );
    const switches = new Set(this.command === 'promote' ? ['--dry-run'] : ['--release', '--no-oci-load']);
    for (let index = 0; index < this.args.length; index++) {
      const argument = this.args[index]!;
      if (values.has(argument)) {
        this.required(argument.slice(2));
        index++;
      } else if (!switches.has(argument)) throw new Error(`Unsupported release argument: ${argument}`);
    }
  }
  value(name: string): string | undefined {
    const index = this.args.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const result = this.args[index + 1];
    if (!result || result.startsWith('--')) throw new Error(`Missing --${name} value`);
    return result;
  }
  required(name: string): string {
    const result = this.value(name);
    if (!result) throw new Error(`Required --${name}`);
    return result;
  }
  has(name: string): boolean {
    return this.args.includes(`--${name}`);
  }
}
function candidateOptions(args: ReleaseArguments): CandidateOptions {
  const sourceRoot = args.value('source-root'),
    outputRoot = args.value('output-root'),
    nativeBinary = args.value('supervisor');
  return {
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(outputRoot ? { outputRoot } : {}),
    ...(nativeBinary ? { nativeBinary } : {}),
    preview: !args.has('release'),
  };
}
function formatOptions(args: ReleaseArguments): BuildFormatsOptions {
  const formats = (args.value('formats') ?? 'portable').split(',');
  if (formats.some((format) => !['portable', 'deb', 'npm', 'oci', 'sea'].includes(format)))
    throw new Error('Formats: portable,deb,npm,oci,sea');
  const signingKey = args.value('signing-key'),
    postject = args.value('postject');
  return {
    formats: formats as DistributionFormat[],
    loadDockerImage: !args.has('no-oci-load'),
    ...(signingKey ? { signingKey } : {}),
    ...(postject ? { postject } : {}),
  };
}
export async function runRelease(argv: string[], dependencies: ReleaseServices = services): Promise<void> {
  if (argv.includes('--help')) {
    dependencies.write(
      'Build preview (portable by default): --formats portable[,oci] [--source-root PATH] [--output-root PATH] [--signing-key KEY] [--no-oci-load]\nOptional compatibility formats: deb,npm,sea (experimental; explicit opt-in only)\nStable artifacts: --release --signing-key KEY\nPublish verified npm artifact: promote --artifacts PATH --package FILE.tgz --registry HTTPS --allowed-signers FILE --signer ID [--dry-run]\n',
    );
    return;
  }
  const args = new ReleaseArguments(argv);
  if (args.command === 'promote') {
    await dependencies.promoteNpm({
      artifactDirectory: args.required('artifacts'),
      packageFile: args.required('package'),
      registry: args.required('registry'),
      allowedSigners: args.required('allowed-signers'),
      signer: args.required('signer'),
      dryRun: args.has('dry-run'),
    });
    return;
  }
  const options = formatOptions(args);
  const candidate = await dependencies.createCandidate(candidateOptions(args));
  const artifacts = await dependencies.buildFormats(candidate, options);
  dependencies.write(
    `${JSON.stringify({ candidate: candidate.directory, version: candidate.manifest.version, artifacts }, null, 2)}\n`,
  );
}
