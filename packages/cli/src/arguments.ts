import type { ProductDescriptor, SelectedTarget } from '@pxv/contracts';
import type { ProjectContext } from '@pxv/engine';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { application } from './context.js';
import { productAt, resourceRoot } from './context.js';
export interface CliIo {
  out(this: void, value: string): void;
  error(this: void, value: string): void;
  confirm?(this: void, message: string): Promise<boolean>;
}
const defaultIo: CliIo = {
  out: (value) => stdout.write(`${value}\n`),
  error: (value) => process.stderr.write(`${value}\n`),
};
const stringFlags = [
  'project-root',
  'resource-root',
  'policy',
  'path',
  'asset',
  'serial',
  'model',
  'codename',
  'kind',
  'transport',
  'mode',
  'group',
  'plan',
  'run',
  'review-file',
  'operator',
  'check',
  'note',
  'locale',
  'recipient',
  'after',
  'jobs',
  'file',
  'registry',
  'package',
  'version',
  'extension',
  'contribution',
  'command',
  'input-file',
  'license',
  'execution',
  'image',
  'docker-mode',
  'evidence',
  'output',
  'type',
  'endpoint',
  'pair-endpoint',
  'seedvault-adapter',
  'output-dir',
  'chromium',
  'passphrase-file',
  'new-passphrase-file',
  'record-revision',
] as const;
const booleanFlags = [
  'help',
  'yes',
  'json',
  'all',
  'dry-run',
  'allow-mutations',
  'debugging-off',
  'erased',
  'inspected',
  'html-only',
  'no-render',
] as const;
const options: Record<string, { type: 'string' | 'boolean' }> = {};
for (const name of stringFlags) options[name] = { type: 'string' };
for (const name of booleanFlags) options[name] = { type: 'boolean' };

function help(product: ProductDescriptor, version: string): string {
  return (
    `${product.command} ${version} — ${product.name}\n\n` +
    `project init --path NEW_DIRECTORY [--policy FILE]\npolicy validate | policy lock | policy convert --output FILE\ninventory list | inventory enroll --asset ID --serial SERIAL --model MODEL --codename CODE --yes\n` +
    `host doctor | host adb-start | host bootstrap --file APPROVED_ARCHIVE.json --license ID --path NEW_DIRECTORY\nhost build-helper --type probe|setup|e2e\nhost docker-prepare | docker-adb-start --image IMAGE | docker-adb-stop\n` +
    `device inspect | plan | guided | provision | create-users | deploy | install-os | report | attest | finalize | recover\n` +
    `  --project-root DIRECTORY --asset ID [--transport usb|wifi|emulator] [--dry-run] [--yes]\n` +
    `fleet provision --all|--group GROUP [--jobs 2] [--yes]\nfleet inspect | plan | guided | install-os --all|--group GROUP\nagent runs | status --run ID [--after CURSOR] | cancel --run ID | resume --run ID --yes | refresh --run ID | execute --plan ID --review-file FILE --operator NAME\n` +
    (product.features?.seedvault === false
      ? `Seedvault backup/restore is an optional feature disabled in this product.\n`
      : `seedvault inspect | backup | restore [--file REQUEST.json] [--seedvault-adapter FILE] [--dry-run]\nseedvault report --run ID | connections | connect --endpoint HOST:PORT [--pair-endpoint HOST:PORT]\nseedvault disconnect --endpoint HOST:PORT [--run CONNECTION_ID --inspected]\n`) +
    `mcp serve [--allow-mutations]\n` +
    `registry init | list | show --asset ID | history --asset ID\nregistry update --asset ID --file PRIVATE.json --record-revision N [--yes]\nregistry reveal --asset ID --output PRIVATE_FILE [--record-revision N] | rekey | reconcile\n  [--passphrase-file PRIVATE_FILE] (otherwise a hidden local prompt)\n` +
    (product.features?.extensions === false
      ? `Trusted extensions are an optional feature disabled in this product.\n`
      : `extension install|update --package NAME --version EXACT --registry HTTPS\nextension install --file PACKAGE.tgz | list | inspect | remove | invoke\nextension policy|guide|adapter --extension ID --contribution PATH\n`) +
    `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT [--erased]\n` +
    `handoff accept --asset ID --recipient NAME --debugging-off --yes\nhandoff export --asset ID --output DIRECTORY [--locale en|pl]\nguide operator|recipient|project [--locale en|pl]\n` +
    `guides rebuild [--policy FILE --output-dir DIR] [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]\n` +
    `Use --execution docker --image EXPLICIT_IMAGE --docker-mode direct|host-adb for container execution.\n` +
    `Device mutations require an enrolled target and explicit review. Physical confirmations remain on the phone.`
  );
}

