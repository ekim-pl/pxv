import { randomUUID } from 'node:crypto';
import {
  digest,
  observationDigest,
  validateAcceptedHandoffSnapshot,
  validateHandoff,
  validateObservation,
  validatePlan,
  verifyResolvedPolicy,
  type HandoffRecord,
  type AcceptedHandoffSnapshot,
  type ReviewedPlan,
  type RunEvent,
  type SelectedTarget,
  type ResolvedPolicy,
} from '@pxv/contracts';
import type { Store, ExpectedRecord } from '@pxv/runtime';
import type { Operation, RunRecord, WorkflowState } from './workflow-types.js';
import { validatePreparedEvidence } from './prepared-evidence.js';
import { EvidenceValidationError } from './evidence-validation.js';

interface CustodyPlan {
  plan: ReviewedPlan;
  target: SelectedTarget;
  operation?: Operation;
}
interface Binding {
  state: WorkflowState;
  record: HandoffRecord;
  resolved: ResolvedPolicy;
}

function inspectBinding(state: WorkflowState, receipt: unknown, snapshot: unknown): Binding {
  const record = validateHandoff(receipt);
  const observation = validateObservation(state.observation);
  if (
    state.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(state.planDigest) ||
    state.assetId !== observation.device.assetId ||
    state.policyDigest !== record.policyDigest ||
    record.deviceSerial !== observation.device.canonicalSerial ||
    record.observationDigest !== observationDigest(observation)
  )
    throw new Error('Custody workflow identity differs from its handoff');
  const resolved = assertSnapshot(state.assetId, record, snapshot);
  return { state, record, resolved };
}

function assertSnapshot(assetId: string, record: HandoffRecord, snapshot: unknown): ResolvedPolicy {
  const accepted = validateAcceptedHandoffSnapshot(snapshot);
  const resolved = verifyResolvedPolicy(accepted.resolvedPolicy);
  if (
    accepted.assetId !== assetId ||
    accepted.recordId !== record.id ||
    resolved.digest !== record.policyDigest ||
    resolved.project.id !== record.projectId
  )
    throw new Error('Custody snapshot identity differs from its handoff');
  return resolved;
}

function acceptanceRun(run: RunRecord, prepared: CustodyPlan): boolean {
  return (
    ['provision', 'create-users', 'deploy-apps', 'extension'].includes(prepared.operation ?? '') &&
    ['pending', 'completed'].includes(run.status) &&
    !run.manualGate &&
    (!run.pauseReason || run.pauseReason.kind === 'acceptance') &&
    run.cursor === prepared.plan.actions.length
  );
}

function matches(run: RunRecord, prepared: CustodyPlan, binding: Binding): boolean {
  validatePreparedEvidence(prepared, binding.resolved.project.extensions);
  const { state, record } = binding;
  const plan = prepared.plan;
  return (
    acceptanceRun(run, prepared) &&
    run.id === digest({ project: record.projectId, plan: state.planDigest }) &&
    run.planId === plan.id &&
    (state.planId === undefined || state.planId === plan.id) &&
    state.planDigest === plan.digest &&
    record.projectId === plan.projectId &&
    record.policyDigest === plan.policyDigest &&
    digest(plan.device) === digest(state.observation.device) &&
    digest(prepared.target.device) === digest(plan.device)
  );
}

function retainedMatch(run: RunRecord, prepared: CustodyPlan, binding: Binding): boolean {
  try {
    return matches(run, prepared, binding);
  } catch (error) {
    if (error instanceof EvidenceValidationError) return false;
    throw error;
  }
}

function completed(run: RunRecord): RunRecord {
  const { pauseReason: _pauseReason, ...record } = run;
  void _pauseReason;
  return { ...record, status: 'completed' };
}

export function custodyCompletionEvent(runId: string, record: HandoffRecord): Omit<RunEvent, 'sequence'> {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    runId,
    at: record.acceptedAt ?? record.createdAt,
    type: 'custody-completed',
    data: { status: 'completed', recordId: record.id },
  };
}

