import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { commandPathFlags, stringFlags, booleanFlags } from './command-registry.js';
import { parseArgs } from 'node:util';

export function mountPath(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n,"]/u.test(value))
    throw new Error(
      'Docker bind paths must be absolute and cannot contain CSV delimiters, quotes or newlines',
    );
  return value;
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}
export function dockerDestination(path: string): void {
  mountPath(path);
  const reserved = [
    '/project',
    '/control',
    '/extensions',
    '/adb-home',
    '/opt',
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/etc',
    '/dev',
    '/proc',
    '/sys',
    '/run',
  ];
  if (reserved.some((root) => inside(root, path) || inside(path, root)))
    throw new Error('Docker path collides with a runtime or control mount');
}
async function inputFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Docker input must be a regular file');
  const canonical = await realpath(path);
  dockerDestination(canonical);
  return canonical;
}
async function outputDirectory(path: string): Promise<string> {
  const stat = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()))
    throw new Error('Docker output must be an operator-owned directory');
  // Resolve existing ancestors before creating the requested destination.
  const canonical = await canonicalDestination(path);
  dockerDestination(canonical);
  return canonical;
}
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(await canonicalDestination(dirname(path)), basename(path));
  }
}
interface PathArgument {
  flag: string;
  kind: 'input' | 'output';
  index: number;
  inline: boolean;
  value: string;
}
function pathArguments(args: string[]): PathArgument[] {
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const name of stringFlags) options[name] = { type: 'string' };
  for (const name of booleanFlags) options[name] = { type: 'boolean' };
  const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  const paths = commandPathFlags(parsed.positionals);
  const found: PathArgument[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const [flag] = argument.split('=');
    const kind = paths[flag!];
    if (!kind) continue;
    const inline = argument.includes('=');
    const value = inline ? argument.slice(argument.indexOf('=') + 1) : args[++index];
    if (!value) throw new Error(`${flag} requires a path`);
    found.push({ flag: flag!, kind, index, inline, value });
  }
  return found;
}
export async function dockerPaths(
  args: string[],
  project: string,
): Promise<{ args: string[]; mounts: string[] }> {
  const rewritten = [...args];
  const mounts = new Map<string, boolean>();
  const outputs: string[] = [];
  for (const argument of pathArguments(args)) {
    const path = mountPath(resolve(argument.value));
    dockerDestination(path);
    const canonical = argument.kind === 'input' ? await inputFile(path) : await outputDirectory(path);
    if (argument.kind === 'output') outputs.push(canonical);
    if (!inside(project, canonical)) mounts.set(canonical, argument.kind === 'output');
    rewritten[argument.index] = argument.inline ? `${argument.flag}=${canonical}` : canonical;
  }
  for (const output of outputs) await mkdir(output, { recursive: true, mode: 0o700 });
  return {
    args: rewritten,
    mounts: [...mounts].flatMap(([path, writable]) => [
      '--mount',
      `type=bind,src=${path},dst=${path}${writable ? '' : ',readonly'}`,
    ]),
  };
}
