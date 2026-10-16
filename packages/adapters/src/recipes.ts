import {
  digest,
  validateRecipe,
  type AndroidUserIdentity,
  type RecipePolicy,
  type RecipeStep,
  type SelectedTarget,
  type UiSelector,
  type RecoveryObligation,
} from '@pxv/contracts';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { AndroidAdapter } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import { copySnapshot, fileDigest } from './files.js';
import type { ObligationWriter } from './network.js';

export interface UiNode {
  attributes: Record<string, string>;
}
export interface RecipeInput {
  path: string;
  sha256: string;
}
export interface RecipeOptions extends OperationOptions {
  operationId: string;
  obligations: ObligationWriter;
  inputs?: Record<string, RecipeInput>;
}
export type RecipeResult =
  | {
      status: 'measured';
      capability: 'app-setup';
      recipeDigest: string;
      postconditions: number;
      verification: 'visible-ui-only';
    }
  | { status: 'manual-pending'; capability: 'app-setup'; recipeDigest: string; instructions: string };
function decodeXml(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(value))
    throw new AdapterError('UI XML contains unsupported entities');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match: string, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const named = known[entity];
    if (named) return named;
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      throw new AdapterError('UI XML contains invalid codepoints');
    return String.fromCodePoint(code);
  });
}
/** A strict parser for the bounded hierarchy/node-only uiautomator format. No DTDs. */
export function parseUiSnapshot(xml: string): UiNode[] {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!|<\?[^x]|[\0]/.test(xml))
    throw new AdapterError('UI snapshot exceeds limits or uses unsupported XML');
  const nodes: UiNode[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let roots = 0;
  const tokens = xml.matchAll(/<[^>]*>/g);
  for (const token of tokens) {
    const at = token.index;
    if (xml.slice(cursor, at).trim()) throw new AdapterError('UI snapshot contains unexpected text');
    const raw = token[0];
    cursor = at + raw.length;
    if (
      /^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(yes|no)\3)?\s*\?>$/i.test(
        raw,
      )
    ) {
      if (at !== 0) throw new AdapterError('UI XML declaration is misplaced');
      continue;
    }
    const close = /^<\/(hierarchy|node)\s*>$/.exec(raw);
    if (close?.[1]) {
      if (stack.pop() !== close[1]) throw new AdapterError('UI XML nesting is malformed');
      continue;
    }
    const opening = /^<(hierarchy|node)(\s[\s\S]*?)?\s*(\/?)>$/.exec(raw);
    if (!opening?.[1]) throw new AdapterError('UI XML contains unsupported elements');
    const tag = opening[1];
    if (tag === 'hierarchy') {
      if (stack.length || roots++) throw new AdapterError('UI hierarchy root is ambiguous');
    } else if (!stack.length || stack[0] !== 'hierarchy')
      throw new AdapterError('UI node is outside the hierarchy');
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    const source = opening[2] ?? '';
    let last = 0;
    for (const attribute of source.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"<>]*)"/g)) {
      if (source.slice(last, attribute.index).trim())
        throw new AdapterError('UI XML attributes are malformed');
      const name = attribute[1];
      const value = attribute[2];
      if (!name || value === undefined || Object.hasOwn(attributes, name))
        throw new AdapterError('UI XML attributes are duplicated');
      attributes[name] = decodeXml(value);
      last = attribute.index + attribute[0].length;
    }
    if (source.slice(last).trim()) throw new AdapterError('UI XML attributes are malformed');
    if (tag === 'node') {
      nodes.push({ attributes });
      if (nodes.length > 10_000) throw new AdapterError('UI snapshot contains too many nodes');
    }
    if (!opening[3]) {
      stack.push(tag);
      if (stack.length > 100) throw new AdapterError('UI XML nesting exceeds limits');
    }
  }
  if (xml.slice(cursor).trim() || roots !== 1 || stack.length)
    throw new AdapterError('UI XML hierarchy is incomplete');
  return nodes;
}
export function matchUiNode(
  nodes: readonly UiNode[],
  selector: UiSelector,
  packageId: string,
): UiNode | undefined {
  const names: Record<string, string> = {
    resourceId: 'resource-id',
    text: 'text',
    description: 'content-desc',
    checked: 'checked',
  };
  const matches = nodes.filter(
    (node) =>
      node.attributes['package'] === packageId &&
      node.attributes['enabled'] === 'true' &&
      Object.entries(selector).every(([key, value]) => node.attributes[names[key] ?? ''] === String(value)),
  );
  if (matches.length > 1) throw new AdapterError('UI selector is ambiguous; review the pinned recipe');
  return matches[0];
}
const CONSENT = new Set([
  'com.android.vpndialogs',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
]);
export class RecipeService {
  constructor(readonly android: AndroidAdapter) {}
  async focus(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    packageId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.android.guardUser(target, user, signal);
    const current = (
      await this.android.shell(target, ['am', 'get-current-user'], signal ? { signal } : {})
    ).trim();
    if (current !== String(user.userId))
      throw new AdapterError(
        'Unlock and foreground the intended Android user before applying a UI recipe',
        'MANUAL_PENDING',
      );
    const windows = await this.android.shell(
      target,
      ['dumpsys', 'window', 'windows'],
      signal ? { signal } : {},
    );
    const matches = [...windows.matchAll(/mCurrentFocus=Window\{[^\n]*?\bu(\d+)\s+([A-Za-z0-9_.]+)\//g)];
    if (matches.length !== 1 || matches[0]?.[1] !== String(user.userId) || matches[0]?.[2] !== packageId)
      throw new AdapterError(
        'Unlock the intended Android user and focus the pinned application',
        'MANUAL_PENDING',
      );
  }
  async snapshot(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    packageId: string,
    signal?: AbortSignal,
  ): Promise<UiNode[]> {
    await this.focus(target, user, packageId, signal);
    const output = await this.android.shell(
      target,
      ['uiautomator', 'dump', '/proc/self/fd/1'],
      signal ? { signal } : {},
    );
    const start = output.indexOf('<?xml');
    const end = output.indexOf('</hierarchy>');
    if (start < 0 || end < start)
      throw new AdapterError(
        'Android did not provide a bounded UI snapshot through stdout',
        'MANUAL_PENDING',
      );
    const nodes = parseUiSnapshot(output.slice(start, end + '</hierarchy>'.length));
    if (nodes.some((node) => CONSENT.has(node.attributes['package'] ?? '')))
      throw new AdapterError(
        'Approve required Android permission or VPN consent privately on the device',
        'MANUAL_PENDING',
      );
    if (!nodes.some((node) => node.attributes['package'] === packageId))
      throw new AdapterError('The pinned app is not visible', 'MANUAL_PENDING');
    await this.focus(target, user, packageId, signal);
    return nodes;
  }
  async tap(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    packageId: string,
    node: UiNode,
    options: OperationOptions,
  ): Promise<void> {
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.attributes['bounds'] ?? '');
    if (!match) throw new AdapterError('UI node has no usable bounds');
    const [left, top, right, bottom] = match.slice(1).map(Number);
    if (
      left === undefined ||
      top === undefined ||
      right === undefined ||
      bottom === undefined ||
      left < 0 ||
      top < 0 ||
      right <= left ||
      bottom <= top ||
      right > 10000 ||
      bottom > 10000
    )
      throw new AdapterError('UI node bounds are outside the accepted range');
    await this.focus(target, user, packageId, options.signal);
    await this.android.shell(
      target,
      ['input', 'tap', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2))],
      { ...options, mutation: true },
    );
  }
  async verifyIdentity(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.android.guardUser(target, user, signal);
    const identity = await this.android.installedIdentity(target, user, recipe.packageId, signal);
    const fingerprint = (
      await this.android.shell(target, ['getprop', 'ro.build.fingerprint'], signal ? { signal } : {})
    ).trim();
    return (
      identity.versionCode === recipe.versionCode &&
      identity.signerSha256 === recipe.signerSha256 &&
      fingerprint === recipe.buildFingerprint
    );
  }
  async run(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    options: RecipeOptions,
  ): Promise<RecipeResult> {
    recipe = validateRecipe(recipe);
    const recipeDigest = digest(recipe);
    const pending = (instructions: string): RecipeResult => ({
      status: 'manual-pending',
      capability: 'app-setup',
      recipeDigest,
      instructions,
    });
    if (!(await this.verifyIdentity(target, user, recipe, options.signal)))
      return pending(
        'The app version, signer or Android build differs from the pinned recipe; complete setup privately or review an updated recipe.',
      );
    const child = `${options.operationId}/recipe/${randomUUID()}`;
    const obligations: RecoveryObligation[] = [];
    const staged = new Map<string, string>();
    try {
      await this.android.launch(target, user, recipe.packageId, options);
      for (const step of recipe.steps) {
        await this.focus(target, user, recipe.packageId, options.signal);
        if (step.action === 'stage-file') {
          const input = options.inputs?.[step.file];
          if (!input) throw new AdapterError('The recipe input reference has no enrolled private file');
          const stat = await lstat(input.path);
          const suffix = extname(input.path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o077 ||
            stat.size < 1 ||
            stat.size > 128 * 1024 ||
            !/^\.[A-Za-z0-9]{1,10}$/.test(suffix)
          )
            throw new AdapterError(
              'Recipe input must be a bounded private regular file with a safe extension',
            );
          const directory = await mkdtemp(join(tmpdir(), 'pxv-recipe-input-'));
          try {
            const path = join(directory, `input${suffix}`);
            await copySnapshot(input.path, path, 128 * 1024, options.signal);
            if ((await fileDigest(path, 128 * 1024, options.signal)) !== input.sha256)
              throw new AdapterError('Private recipe input changed after preparation');
            const remote = `/storage/emulated/${user.userId}/Download/pxv-import-${randomUUID()}${suffix}`;
            const obligation: RecoveryObligation = {
              schemaVersion: 1,
              id: randomUUID(),
              operationId: options.operationId,
              ownerOperationId: child,
              deviceSerial: target.device.canonicalSerial,
              user,
              kind: 'remove-file',
              resource: remote,
              payload: { path: remote },
              status: 'pending',
            };
            await options.obligations.record(obligation);
            obligations.push(obligation);
            await this.android.guardUser(target, user, options.signal);
            const pushed = await this.android.runAdb(['-s', target.transport.serial, 'push', path, remote], {
              ...options,
              mutation: true,
            });
            if (pushed.code !== 0)
              throw new AdapterError('Private recipe input transfer failed; preserve cleanup evidence');
            staged.set(step.file, remote);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
          continue;
        }
        if (step.action === 'select-staged-file') {
          const remote = staged.get(step.file);
          if (!remote) throw new AdapterError('The selected file reference has not been staged');
          if (!this.android.ui)
            return pending(
              'Select the staged input privately through the Android file picker; no accepted system UI adapter is available.',
            );
          const selected = await this.android.ui.execute(
            this.android,
            target,
            user,
            { capability: 'file-selection', remotePath: remote },
            options,
          );
          if (selected.status !== 'measured') return pending(selected.instructions);
          continue;
        }
        if (step.action === 'back') {
          await this.snapshot(target, user, recipe.packageId, options.signal);
          await this.focus(target, user, recipe.packageId, options.signal);
          await this.android.shell(target, ['input', 'keyevent', 'KEYCODE_BACK'], {
            ...options,
            mutation: true,
          });
          continue;
        }
        if (!('selector' in step)) throw new AdapterError('Unsupported recipe action');
        await this.performStep(target, user, recipe, step, options);
      }
      const nodes = await this.snapshot(target, user, recipe.packageId, options.signal);
      if (!recipe.postconditions.every((selector) => matchUiNode(nodes, selector, recipe.packageId)))
        throw new AdapterError(
          'App setup postconditions did not match; inspect this profile before continuing',
        );
      return {
        status: 'measured',
        capability: 'app-setup',
        recipeDigest,
        postconditions: recipe.postconditions.length,
        verification: 'visible-ui-only',
      };
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'MANUAL_PENDING') return pending(error.message);
      throw error;
    } finally {
      for (const obligation of obligations.reverse()) {
        await this.android.cleanup(target, obligation, { lease: options.lease, operationId: child });
        await options.obligations.resolve(obligation.id);
      }
    }
  }
  private async performStep(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    step: Exclude<RecipeStep, { action: 'back' | 'stage-file' | 'select-staged-file' }>,
    options: RecipeOptions,
  ): Promise<void> {
    const selector: UiSelector = { ...step.selector };
    if (step.action === 'toggle') delete selector.checked;
    const deadline = Date.now() + (step.timeoutMs ?? 30000);
    let node: UiNode | undefined;
    do {
      node = matchUiNode(
        await this.snapshot(target, user, recipe.packageId, options.signal),
        selector,
        recipe.packageId,
      );
      if (node) break;
      if (step.action !== 'wait' || Date.now() >= deadline)
        throw new AdapterError(
          'Expected UI element was not found; review the pinned recipe or complete setup privately',
          'MANUAL_PENDING',
        );
      await delay(
        Math.min(250, Math.max(1, deadline - Date.now())),
        undefined,
        options.signal ? { signal: options.signal } : {},
      );
    } while (!node);
    if (
      step.action === 'tap' ||
      (step.action === 'toggle' && node.attributes['checked'] !== String(step.value))
    )
      await this.tap(target, user, recipe.packageId, node, options);
    if (
      step.action === 'toggle' &&
      !matchUiNode(
        await this.snapshot(target, user, recipe.packageId, options.signal),
        { ...selector, checked: step.value },
        recipe.packageId,
      )
    )
      throw new AdapterError('The UI toggle did not retain the reviewed value');
    if (step.action === 'text' && node.attributes['text'] !== step.value) {
      const current = node.attributes['text'] ?? '';
      if (
        !step.selector.resourceId ||
        !/^[A-Za-z0-9._:/@+-]{1,200}$/.test(step.value) ||
        node.attributes['password'] === 'true' ||
        !node.attributes['class']?.includes('EditText') ||
        current.length > 200
      )
        throw new AdapterError(
          'Recipe text entry accepts bounded public configuration in a visible non-password field',
        );
      await this.tap(target, user, recipe.packageId, node, options);
      for (const key of ['KEYCODE_MOVE_END', ...Array<string>(current.length).fill('KEYCODE_DEL')]) {
        await this.focus(target, user, recipe.packageId, options.signal);
        await this.android.shell(target, ['input', 'keyevent', key], { ...options, mutation: true });
      }
      await this.focus(target, user, recipe.packageId, options.signal);
      await this.android.shell(target, ['input', 'text', step.value], { ...options, mutation: true });
      if (
        !matchUiNode(
          await this.snapshot(target, user, recipe.packageId, options.signal),
          { resourceId: step.selector.resourceId, text: step.value },
          recipe.packageId,
        )
      )
        throw new AdapterError('The public configuration field did not report the requested value');
    }
  }
}
