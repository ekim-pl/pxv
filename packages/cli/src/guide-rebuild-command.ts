import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CliContext } from './arguments.js';

const execFileAsync = promisify(execFile);
const checkoutFiles = [
  'pnpm-workspace.yaml',
  'tools/optional/publishing/rebuild.mjs',
  'packages/release/src/docs.ts',
  'packages/cli/src/cli.ts',
] as const;
type CommandRunner = (command: string, args: string[], cwd: string, context: CliContext) => Promise<void>;
export interface GuideRebuildDependencies {
  currentDirectory?: string;
  execute?: CommandRunner;
}

async function containsCheckout(path: string): Promise<boolean> {
  const files = await Promise.all(
    checkoutFiles.map((file) =>
      access(join(path, file)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return files.every(Boolean);
}

async function checkoutRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    if (await containsCheckout(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function run(command: string, args: string[], cwd: string, context: CliContext): Promise<void> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (stdout.trim()) context.io.out(stdout.trimEnd());
  if (stderr.trim()) context.io.error(stderr.trimEnd());
}

async function buildRenderer(root: string, context: CliContext, execute: CommandRunner): Promise<void> {
  try {
    await execute('pnpm', ['build'], root, context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await execute('corepack', ['pnpm', 'build'], root, context);
  }
}

function outputDirectory(context: CliContext, callerDirectory: string, root: string): string | undefined {
  const policy = context.values['policy'];
  const output = context.values['output-dir'];
  if (policy && !output) throw new Error('Policy booklets require an explicit --output-dir');
  if (!output) return undefined;
  const destination = resolve(callerDirectory, context.value('output-dir'));
  const guides = join(root, 'guides');
  if (policy && (destination === guides || destination.startsWith(`${guides}${sep}`)))
    throw new Error('Policy booklets require an output directory outside the authoritative guides directory');
  return destination;
}

function rebuildArguments(context: CliContext, callerDirectory: string, root: string): string[] {
  const args: string[] = [];
  const output = outputDirectory(context, callerDirectory, root);
  if (output) args.push('--output-dir', output);
  if (context.values['policy']) args.push('--policy', resolve(callerDirectory, context.value('policy')));
  if (context.values['chromium']) args.push('--chromium', context.value('chromium'));
  if (context.flag('html-only')) args.push('--html-only');
  if (context.flag('no-render')) args.push('--no-render');
  return args;
}

export async function guidesRebuildCommand(
  context: CliContext,
  dependencies: GuideRebuildDependencies = {},
): Promise<number | undefined> {
  if (context.section !== 'guides') return undefined;
  if (context.command !== 'rebuild') throw new Error('Choose guides rebuild');
  const callerDirectory = dependencies.currentDirectory ?? process.cwd();
  const root = await checkoutRoot(callerDirectory);
  if (!root)
    throw new Error(
      'The guides renderer requires a pxv source checkout with its development toolchain. Run this command from the repository checkout; installed builds do not include it.',
    );
  const args = rebuildArguments(context, callerDirectory, root);
  context.io.out(`Building guide renderer in ${root}`);
  const execute = dependencies.execute ?? run;
  await buildRenderer(root, context, execute);
  await execute(
    process.execPath,
    [join(root, 'tools/optional/publishing/rebuild.mjs'), ...args],
    root,
    context,
  );
  context.output({ rebuilt: true });
  return 0;
}
