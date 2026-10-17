import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectCliContext } from './arguments.js';

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

export function registryOutputPath(context: ProjectCliContext): string {
  const output = resolve(context.value('output'));
  if (inside(join(context.project.root, 'secrets'), output)) return output;
  if (inside(context.project.root, output) || inside(context.resources, output))
    throw new Error('Reveal credentials under project secrets or outside the project and product resources');
  return output;
}
