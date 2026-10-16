import type { AndroidUserIdentity, SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError, type OperationOptions } from './command.js';
import { fileDigest } from './files.js';

export type AutomatedCapability =
  'language' | 'app-setup' | 'network-recipe' | 'backup-observation' | 'file-selection';
export interface CapabilityRequest {
  capability: AutomatedCapability;
  language?: 'en-US' | 'pl-PL';
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
export interface UiContext {
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
  languages: ('en-US' | 'pl-PL')[];
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
    if (!adapter)
      return {
        status: 'manual-pending',
        capability: request.capability,
        instructions: `Complete ${request.capability} privately in Android user ${user.userId}; no accepted UI adapter matches this build and language.`,
      };
    if (
      (await fileDigest(adapter.acceptance.path, 16 * 1024 * 1024, options.signal)) !==
      adapter.acceptance.sha256.toLowerCase()
    )
      throw new AdapterError('UI acceptance evidence changed');
    const evidence = await adapter.execute({ android, target, user, request, options });
    await android.guardUser(target, user, options.signal);
    return { status: 'measured', capability: request.capability, adapterId: adapter.id, evidence };
  }
}
export interface FinalSetupStep {
  capability: 'normal-credential' | 'language' | 'duress';
  privateEntry: true;
  instructions: string;
}
export function finalSetupSequence(language?: 'en-US' | 'pl-PL', duress = false): FinalSetupStep[] {
  const steps: FinalSetupStep[] = [
    {
      capability: 'normal-credential',
      privateEntry: true,
      instructions: 'The recipient enters and verifies the normal credential privately.',
    },
  ];
  if (language)
    steps.push({
      capability: 'language',
      privateEntry: true,
      instructions: `Set ${language} after confirming the normal credential.`,
    });
  if (duress)
    steps.push({
      capability: 'duress',
      privateEntry: true,
      instructions:
        'The recipient optionally configures a distinct duress credential privately. Do not activate or test it.',
    });
  return steps;
}
