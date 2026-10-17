import type { EngineOptions } from '../../workflow-types.js';
import type { ObservationService } from '../../observation-service.js';
import type { NativeDeviceOwnership, NativeProjectOwnership } from '../../ownership.js';
import type { RunJournal } from '../../journal.js';
import { SeedvaultPlans } from './seedvault-plans.js';
import { SeedvaultExecution } from './seedvault-execution.js';
import { SeedvaultService } from './seedvault-service.js';

interface RecoveryServices {
  observations: ObservationService;
  projects: NativeProjectOwnership;
  devices: NativeDeviceOwnership;
  journal: RunJournal;
}

/** Construct experimental recovery only for explicit recovery operations or retained records. */
export function createSeedvaultServices(
  options: EngineOptions & { clock: () => Date },
  services: RecoveryServices,
): SeedvaultService {
  const { project, store, clock } = options;
  const { observations, projects, devices, journal } = services;
  const plans = new SeedvaultPlans(project, store, options.seedvault, observations, clock);
  const execution = new SeedvaultExecution(store, plans, devices, journal);
  return new SeedvaultService(project, store, plans, execution, projects, devices, journal, clock);
}
