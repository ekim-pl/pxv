import type { Action, SeedvaultRequest, SelectedTarget } from '@pxv/contracts';
import { createWorkflowServices } from './composition.js';
import { assertProjectFresh } from './project.js';
import type { EngineOptions, EmulatorImagePin, Operation } from './workflow-types.js';
/** @public Retained application façade types for existing WorkflowEngine port consumers. */
export type {
  EmulatorImagePin,
  EmulatorProvenance,
  ExecutionContext,
  RecipeExecutionResult,
  ProbeObservation,
  ProbeExecutionResult,
  WorkflowPort,
  OsSnapshot,
  ArtifactPort,
  Operation,
  PreparedOperation,
  WorkflowState,
  RunRecord,
} from './workflow-types.js';

/** Public application façade; service composition owns no borrowed store lifetime. */
export class WorkflowEngine {
  readonly project: EngineOptions['project'];
  readonly store: EngineOptions['store'];
  readonly port: EngineOptions['port'];
  readonly artifacts: EngineOptions['artifacts'];
  readonly controlRoot: string;
  readonly clock: () => Date;
  private readonly services: ReturnType<typeof createWorkflowServices>;
  constructor(options: EngineOptions) {
    this.project = options.project;
    this.store = options.store;
    this.port = options.port;
    this.artifacts = options.artifacts;
    this.controlRoot = options.controlRoot;
    this.services = createWorkflowServices(options);
    this.clock = this.services.clock;
  }
  observe(target: SelectedTarget, signal?: AbortSignal) {
    return this.services.observations.observe(target, signal);
  }
  prepare(target: SelectedTarget, operation: Operation = 'provision', signal?: AbortSignal) {
    return this.services.preparation.prepare(target, operation, signal);
  }
  prepareExtension(target: SelectedTarget, actions: Action[], signal?: AbortSignal) {
    return this.services.preparation.prepareExtension(target, actions, signal);
  }
  async submit(planId: string, reviewSummary: string, operator: string) {
    if (await this.services.seedvault.plans.has(planId))
      return this.services.seedvault.submit(planId, reviewSummary, operator);
    return this.services.review.submit(planId, reviewSummary, operator);
  }
  inspectSeedvault(target: SelectedTarget, signal?: AbortSignal) {
    return this.services.seedvault.inspect(target, signal);
  }
  prepareSeedvault(target: SelectedTarget, request: SeedvaultRequest, signal?: AbortSignal) {
    return this.services.seedvault.prepare(target, request, signal);
  }
  seedvaultReport(runId: string) {
    return this.services.seedvault.report(runId);
  }
  plan(id: string, summary?: string) {
    return this.services.plans.read(id, summary);
  }
  async refreshReview(runId: string, signal?: AbortSignal) {
    if (await this.services.seedvault.ownsRun(runId)) return this.services.seedvault.refresh(runId, signal);
    return this.services.review.refreshReview(runId, signal);
  }
  async execute(runId: string, signal?: AbortSignal) {
    if (await this.services.seedvault.ownsRun(runId)) return this.services.seedvault.execute(runId, signal);
    return this.services.execution.execute(runId, signal);
  }
  executeFleet(runIds: string[], jobs = 2, signal?: AbortSignal) {
    return this.services.execution.executeFleet(runIds, jobs, signal);
  }
  cancel(runId: string) {
    return this.services.execution.cancel(runId);
  }
  recover(target: SelectedTarget, previousOperationId: string, signal?: AbortSignal) {
    return this.services.recovery.recover(target, previousOperationId, signal);
  }
  state(assetId: string) {
    return this.services.evidence.state(assetId);
  }
  receipts(assetId: string) {
    return this.services.evidence.receipts(assetId);
  }
  async readiness(target: SelectedTarget) {
    await assertProjectFresh(this.project);
    return this.services.evidence.readiness(target);
  }
  attest(
    target: SelectedTarget,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ) {
    return this.services.attestation.attest(target, check, operator, note, evidence);
  }
  finalize(target: SelectedTarget, operator: string, locale: 'en' | 'pl' = 'en') {
    return this.services.handoff.finalize(target, operator, locale);
  }
  acceptedHandoff(assetId: string) {
    return this.services.handoff.acceptedHandoff(assetId);
  }
  acceptCustody(assetId: string, recipient: string, togglesOff: boolean) {
    return this.services.handoff.acceptCustody(assetId, recipient, togglesOff);
  }
  event(runId: string, type: string, data: Record<string, unknown>) {
    return this.services.journal.event(runId, type, data);
  }
}
