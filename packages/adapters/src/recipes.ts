import type { ObligationWriter } from '@pxv/contracts';
import { parseUiSnapshot, matchUiNode, type UiNode } from './ui-snapshot.js';
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

interface RecipeInput {
  path: string;
  sha256: string;
}
export interface RecipeOptions extends OperationOptions {
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

const PRIVATE_IMPORT_INSTRUCTIONS =
  'No temporary import file is retained. Complete the full configuration import privately in the app using your approved private transfer method, or review an accepted file-selection adapter and rerun the recipe.';
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
    const [x, y] = tapPoint(node);
    await this.focus(target, user, packageId, options.signal);
    await this.android.shell(target, ['input', 'tap', String(x), String(y)], { ...options, mutation: true });
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
    const run = new RecipeRun(this, target, user, recipe, options);
    if (!(await this.verifyIdentity(target, user, recipe, options.signal)))
      return run.pending(
        'The app version, signer or Android build differs from the pinned recipe; complete setup privately or review an updated recipe.',
      );
    if (!(await this.supportsPrivateImport(target, user, recipe, options)))
      return run.pending(PRIVATE_IMPORT_INSTRUCTIONS);
    try {
      return await run.execute();
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'MANUAL_PENDING') return run.pending(error.message);
      throw error;
    } finally {
      await run.cleanup();
    }
  }
  private async supportsPrivateImport(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    options: RecipeOptions,
  ): Promise<boolean> {
    if (!recipe.steps.some((step) => step.action === 'select-staged-file')) return true;
    if (!this.android.ui) return false;
    return this.android.ui.supports(this.android, target, user, { capability: 'file-selection' }, options);
  }
  async performStep(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    recipe: RecipePolicy,
    step: SelectorStep,
    options: RecipeOptions,
  ): Promise<void> {
    const selector: UiSelector = { ...step.selector };
    if (step.action === 'toggle') delete selector.checked;
    const node = await this.waitForNode(target, user, recipe.packageId, selector, step, options);
    if (
      step.action === 'tap' ||
      (step.action === 'toggle' && node.attributes['checked'] !== String(step.value))
    )
      await this.tap(target, user, recipe.packageId, node, options);
    if (step.action === 'toggle') {
      const nodes = await this.snapshot(target, user, recipe.packageId, options.signal);
      if (!matchUiNode(nodes, { ...selector, checked: step.value }, recipe.packageId))
        throw new AdapterError('The UI toggle did not retain the reviewed value');
    }
    if (step.action === 'text' && node.attributes['text'] !== step.value)
      await this.enterText(target, user, recipe.packageId, node, step, options);
  }

  private async waitForNode(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    packageId: string,
    selector: UiSelector,
    step: SelectorStep,
    options: RecipeOptions,
  ): Promise<UiNode> {
    const deadline = Date.now() + (step.timeoutMs ?? 30000);
    while (true) {
      const node = matchUiNode(
        await this.snapshot(target, user, packageId, options.signal),
        selector,
        packageId,
      );
      if (node) return node;
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
    }
  }
  private async enterText(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    packageId: string,
    node: UiNode,
    step: Extract<RecipeStep, { action: 'text' }>,
    options: RecipeOptions,
  ): Promise<void> {
    const current = node.attributes['text'] ?? '';
    validateTextField(node, step, current);
    await this.tap(target, user, packageId, node, options);
    for (const key of ['KEYCODE_MOVE_END', ...Array<string>(current.length).fill('KEYCODE_DEL')]) {
      await this.focus(target, user, packageId, options.signal);
      await this.android.shell(target, ['input', 'keyevent', key], { ...options, mutation: true });
    }
    await this.focus(target, user, packageId, options.signal);
    await this.android.shell(target, ['input', 'text', step.value], { ...options, mutation: true });
    const nodes = await this.snapshot(target, user, packageId, options.signal);
    if (!matchUiNode(nodes, { resourceId: step.selector.resourceId, text: step.value }, packageId))
      throw new AdapterError('The public configuration field did not report the requested value');
  }
}

type SelectorStep = Exclude<RecipeStep, { action: 'back' | 'stage-file' | 'select-staged-file' }>;

