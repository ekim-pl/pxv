import { convertPolicyToV2, parseDocument, validatePolicyDocument } from '@pxv/contracts';
import { assertProjectFresh, createProject, writePolicyLock } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CliContext, ProjectCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { renderProjectGuide } from './guided.js';

export async function staticGuide(context: CliContext): Promise<number | undefined> {
  const { io, value, section, command, resources } = context;
  if (section === 'guide' && command !== 'project') {
    if (command !== 'operator' && command !== 'recipient')
      throw new Error('Choose the operator or recipient guide');
    const locale = value('locale', 'en');
    if (!['en', 'pl'].includes(locale)) throw new Error('Guide locale must be en or pl');
    io.out(
      await readFile(
        join(
          resources,
          'guides/source/markdown',
          `${command === 'recipient' ? 'user' : command}-${locale}.md`,
        ),
        'utf8',
      ),
    );
    return 0;
  }
  return undefined;
}
export async function initializeProject(context: CliContext): Promise<number | undefined> {
  const { values, value, output, section, command, resources, product } = context;
  if (section === 'project' && command === 'init') {
    const policyPath =
      typeof values['policy'] === 'string'
        ? resolve(values['policy'])
        : join(resources, product.defaultPolicy);
    const policy = validatePolicyDocument(parseDocument(await readFile(policyPath, 'utf8')));
    const project = await createProject(resolve(value('path')), product, policy, resources);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    await store.close();
    await writePolicyLock(project);
    output({ root: project.root, projectId: project.config.id, policy: project.policy.id });
    return 0;
  }
  return undefined;
}
export function projectGuide(context: ProjectCliContext): number | undefined {
  const { io, value, section, command, product } = context;
  const { project } = context;
  if (section === 'guide' && command === 'project') {
    const locale = value('locale', 'en');
    const kind = value('kind', 'pixel');
    if (locale !== 'en' && locale !== 'pl') throw new Error('Guide locale must be en or pl');
    if (kind !== 'pixel' && kind !== 'emulator') throw new Error('Guide kind must be pixel or emulator');
    io.out(renderProjectGuide(product, project.policy, kind, locale));
    return 0;
  }
  return undefined;
}
export async function policyCommand(context: ProjectCliContext): Promise<number | undefined> {
  const { io, flag, output, section, command } = context;
  const { project } = context;
  if (section === 'policy') {
    if (command === 'convert') {
      await assertProjectFresh(project);
      const destination = resolve(context.value('output'));
      await writeFile(destination, `${JSON.stringify(convertPolicyToV2(project.policy), null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      output({
        output: destination,
        schemaVersion: 2,
        sourceUnchanged: true,
        next: 'Review the converted file, select it in pxv.project.json, then run policy lock and prepare a fresh reviewed plan. Existing approvals are not reused.',
      });
      return 0;
    }
    if (command === 'lock') {
      await confirmation(io, 'Record the current policy and extension lock?', flag('yes'));
      await writePolicyLock(project);
    } else if (command !== 'validate') throw new Error('Unknown policy command');
    output({ valid: true, policyDigest: project.resolved.digest });
    return 0;
  }
  return undefined;
}
