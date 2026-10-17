import type { ProductDescriptor, SelectedTarget } from '@pxv/contracts';
import type { ProjectContext } from '@pxv/engine';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { application } from './context.js';
import { productAt, resourceRoot } from './context.js';
import {
  assertCommandFeature,
  booleanFlags,
  commandHelp,
  stringFlags,
  textualCommand,
  validateCommand,
} from './command-registry.js';
import { cliOutput } from './output.js';
export interface CliIo {
  out(this: void, value: string): void;
  error(this: void, value: string): void;
  confirm?(this: void, message: string): Promise<boolean>;
}
const defaultIo: CliIo = {
  out: (value) => stdout.write(`${value}\n`),
  error: (value) => process.stderr.write(`${value}\n`),
};
const options: Record<string, { type: 'string' | 'boolean' }> = {};
for (const name of stringFlags) options[name] = { type: 'string' };
for (const name of booleanFlags) options[name] = { type: 'boolean' };

export async function confirmation(io: CliIo, message: string, approved: boolean): Promise<void> {
  if (approved) return;
  if (io.confirm) {
    if (await io.confirm(message)) return;
    throw new Error('Cancelled');
  }
  if (!stdin.isTTY) throw new Error('Review the plan and use --yes in non-interactive execution');
  const prompt = createInterface({ input: stdin, output: stderr });
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
  flushOutput(this: void): void;
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
  validateCommand(positionals, values);
  const value = (name: (typeof stringFlags)[number], fallback?: string): string => {
    const found = values[name];
    if (typeof found === 'string') return found;
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  };
  const flag = (name: (typeof booleanFlags)[number]): boolean => values[name] === true;
  const [section, command] = positionals;
  const resources = await resourceRoot(
    typeof values['resource-root'] === 'string' ? values['resource-root'] : undefined,
  );
  const product = await productAt(resources);
  if (!flag('help')) assertCommandFeature(positionals, product);
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
  const emitter = cliOutput(io, flag('json'), product.command, projectRoot);
  const progressIo = flag('json') && !textualCommand(positionals, values) ? { ...io, out: io.error } : io;
  return {
    argv,
    io: progressIo,
    values,
    value,
    flag,
    output: emitter.output,
    flushOutput: emitter.flush,
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
      commandHelp(
        typeof buildMetadata.command === 'string' ? { ...product, command: buildMetadata.command } : product,
        version,
        section === 'help'
          ? []
          : [section, context.command].filter((item): item is string => item !== undefined),
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