function tapPoint(node: UiNode): [number, number] {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.attributes['bounds'] ?? '');
  if (!match) throw new AdapterError('UI node has no usable bounds');
  const left = Number(match[1]),
    top = Number(match[2]),
    right = Number(match[3]),
    bottom = Number(match[4]);
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    left < 0 ||
    top < 0 ||
    right <= left ||
    bottom <= top ||
    right > 10000 ||
    bottom > 10000
  )
    throw new AdapterError('UI node bounds are outside the accepted range');
  return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
}
function validateTextField(
  node: UiNode,
  step: Extract<RecipeStep, { action: 'text' }>,
  current: string,
): asserts step is Extract<RecipeStep, { action: 'text' }> & { selector: { resourceId: string } } {
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
}
class RecipeRun {
  private readonly writer: ObligationWriter;
  private readonly obligations: RecoveryObligation[] = [];
  private readonly staged = new Map<string, string>();
  private readonly recipeDigest: string;
  constructor(
    private readonly service: RecipeService,
    private readonly target: SelectedTarget,
    private readonly user: AndroidUserIdentity,
    private readonly recipe: RecipePolicy,
    private readonly options: RecipeOptions,
  ) {
    this.writer = options.obligations.child('recipe-' + randomUUID());
    this.recipeDigest = digest(recipe);
  }
  pending(instructions: string): RecipeResult {
    return {
      status: 'manual-pending',
      capability: 'app-setup',
      recipeDigest: this.recipeDigest,
      instructions,
    };
  }
  async execute(): Promise<RecipeResult> {
    await this.service.android.launch(this.target, this.user, this.recipe.packageId, this.options);
    for (const step of this.recipe.steps) {
      await this.service.focus(this.target, this.user, this.recipe.packageId, this.options.signal);
      const result = await this.step(step);
      if (result) return result;
    }
    const nodes = await this.service.snapshot(
      this.target,
      this.user,
      this.recipe.packageId,
      this.options.signal,
    );
    if (!this.recipe.postconditions.every((selector) => matchUiNode(nodes, selector, this.recipe.packageId)))
      throw new AdapterError(
        'App setup postconditions did not match; inspect this profile before continuing',
      );
    return {
      status: 'measured',
      capability: 'app-setup',
      recipeDigest: this.recipeDigest,
      postconditions: this.recipe.postconditions.length,
      verification: 'visible-ui-only',
    };
  }
  private async step(step: RecipeStep): Promise<RecipeResult | undefined> {
    switch (step.action) {
      case 'stage-file':
        await this.stageFile(step.file);
        return;
      case 'select-staged-file':
        return this.selectFile(step.file);
      case 'back':
        await this.back();
        return;
      case 'tap':
      case 'text':
      case 'toggle':
      case 'wait':
        await this.service.performStep(this.target, this.user, this.recipe, step, this.options);
        return undefined;
    }
  }
  private async back(): Promise<void> {
    await this.service.snapshot(this.target, this.user, this.recipe.packageId, this.options.signal);
    await this.service.focus(this.target, this.user, this.recipe.packageId, this.options.signal);
    await this.service.android.shell(this.target, ['input', 'keyevent', 'KEYCODE_BACK'], {
      ...this.options,
      mutation: true,
    });
  }
  private async selectFile(ref: string): Promise<RecipeResult | undefined> {
    const remote = this.staged.get(ref);
    if (!remote) throw new AdapterError('The selected file reference has not been staged');
    if (!this.service.android.ui) return this.pending(PRIVATE_IMPORT_INSTRUCTIONS);
    const selected = await this.service.android.ui.execute(
      this.service.android,
      this.target,
      this.user,
      { capability: 'file-selection', remotePath: remote },
      this.options,
    );
    if (selected.status !== 'measured') return this.pending(PRIVATE_IMPORT_INSTRUCTIONS);
    return undefined;
  }
  private async stageFile(ref: string): Promise<void> {
    const input = this.options.inputs?.[ref];
    if (!input) throw new AdapterError('The recipe input reference has no enrolled private file');
    const suffix = await inputSuffix(input);
    const directory = await mkdtemp(join(tmpdir(), 'pxv-recipe-input-'));
    try {
      const path = join(directory, 'input' + suffix);
      await copySnapshot(input.path, path, 128 * 1024, this.options.signal);
      if ((await fileDigest(path, 128 * 1024, this.options.signal)) !== input.sha256)
        throw new AdapterError('Private recipe input changed after preparation');
      const remote =
        '/storage/emulated/' + this.user.userId + '/Download/pxv-import-' + randomUUID() + suffix;
      await this.recordFile(remote);
      await this.service.android.guardUser(this.target, this.user, this.options.signal);
      const pushed = await this.service.android.runAdb(
        ['-s', this.target.transport.serial, 'push', path, remote],
        { ...this.options, mutation: true },
      );
      if (pushed.code !== 0)
        throw new AdapterError('Private recipe input transfer failed; preserve cleanup evidence');
      this.staged.set(ref, remote);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async recordFile(remote: string): Promise<void> {
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: randomUUID(),
      operationId: this.writer.operationId,
      ownerOperationId: this.writer.ownerOperationId,
      deviceSerial: this.target.device.canonicalSerial,
      user: this.user,
      kind: 'remove-file',
      resource: remote,
      payload: { path: remote },
      status: 'pending',
    };
    await this.writer.record(obligation);
    this.obligations.push(obligation);
  }
  async cleanup(): Promise<void> {
    for (const obligation of this.obligations.reverse()) {
      await this.service.android.cleanup(this.target, obligation, {
        lease: this.options.lease,
        operationId: this.writer.ownerOperationId,
      });
      await this.writer.resolve(obligation.id);
    }
  }
}
async function inputSuffix(input: RecipeInput): Promise<string> {
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
    throw new AdapterError('Recipe input must be a bounded private regular file with a safe extension');
  return suffix;
}
