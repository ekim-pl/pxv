import type {
  AndroidUserIdentity,
  ObligationWriter,
  ExecutionPolicy,
  SeedvaultEvidence,
  SeedvaultInspection,
  SeedvaultProfileIdentity,
  SeedvaultProfileResult,
  SeedvaultProgress,
  SeedvaultRequest,
  SelectedTarget,
  ReviewedPlan,
} from '@pxv/contracts';
import type { ExecutionContext, ReviewLineage, RunRecord } from '../../workflow-types.js';

interface SeedvaultExecutionContext extends ExecutionContext {
  obligations: ObligationWriter;
  progress?: SeedvaultProgress;
  saveProgress(progress: SeedvaultProgress): Promise<void>;
}

/** Only typed, inspected Seedvault capabilities cross the device boundary. */
export interface SeedvaultWorkflowPort {
  inspect(
    target: SelectedTarget,
    policy: ExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<SeedvaultInspection>;
  executeProfile(
    target: SelectedTarget,
    profile: SeedvaultProfileIdentity,
    request: SeedvaultRequest,
    context: SeedvaultExecutionContext,
  ): Promise<SeedvaultProfileResult>;
}

interface SeedvaultProfileReport {
  profileId: string;
  user: AndroidUserIdentity;
  status: 'queued' | 'running' | 'pending' | 'completed';
  progress?: SeedvaultProgress;
  evidence?: SeedvaultEvidence;
  instructions?: string;
}

export interface SeedvaultReport {
  schemaVersion: 1;
  runId: string;
  planId: string;
  operation: SeedvaultRequest['operation'];
  deviceSerial: string;
  status: RunRecord['status'];
  cursor: number;
  profiles: SeedvaultProfileReport[];
}

export interface PreparedSeedvaultOperation {
  schemaVersion: 1;
  kind: 'seedvault';
  lifecycleGeneration?: string;
  plan: ReviewedPlan;
  target: SelectedTarget;
  request: SeedvaultRequest;
  baseline: SeedvaultInspection;
  expiresAt: string;
  reviewSummary: string;
  refreshedFrom?: ReviewLineage & { progress: SeedvaultReport };
}
