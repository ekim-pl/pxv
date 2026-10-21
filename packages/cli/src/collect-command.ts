import { AdapterError, type CollectionProfile } from '@pxv/adapters';
import {
  canonicalJson,
  sameAndroidUser,
  validatePhoneRegistryDocument,
  type PhoneRegistryDocument,
  type PhoneRegistryEpoch,
  type SelectedTarget,
} from '@pxv/contracts';
import {
  assertProjectFresh,
  assertFinalizationResolved,
  assertRegistryAnchor,
  containedPath,
  mergeCollectedRegistryValues,
  mergeOblivionRegistryKeys,
  type CollectedOblivionKey,
  NativeDeviceOwnership,
  readRegistryAnchor,
  readRegistryGeneration,
  ResourceScope,
} from '@pxv/engine';
import { hostControlRoot, updateEncryptedRegistry, type DeviceLease } from '@pxv/runtime';
import { randomUUID } from 'node:crypto';
import { stdin, stderr } from 'node:process';
import type { ApplicationCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import type { CollectionSource, PrivateCollection } from './collection-types.js';
import { collectionSource } from './collection-sources.js';
import { registryCommitHooks } from './registry-commit.js';
import { registryPassword } from './registry-password.js';

type Commit = (
  value: PhoneRegistryDocument,
  before?: (hash: string) => Promise<void>,
  after?: (hash: string) => Promise<void>,
) => Promise<void>;

function validateCollection(
  context: ApplicationCliContext,
  target: SelectedTarget,
  source: CollectionSource,
): void {
  if (
    context.section !== 'device' ||
    context.flag('all') ||
    context.values['group'] !== undefined ||
    target.device.kind !== 'pixel'
  )
    throw new Error(`${source.label} collection requires one exact enrolled Pixel --asset`);
  if (context.dockerMode || context.value('execution', 'host') !== 'host')
    throw new Error(`${source.label} collection requires local host execution`);
  if (!context.io.confirm && (!stdin.isTTY || !stderr.isTTY))
    throw new Error(
      `${source.label} collection requires local interactive confirmation; --yes cannot bypass it`,
    );
}

async function enrolledProfiles(
  context: ApplicationCliContext,
  target: SelectedTarget,
  generation: PhoneRegistryEpoch,
): Promise<CollectionProfile[]> {
  const observation = await context.app.engine.observe(target, context.signal);
  const expected = new Set(context.project.policy.profiles.map((profile) => profile.id));
  for (const profile of observation.profiles) {
    const enrolled = generation.observedUsers?.[profile.profileId];
    if (
      !enrolled ||
      !sameAndroidUser(enrolled, profile.user) ||
      generation.unobservedProfiles?.includes(profile.profileId)
    )
      throw new AdapterError('Current enrolled Android profile identities are required before collection');
    if (!expected.delete(profile.profileId)) throw new AdapterError('Unexpected enrolled profile identity');
  }
  if (expected.size)
    throw new AdapterError('Every enrolled policy profile must have a verified Android identity');
  return observation.profiles.map(({ profileId, user }) => ({ profileId, user }));
}

async function confirmRetention(context: ApplicationCliContext, source: CollectionSource): Promise<void> {
  try {
    context.signal.throwIfAborted();
    await confirmation(
      context.io,
      `Confirm retention of the collected ${source.label} values as current, replacing ${source.name === 'simcards' ? 'the complete saved device number list' : 'the corresponding saved profile fields'}?`,
      false,
      context.signal,
    );
    context.signal.throwIfAborted();
  } catch {
    throw new AdapterError(`${source.label} collection cancelled or interrupted; registry was not changed`);
  }
}

function oblivionKeys(collected: PrivateCollection): CollectedOblivionKey[] {
  return collected.values.flatMap((entry) =>
    entry.scope === 'profile' && entry.field === 'oblivionNotificationWipeKey'
      ? [{ profileId: entry.profileId, user: entry.user, key: entry.value, source: entry.source }]
      : [],
  );
}

async function saveCollected(
  context: ApplicationCliContext,
  target: SelectedTarget,
  source: CollectionSource,
  document: PhoneRegistryDocument,
  generation: PhoneRegistryEpoch,
  collected: PrivateCollection,
  commit: Commit,
): Promise<void> {
  const previous = document.devices.find((entry) => entry.assetId === target.device.assetId);
  let updated = document;
  context.io.error(
    `${source.label} collection review: ${collected.outcomes
      .map(
        (entry) =>
          `${entry.profileId ?? (entry.slotIndex === undefined ? 'device' : `SIM slot ${entry.slotIndex + 1}`)}: ${entry.status}`,
      )
      .join('; ')}`,
  );
  if (collected.values.length) {
    await confirmRetention(context, source);
    const options = {
      expectedRevision: document.revision,
      expectedRecordRevision: previous?.revision ?? null,
      confirmedCurrent: true,
      now: new Date().toISOString(),
      generation,
      inventory: context.project.inventory,
    };
    updated =
      source.name === 'oblivion'
        ? mergeOblivionRegistryKeys(document, target.device, oblivionKeys(collected), options)
        : mergeCollectedRegistryValues(document, target.device, collected.values, options);
    const anchor = await readRegistryAnchor(context.app.store, context.project.config.id);
    await commit(
      updated,
      ...registryCommitHooks(context, context.app.store, anchor, async () => {
        context.signal.throwIfAborted();
        if (
          canonicalJson(await readRegistryGeneration(context.app.store, target.device)) !==
          canonicalJson(generation)
        )
          throw new AdapterError('Registry generation changed; collect and confirm values again');
        await context.app.android.guardTarget(target, context.signal);
        await collected.guard();
      }),
    );
  }
  context.output({
    collector: source.name,
    assetId: target.device.assetId,
    outcomes: collected.outcomes,
    saved: collected.values.length > 0,
    revision: updated.revision,
    recordRevision: updated.devices.find((entry) => entry.assetId === target.device.assetId)?.revision ?? 0,
  });
}

async function collectOwned(
  context: ApplicationCliContext,
  target: SelectedTarget,
  source: CollectionSource,
  scope: ResourceScope,
  generation: PhoneRegistryEpoch,
  lease: DeviceLease,
): Promise<PrivateCollection> {
  if ((await scope.list()).some((entry) => entry.status !== 'resolved'))
    throw new AdapterError(
      'Device has unresolved recovery obligations; inspect and recover before collection',
    );
  const profiles = source.profiles ? await enrolledProfiles(context, target, generation) : [];
  return source.collect(context, target, profiles, scope, lease);
}

async function collectionOperation(
  context: ApplicationCliContext,
  target: SelectedTarget,
  source: CollectionSource,
  document: PhoneRegistryDocument,
  commit: Commit,
): Promise<void> {
  await assertFinalizationResolved(context.app.store, target.device.assetId);
  const operationId = `${source.name}-${randomUUID()}`;
  const generation = await readRegistryGeneration(context.app.store, target.device);
  const scope = new ResourceScope(context.app.store, target.device.canonicalSerial, operationId);
  let failure: Error | undefined;
  await new NativeDeviceOwnership(hostControlRoot()).run(target, operationId, async (lease) => {
    let collected: PrivateCollection | undefined;
    try {
      collected = await collectOwned(context, target, source, scope, generation, lease);
      await saveCollected(context, target, source, document, generation, collected, commit);
    } catch (error) {
      if (
        (await scope.list()).some((entry) => entry.operationId === operationId && entry.status !== 'resolved')
      )
        throw new Error(`${source.label} collection requires inspection; recover operation ${operationId}`);
      failure = new Error(
        error instanceof AdapterError
          ? error.message
          : `${source.label} collection did not complete; inspect readiness and encrypted registry state before retrying`,
      );
    } finally {
      for (const entry of collected?.values ?? []) entry.value = '';
    }
  });
  if (failure) throw failure;
}

export async function collectCommand(
  context: ApplicationCliContext,
  target: SelectedTarget,
): Promise<number> {
  const source = collectionSource(context.command);
  validateCollection(context, target, source);
  await assertFinalizationResolved(context.app.store, target.device.assetId);
  const password = await registryPassword(context);
  try {
    const path = await containedPath(context.project.root, 'secrets/phone-registry.pxv');
    await updateEncryptedRegistry(
      path,
      context.project.config.id,
      password,
      validatePhoneRegistryDocument,
      async ({ value: document, revision }, commit) => {
        if (document.projectId !== context.project.config.id)
          throw new Error('Registry project identity differs');
        await assertProjectFresh(context.project);
        await assertRegistryAnchor(context.app.store, context.project.config.id, revision);
        await collectionOperation(context, target, source, document, commit);
      },
    );
    return 0;
  } finally {
    password.fill(0);
  }
}
