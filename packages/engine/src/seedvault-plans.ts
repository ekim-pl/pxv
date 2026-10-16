import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  digest,
  validateSeedvaultInspection,
  validateSeedvaultRequest,
  validatePlan,
  type SeedvaultInspection,
  type SeedvaultRequest,
  type SelectedTarget,
} from '@pxv/contracts';
import type { Store } from '@pxv/runtime';
import type { ObservationReader } from './observation-service.js';
import type { ProjectContext } from './project.js';
import { planGeneration, assertPlanGeneration } from './plan-generation.js';
import type { PreparedSeedvaultOperation, SeedvaultWorkflowPort } from './seedvault-types.js';

type Draft = Omit<PreparedSeedvaultOperation, 'reviewSummary'>;

function planDigest(prepared: Draft): string {
  const { digest: _digest, ...plan } = prepared.plan;
  void _digest;
  return digest({ ...prepared, plan });
}

function exactSummary(prepared: Draft): string {
  return canonicalJson({
    ...prepared,
    profileUnlocksAndRecoveryWords: 'Enter privately on the phone; never provide them to PXV',
    completion: 'Application and file backup/restore must both be measured',
  });
}

/** Lock and foreground transitions are expected; Android identities and executable pins are not. */
export function seedvaultIdentity(value: SeedvaultInspection): string {
  return digest({
    deviceSerial: value.deviceSerial,
    osFingerprint: value.osFingerprint,
    unsupportedUsers: value.unsupportedUsers,
    profiles: value.profiles
      .map(({ profileId, user, package: app }) => ({ profileId, user, package: app }))
      .sort((a, b) => a.profileId.localeCompare(b.profileId)),
  });
}

