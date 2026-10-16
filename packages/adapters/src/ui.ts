import type { AndroidUserIdentity, SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import { fileDigest } from './files.js';

type AutomatedCapability =
  'language' | 'app-setup' | 'network-recipe' | 'backup-observation' | 'file-selection';
export interface CapabilityRequest {
  capability: AutomatedCapability;
  language?: string;
  remotePath?: string;
}
export type CapabilityResult =
  | {
      status: 'measured';
      capability: AutomatedCapability;
      adapterId: string;
      evidence: Record<string, unknown>;
    }
  | { status: 'manual-pending'; capability: AutomatedCapability; instructions: string };
interface UiContext {
  android: AndroidAdapter;
  target: SelectedTarget;
  user: AndroidUserIdentity;
  request: CapabilityRequest;
  options: OperationOptions;
}
/** Accepted automation is bound to recorded tests for one exact Android build. */
export interface AcceptedUiAdapter {
  id: string;
  version: string;
  buildFingerprint: string;
  languages: string[];
  capabilities: AutomatedCapability[];
  acceptance: { path: string; sha256: string };
  execute(context: UiContext): Promise<Record<string, unknown>>;
}
export class UiAutomation {
  constructor(readonly adapters: readonly AcceptedUiAdapter[] = []) {
    if (new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length)
      throw new AdapterError('Duplicate accepted UI adapter ID');
  }
  async execute(
    android: AndroidAdapter,
    target: SelectedTarget,
    user: AndroidUserIdentity,
    request: CapabilityRequest,
    options: OperationOptions,
  ): Promise<CapabilityResult> {
    const adapter = await this.accepted(android, target, user, request, options);
    if (!adapter)
      return {
        status: 'manual-pending',
        capability: request.capability,
        instructions: `Complete ${request.capability} privately in Android user ${user.userId}; no accepted UI adapter matches this build and language.`,
      };
    const evidence = await adapter.execute({ android, target, user, request, options });
    await android.guardUser(target, user, options.signal);
    return { status: 'measured', capability: request.capability, adapterId: adapter.id, evidence };
  }
  async supports(
    android: AndroidAdapter,
    target: SelectedTarget,
    user: AndroidUserIdentity,
    request: CapabilityRequest,
    options: OperationOptions,
  ): Promise<boolean> {
    return (await this.accepted(android, target, user, request, options)) !== undefined;
  }
  private async accepted(
    android: AndroidAdapter,
    target: SelectedTarget,
    user: AndroidUserIdentity,
    request: CapabilityRequest,
    options: OperationOptions,
  ): Promise<AcceptedUiAdapter | undefined> {
    await android.guardUser(target, user, options.signal);
    const fingerprint = (
      await android.shell(
        target,
        ['getprop', 'ro.build.fingerprint'],
        options.signal ? { signal: options.signal } : {},
      )
    ).trim();
    const candidates = this.adapters.filter(
      (adapter) =>
        adapter.buildFingerprint === fingerprint &&
        adapter.capabilities.includes(request.capability) &&
        (!request.language || adapter.languages.includes(request.language)),
    );
    if (candidates.length > 1)
      throw new AdapterError('Multiple accepted UI adapters match the capability and Android build');
    const adapter = candidates[0];
    if (!adapter) return undefined;
    if (
      (await fileDigest(adapter.acceptance.path, 16 * 1024 * 1024, options.signal)) !==
      adapter.acceptance.sha256.toLowerCase()
    )
      throw new AdapterError('UI acceptance evidence changed');
    return adapter;
  }
}