/** Custody and its exact workflow run commit together; missing or inconsistent lineage fails closed. */
export async function custodyRun(
  store: Store,
  state: WorkflowState,
  record: HandoffRecord,
  snapshot?: AcceptedHandoffSnapshot,
): Promise<{ previous: RunRecord; next: RunRecord; expected: ExpectedRecord[] }> {
  const id = digest({ project: record.projectId, plan: state.planDigest });
  const run = await store.get<RunRecord>('runs', id);
  if (!run) throw new Error('Matching workflow run is required before recording custody');
  const prepared = await store.get<CustodyPlan>('plans', run.planId);
  const retained = snapshot ?? (await store.get('handoff-snapshots', record.id));
  const binding = inspectBinding(state, record, retained);
  if (!prepared || !retainedMatch(run, prepared, binding))
    throw new Error('Workflow run differs from the accepted handoff; inspect before custody');
  return {
    previous: run,
    next: completed(run),
    expected: [
      { collection: 'runs', key: run.id, value: run },
      { collection: 'plans', key: run.planId, value: prepared },
      ...(!snapshot ? [{ collection: 'handoff-snapshots', key: record.id, value: retained }] : []),
    ],
  };
}

interface Candidate {
  workflow?: WorkflowState | undefined;
  handoff?: unknown;
}

/** Query-scoped compatibility projection. It never repairs or rewrites retained records. */
export class CustodyCompletionSession {
  private readonly current = new Map<string, Promise<Binding[]>>();
  private readonly historical = new Map<string, Promise<Binding[]>>();
  private readonly snapshots = new Map<string, Promise<unknown>>();
  private archives: Promise<Map<string, Candidate[]>> | undefined;
  constructor(
    private readonly store: Store,
    private readonly projectId: string,
  ) {}

  async complete(run: RunRecord, prepared: CustodyPlan | undefined): Promise<RunRecord> {
    const assetId = this.pendingAsset(run, prepared);
    if (!prepared || !assetId) return run;
    let current = this.current.get(assetId);
    if (!current) {
      current = this.currentBindings(assetId);
      this.current.set(assetId, current);
    }
    if (this.matched(run, prepared, await current)) return completed(run);
    let historical = this.historical.get(assetId);
    if (!historical) {
      historical = this.historicalBindings(assetId);
      this.historical.set(assetId, historical);
    }
    return this.matched(run, prepared, await historical) ? completed(run) : run;
  }
  private pendingAsset(run: RunRecord, prepared: CustodyPlan | undefined): string | undefined {
    try {
      if (!prepared || run.status !== 'pending' || !acceptanceRun(run, prepared)) return undefined;
      validatePlan(prepared.plan);
      if (prepared.plan.projectId !== this.projectId) return undefined;
      return prepared.target.device.assetId;
    } catch {
      return undefined;
    }
  }
  private matched(run: RunRecord, prepared: CustodyPlan, bindings: Binding[]): boolean {
    return bindings.some((binding) => retainedMatch(run, prepared, binding));
  }
  private async currentBindings(assetId: string): Promise<Binding[]> {
    return this.bindings([
      {
        workflow: await this.store.get<WorkflowState>('workflow', assetId),
        handoff: await this.store.get('handoff', assetId),
      },
    ]);
  }
  private async historicalBindings(assetId: string): Promise<Binding[]> {
    this.archives ??= this.readArchives();
    return this.bindings((await this.archives).get(assetId) ?? []);
  }
  private async readArchives(): Promise<Map<string, Candidate[]>> {
    const assets = new Map<string, Candidate[]>();
    let cursor: string | undefined;
    do {
      const page = await this.store.entriesPage<Candidate>('lifecycle-evidence', {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 1000,
      });
      for (const { value } of page.items) {
        const assetId = value?.workflow?.assetId;
        if (typeof assetId !== 'string') continue;
        const entries = assets.get(assetId) ?? [];
        entries.push(value);
        assets.set(assetId, entries);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return assets;
  }

  private async bindings(candidates: Candidate[]): Promise<Binding[]> {
    const bindings: Binding[] = [];
    for (const candidate of candidates) {
      const binding = await this.binding(candidate);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }
  private async binding(candidate: Candidate): Promise<Binding | undefined> {
    let record: HandoffRecord;
    try {
      if (candidate.workflow?.status !== 'completed-custody') return undefined;
      record = validateHandoff(candidate.handoff);
      if (record.outcome !== 'completed-custody') return undefined;
    } catch {
      return undefined;
    }
    let snapshot = this.snapshots.get(record.id);
    if (!snapshot) {
      snapshot = this.store.get('handoff-snapshots', record.id);
      this.snapshots.set(record.id, snapshot);
    }
    const retained = await snapshot;
    try {
      return inspectBinding(candidate.workflow, record, retained);
    } catch {
      // Malformed retained data cannot establish completion; storage failures still propagate.
      return undefined;
    }
  }
}