export class SeedvaultPlans {
  constructor(
    readonly project: ProjectContext,
    readonly store: Store,
    readonly port: SeedvaultWorkflowPort | undefined,
    readonly observations: ObservationReader,
    readonly clock: () => Date,
  ) {}
  has(id: string): Promise<boolean> {
    return this.store.get('seedvault-plans', id).then((value) => value !== undefined);
  }
  async inspect(target: SelectedTarget, signal?: AbortSignal): Promise<SeedvaultInspection> {
    this.observations.assertTarget(target);
    if (!this.port) throw new Error('Seedvault adapter is unavailable');
    const value = validateSeedvaultInspection(await this.port.inspect(target, this.project.policy, signal));
    if (value.deviceSerial !== target.device.canonicalSerial)
      throw new Error('Seedvault observed identity differs from enrollment');
    return value;
  }
  private validateProfiles(value: SeedvaultInspection): void {
    if (value.unsupportedUsers.length)
      throw new Error('Unsupported Android users require explicit resolution before Seedvault operations');
    const expected = this.project.policy.profiles.map((profile) => profile.id).sort();
    const actual = value.profiles.map((profile) => profile.profileId).sort();
    if (digest(expected) !== digest(actual))
      throw new Error('Every persistent profile must have exactly one reviewed policy mapping');
    const users = value.profiles.map((profile) => profile.user);
    if (
      new Set(users.map((user) => user.userId)).size !== users.length ||
      new Set(users.map((user) => user.serialNo)).size !== users.length
    )
      throw new Error('Seedvault profile mappings reuse an Android user identity');
    for (const observed of value.profiles) {
      const policy = this.project.policy.profiles.find((profile) => profile.id === observed.profileId);
      if (
        !policy ||
        policy.name !== observed.user.name ||
        (policy.kind === 'owner') !== (observed.user.userId === 0)
      )
        throw new Error('Seedvault profile name or owner identity differs from policy');
    }
  }
  async prepare(
    target: SelectedTarget,
    request: SeedvaultRequest,
    signal?: AbortSignal,
    refreshedFrom?: PreparedSeedvaultOperation['refreshedFrom'],
  ): Promise<PreparedSeedvaultOperation> {
    if (target.device.kind !== 'pixel' || target.transport.kind !== 'wifi')
      throw new Error('Seedvault requires an enrolled Pixel wireless ADB endpoint');
    const lifecycleGeneration = await planGeneration(this.store, target.device.assetId);
    const checked = validateSeedvaultRequest(request);
    const baseline = await this.inspect(target, signal);
    this.validateProfiles(baseline);
    if (refreshedFrom) {
      const order = refreshedFrom.progress.profiles.map((profile) => profile.profileId);
      baseline.profiles.sort((a, b) => order.indexOf(a.profileId) - order.indexOf(b.profileId));
    }
    this.validateSources(checked, baseline);
    const draft: Draft = {
      schemaVersion: 1,
      kind: 'seedvault',
      ...(lifecycleGeneration ? { lifecycleGeneration } : {}),
      plan: {
        schemaVersion: 1,
        device: target.device,
        actions: [],
        id: randomUUID(),
        digest: '',
        projectId: this.project.config.id,
        policyDigest: this.project.resolved.digest,
        createdAt: this.clock().toISOString(),
      },
      target,
      request: checked,
      baseline,
      expiresAt: new Date(this.clock().getTime() + 900_000).toISOString(),
      ...(refreshedFrom ? { refreshedFrom } : {}),
    };
    draft.plan.digest = planDigest(draft);
    const prepared = { ...draft, reviewSummary: exactSummary(draft) };
    await assertPlanGeneration(this.store, target.device.assetId, lifecycleGeneration);
    await this.store.set('seedvault-plans', draft.plan.id, prepared);
    return prepared;
  }
  private validateSources(request: SeedvaultRequest, value: SeedvaultInspection): void {
    if (request.operation !== 'restore') return;
    const expected = value.profiles.map((profile) => profile.profileId).sort();
    const actual = (request.sources ?? []).map((source) => source.profileId).sort();
    if (digest(expected) !== digest(actual))
      throw new Error('Restore requires one explicit source backup for every target profile');
  }
  /** Historical reporting cannot authorize a device operation. */
  async readHistorical(id: string): Promise<PreparedSeedvaultOperation> {
    const value = await this.store.get<PreparedSeedvaultOperation>('seedvault-plans', id);
    if (!value) throw new Error('Seedvault reviewed plan does not exist');
    const { reviewSummary, ...draft } = value;
    this.validateStored(draft);
    if (
      value.plan.id !== id ||
      value.plan.digest !== planDigest(draft) ||
      reviewSummary !== exactSummary(draft)
    )
      throw new Error('Stored Seedvault review changed; preserve it for inspection');
    return value;
  }
  async read(id: string, summary?: string, allowExpired = false): Promise<PreparedSeedvaultOperation> {
    const value = await this.readHistorical(id);
    if (value.plan.policyDigest !== this.project.resolved.digest)
      throw new Error('Project policy or executable changed; prepare a new Seedvault review');
    this.observations.assertTarget(value.target);
    this.validateProfiles(value.baseline);
    await assertPlanGeneration(this.store, value.target.device.assetId, value.lifecycleGeneration);
    if (summary !== undefined && summary !== value.reviewSummary)
      throw new Error('Approval must match the exact reviewed summary');
    if (!allowExpired && Date.parse(value.expiresAt) < this.clock().getTime())
      throw new Error('Reviewed plan expired; refresh the intentional manual checkpoint');
    return value;
  }
  private validateStored(value: Draft): void {
    if (
      value.schemaVersion !== 1 ||
      value.kind !== 'seedvault' ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new Error('Malformed Seedvault review retained for inspection');
    validatePlan(value.plan);
    if (value.plan.projectId !== this.project.config.id)
      throw new Error('Seedvault historical review belongs to a different project');
    validateSeedvaultRequest(value.request);
    validateSeedvaultInspection(value.baseline);
    this.validateStoredTarget(value);
  }
  private validateStoredTarget(value: Draft): void {
    if (
      value.plan.actions.length ||
      digest(value.plan.device) !== digest(value.target.device) ||
      value.baseline.deviceSerial !== value.target.device.canonicalSerial ||
      value.target.device.kind !== 'pixel' ||
      value.target.transport.kind !== 'wifi'
    )
      throw new Error('Seedvault retained target identity is inconsistent');
    if (
      !value.target.device.transports.some(
        (transport) => digest(transport) === digest(value.target.transport),
      )
    )
      throw new Error('Seedvault retained transport is not bound to its reviewed device');
  }
}
