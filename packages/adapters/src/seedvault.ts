import {
  validateSeedvaultRequest,
  type ObligationWriter,
  type PolicyPack,
  type RecoveryObligation,
  type SeedvaultInspection,
  type SeedvaultProfileIdentity,
  type SeedvaultProfileProgress,
  type SeedvaultProfileResult,
  type SeedvaultRequest,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter, CleanupOptions } from './android.js';
import type { OperationOptions } from './command.js';
import { AdapterError } from './command.js';
import { inspectSeedvault } from './seedvault-inspection.js';
import { cleanupSeedvault, verifySeedvaultAcceptance } from './seedvault-recovery.js';
import { SeedvaultRun } from './seedvault-run.js';
import { seedvaultIdentity } from './seedvault-ui.js';

export interface SeedvaultExecutionOptions extends OperationOptions {
  obligations: ObligationWriter;
  progress?: SeedvaultProfileProgress;
  saveProgress(progress: SeedvaultProfileProgress): Promise<void>;
}
/** Uses the normal UI path; never exports keys, runs root, or treats bmgr as a full backup. */
export class SeedvaultAdapter {
  constructor(readonly android: AndroidAdapter) {}
  inspect(target: SelectedTarget, policy: PolicyPack, signal?: AbortSignal): Promise<SeedvaultInspection> {
    return inspectSeedvault(this.android, target, policy, signal);
  }
  async executeProfile(
    target: SelectedTarget,
    profile: SeedvaultProfileIdentity,
    request: SeedvaultRequest,
    options: SeedvaultExecutionOptions,
  ): Promise<SeedvaultProfileResult> {
    request = validateSeedvaultRequest(request);
    if (!request.adapter)
      return {
        status: 'manual-pending',
        instructions:
          'No accepted Seedvault UI adapter matches this operation. Configure storage and recovery material privately; retain the exact build, signer and tested UI acceptance evidence before supervised measurement.',
      };
    await verifySeedvaultAcceptance(request.adapter, options.signal);
    try {
      await seedvaultIdentity(this.android, target, profile.user, request.adapter, options.signal);
      return await new SeedvaultRun(
        this.android,
        target,
        profile,
        request,
        request.adapter,
        options,
      ).execute();
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'MANUAL_PENDING')
        return { status: 'manual-pending', instructions: error.message };
      throw error;
    }
  }
  cleanup(target: SelectedTarget, obligation: RecoveryObligation, options: CleanupOptions): Promise<void> {
    return cleanupSeedvault(this.android, target, obligation, options);
  }
}
