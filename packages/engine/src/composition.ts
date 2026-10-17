import type { EngineOptions } from './workflow-types.js';
import { ObservationService } from './observation-service.js';
import { PlanRepository } from './plan-repository.js';
import { NativeDeviceOwnership, NativeProjectOwnership } from './ownership.js';
import { RunJournal } from './journal.js';
import { EvidenceService } from './evidence-service.js';
import { PreparationService } from './preparation-service.js';
import { ReviewService } from './review-service.js';
import { ExecutionService } from './execution-service.js';
import { RecoveryService } from './recovery-service.js';
import { AttestationService } from './attestation-service.js';
import { HandoffService } from './handoff-service.js';
import type { SeedvaultService } from './experimental/seedvault/seedvault-service.js';
import { CredentialDefaultHistory } from './credential-default-history.js';
import { RunQueryService } from './run-query-service.js';
type Dependencies = EngineOptions & { clock: () => Date };
interface Collaborators {
  observations: ObservationService;
  plans: PlanRepository;
  evidence: EvidenceService;
  devices: NativeDeviceOwnership;
  projects: NativeProjectOwnership;
  journal: RunJournal;
}
function operationServices(deps: Dependencies, services: Collaborators) {
  const { project, store, port, artifacts, clock } = deps;
  const { observations, plans, evidence, devices, projects, journal } = services;
  const credentialDefaults = new CredentialDefaultHistory(store);
  const preparation = new PreparationService(
    project,
    port,
    artifacts,
    observations,
    plans,
    clock,
    credentialDefaults,
  );
  const review = new ReviewService(
    project,
    store,
    observations,
    plans,
    preparation,
    evidence,
    projects,
    devices,
    journal,
    clock,
  );
  const execution = new ExecutionService(
    project,
    store,
    port,
    artifacts,
    observations,
    evidence,
    plans,
    projects,
    devices,
    journal,
    clock,
    credentialDefaults,
  );
  const recovery = new RecoveryService(store, port, observations, devices, journal);
  return { preparation, review, execution, recovery };
}
/** Compose owned services once; no service depends on the public façade. */
export function createWorkflowServices(options: EngineOptions) {
  const deps = { ...options, clock: options.clock ?? (() => new Date()) };
  const { project, store, port, controlRoot, clock } = deps;
  const observations = new ObservationService(project, port);
  const devices = new NativeDeviceOwnership(controlRoot);
  const projects = new NativeProjectOwnership(project, controlRoot);
  const plans = new PlanRepository(project, store, observations, clock);
  const evidence = new EvidenceService(project, store, observations, devices, clock);
  const journal = new RunJournal(store, controlRoot, clock);
  const collaborators = { observations, plans, evidence, devices, projects, journal };
  let seedvault: Promise<SeedvaultService> | undefined;
  return {
    ...collaborators,
    seedvault: () =>
      (seedvault ??= import('./experimental/seedvault/index.js').then((module) =>
        module.createSeedvaultServices(deps, collaborators),
      )),
    ...operationServices(deps, collaborators),
    runs: new RunQueryService(project, store, clock, observations),
    clock,
    attestation: new AttestationService(
      project,
      store,
      port,
      observations,
      evidence,
      plans,
      devices,
      projects,
      clock,
    ),
    handoff: new HandoffService(project, store, port, observations, evidence, devices, projects, clock),
  };
}
