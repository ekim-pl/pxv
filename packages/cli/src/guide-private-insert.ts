import { containedPath, loadProject } from '@pxv/engine';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { CliContext, ProjectCliContext } from './arguments.js';
import { registryOutputPath } from './registry-output.js';
import { exportRegistryInsert } from './registry-insert.js';
import { selectedContext } from './selection.js';

export interface GuidePrivateInsert {
  policyFile: string;
  export(): Promise<void>;
}

async function resolvedDestination(path: string): Promise<string> {
  try {
    await lstat(path);
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(await resolvedDestination(dirname(path)), basename(path));
  }
}

async function validateDestination(context: ProjectCliContext, caller: string): Promise<string> {
  const output = registryOutputPath({
    ...context,
    value: (name, fallback) =>
      name === 'output'
        ? resolve(caller, context.value('private-insert-output'))
        : context.value(name, fallback),
  });
  const shared = await resolvedDestination(resolve(caller, context.value('output-dir')));
  const privatePath = await resolvedDestination(output);
  const child = relative(shared, privatePath);
  if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)))
    throw new Error('Private insert output must be outside the shared guide output directory');
  if (!output.toLowerCase().endsWith('.pdf')) throw new Error('Private insert output must be a PDF file');
  return output;
}

export async function prepareGuidePrivateInsert(
  context: CliContext,
  caller: string,
): Promise<GuidePrivateInsert | undefined> {
  if (context.values['private-insert-output'] === undefined) {
    if (['asset', 'passphrase-file', 'locale'].some((name) => context.values[name] !== undefined))
      throw new Error('Private insert options require --private-insert-output');
    return undefined;
  }
  const chromium = privateGuideOptions(context);
  const project = await loadProject(context.projectRoot, context.product, context.resources);
  const selected = selectedContext(context, project);
  if (!project.inventory.devices.some((entry) => entry.assetId === context.value('asset')))
    throw new Error('Registry asset is not enrolled');
  const output = await validateDestination(selected, caller);
  const insertContext = {
    ...selected,
    value: (name, fallback) =>
      name === 'output' ? output : name === 'chromium' ? chromium : context.value(name, fallback),
  } satisfies ProjectCliContext;
  return {
    policyFile: await containedPath(project.root, project.config.policyFile),
    export: () => exportRegistryInsert(insertContext),
  };
}

function privateGuideOptions(context: CliContext): string {
  if (context.dockerMode) throw new Error('Private insert generation requires local host execution');
  for (const name of ['project-root', 'asset', 'output-dir'] as const)
    if (context.values[name] === undefined) throw new Error(`Private insert generation requires --${name}`);
  if (context.values['policy'] !== undefined)
    throw new Error('Private guide builds use the project policy; omit --policy');
  if (context.flag('html-only'))
    throw new Error('Private insert generation requires PDF output; omit --html-only');
  const chromium = context.value('chromium', process.env['PXV_CHROMIUM'] ?? '');
  if (!chromium) throw new Error('Private insert generation requires Chromium');
  const locale = context.value('locale', 'en');
  if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
  return chromium;
}