export async function confirmation(io: CliIo, message: string, approved: boolean): Promise<void> {
  if (approved) return;
  if (io.confirm) {
    if (await io.confirm(message)) return;
    throw new Error('Cancelled');
  }
  if (!stdin.isTTY) throw new Error('Review the plan and use --yes in non-interactive execution');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    if ((await prompt.question(`${message} [y/N] `)).trim().toLowerCase() !== 'y')
      throw new Error('Cancelled');
  } finally {
    prompt.close();
  }
}

export async function workerLauncher(): Promise<string> {
  const installed = fileURLToPath(new URL('./main.js', import.meta.url));
  return access(installed).then(
    () => installed,
    () => fileURLToPath(new URL('../dist/main.js', import.meta.url)),
  );
}

export interface CliContext {
  argv: string[];
  io: CliIo;
  values: Record<string, unknown>;
  value(this: void, name: (typeof stringFlags)[number], fallback?: string): string;
  flag(this: void, name: (typeof booleanFlags)[number]): boolean;
  output(this: void, result: unknown): void;
  section: string | undefined;
  command: string | undefined;
  resources: string;
  product: ProductDescriptor;
  version: string;
  projectRoot: string;
  extensionRoot: string;
  dockerMode: string | undefined;
  buildMetadata: { version?: unknown; command?: unknown };
}
export interface ProjectCliContext extends CliContext {
  project: ProjectContext;
  targets(this: void): SelectedTarget[];
}
export interface ApplicationCliContext extends ProjectCliContext {
  app: Awaited<ReturnType<typeof application>>;
  signal: AbortSignal;
  launcher: string;
}

export async function parseCli(argv: string[], io: CliIo = defaultIo): Promise<CliContext> {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const values: Record<string, unknown> = parsed.values;
  const positionals = parsed.positionals;
  const value = (name: (typeof stringFlags)[number], fallback?: string): string => {
    const found = values[name];
    if (typeof found === 'string') return found;
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  };
  const flag = (name: (typeof booleanFlags)[number]): boolean => values[name] === true;
  const output = (result: unknown): void => io.out(JSON.stringify(result, null, 2));
  const [section, command] = positionals;
  const resources = await resourceRoot(
    typeof values['resource-root'] === 'string' ? values['resource-root'] : undefined,
  );
  const product = await productAt(resources);
  const buildMetadata: { version?: unknown; command?: unknown } = await readFile(
    join(resources, 'candidate.json'),
    'utf8',
  ).then(
    (text) => JSON.parse(text) as { version?: unknown; command?: unknown },
    () => ({}),
  );
  const version = typeof buildMetadata.version === 'string' ? buildMetadata.version : product.upstreamVersion;
  const projectRoot = resolve(value('project-root', process.env['PXV_ROOT'] ?? process.cwd()));
  const extensionRoot =
    process.env['PXV_EXTENSION_ROOT'] ??
    join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share'), 'pxv/extensions');
  const dockerMode = process.env['PXV_DOCKER_MODE'];
  return {
    argv,
    io,
    values,
    value,
    flag,
    output,
    section,
    command,
    resources,
    product,
    version,
    projectRoot,
    extensionRoot,
    dockerMode,
    buildMetadata,
  };
}
export function introductoryCommand(context: CliContext): number | undefined {
  const { section, flag, io, product, version, buildMetadata } = context;
  if (!section || flag('help') || section === 'help') {
    io.out(
      help(
        typeof buildMetadata.command === 'string' ? { ...product, command: buildMetadata.command } : product,
        version,
      ),
    );
    return 0;
  }
  if (section === 'version') {
    io.out(version);
    return 0;
  }
  return undefined;
}
