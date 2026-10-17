import {
  canonicalJson,
  parseDocument,
  validatePhoneRegistryDocument,
  validatePhoneRegistryRecordInput,
  type DeviceTarget,
  type PhoneRegistryDocument,
  type PhoneRegistryEpoch,
  type PhoneRegistryRecord,
} from '@pxv/contracts';
import {
  assertRegistryAnchor,
  containedPath,
  inspectRegistryBinding,
  phoneRegistryRecordSummary,
  phoneRegistrySummary,
  readRegistryGeneration,
  readRegistryAnchor,
  reconcilePhoneRegistryDocument,
  upsertPhoneRegistryRecord,
  type RegistryAnchor,
} from '@pxv/engine';
import {
  createEncryptedRegistry,
  readEncryptedRegistry,
  readRegistryPrivateFile,
  rekeyEncryptedRegistry,
  SqliteStore,
  writeEncryptedRegistry,
  writeRegistryPrivateFile,
  type Store,
} from '@pxv/runtime';
import { access } from 'node:fs/promises';
import type { ProjectCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { registryPassword } from './registry-password.js';
import { registryCommitHooks } from './registry-commit.js';
import { registryOutputPath } from './registry-output.js';

function requestedAsset(context: ProjectCliContext): string {
  if (context.flag('all') || context.values['group'] !== undefined)
    throw new Error('Registry access requires one exact --asset');
  return context.value('asset');
}
function selectedAsset(context: ProjectCliContext): DeviceTarget {
  const assetId = requestedAsset(context);
  const device = context.project.inventory.devices.find((item) => item.assetId === assetId);
  if (!device) throw new Error('Registry asset is not enrolled');
  return device;
}

function recordRevision(context: ProjectCliContext): number {
  const value = context.value('record-revision');
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) throw new Error('Invalid registry record revision');
  return Number(value);
}

async function inputRecord(context: ProjectCliContext, device: DeviceTarget) {
  const bytes = await readRegistryPrivateFile(context.value('file'), 2 * 1024 * 1024);
  try {
    const source = bytes.toString('utf8');
    JSON.parse(source);
    const input: unknown = parseDocument(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const record = validatePhoneRegistryRecordInput({
      assetId: device.assetId,
      canonicalSerial: device.canonicalSerial,
      codename: device.codename,
      ...input,
    });
    for (const profile of record.profiles) {
      const policy = context.project.policy.profiles.find((item) => item.id === profile.profileId);
      if (!policy || (policy.kind === 'owner') !== (profile.user.userId === 0)) throw new Error();
    }
    return record;
  } catch {
    throw new Error('Invalid private registry record input');
  } finally {
    bytes.fill(0);
  }
}

async function epochsFor(store: Store, document: PhoneRegistryDocument) {
  const epochs = new Map<string, PhoneRegistryEpoch>();
  for (const record of document.devices)
    epochs.set(record.assetId, await readRegistryGeneration(store, record));
  return epochs;
}

async function updateRecord(
  context: ProjectCliContext,
  store: Store,
  path: string,
  password: Buffer,
  document: PhoneRegistryDocument,
  revision: string,
  anchor: RegistryAnchor | undefined,
): Promise<void> {
  const device = selectedAsset(context);
  const input = await inputRecord(context, device);
  const expectedRecordRevision = recordRevision(context);
  const generation = await readRegistryGeneration(store, device);
  await confirmation(
    context.io,
    'Confirm these privately supplied values and any current-credential claims?',
    context.flag('yes'),
  );
  const updated = upsertPhoneRegistryRecord(document, input, {
    expectedRevision: document.revision,
    expectedRecordRevision: expectedRecordRevision === 0 ? null : expectedRecordRevision,
    confirmedCurrent: true,
    now: new Date().toISOString(),
    generation,
    inventory: context.project.inventory,
  });
  const hooks = registryCommitHooks(context, store, anchor, async () => {
    if (canonicalJson(await readRegistryGeneration(store, device)) !== canonicalJson(generation))
      throw new Error('Phone generation changed; reload registry and confirm current credentials again');
  });
  await writeEncryptedRegistry(path, context.project.config.id, password, updated, revision, ...hooks);
  context.output({
    updated: device.assetId,
    revision: updated.revision,
    recordRevision: expectedRecordRevision + 1,
  });
}

function currentRecord(document: PhoneRegistryDocument, assetId: string): PhoneRegistryRecord {
  const record = document.devices.find((item) => item.assetId === assetId);
  if (!record) throw new Error('Phone has no registry record');
  return record;
}

async function revealRecord(
  context: ProjectCliContext,
  store: Store,
  document: PhoneRegistryDocument,
): Promise<void> {
  const assetId = requestedAsset(context);
  let record = currentRecord(document, assetId);
  if (context.values['record-revision'] !== undefined) {
    const wanted = recordRevision(context);
    if (wanted !== record.revision) {
      const historical = document.history.find(
        (entry) => entry.record.assetId === assetId && entry.record.revision === wanted,
      );
      if (!historical) throw new Error('Registry record revision does not exist');
      record = historical.record;
      record = inspectRegistryBinding(record, undefined, context.project.inventory);
    }
  }
  record = inspectRegistryBinding(
    record,
    await readRegistryGeneration(store, record),
    context.project.inventory,
  );
  const output = registryOutputPath(context);
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  try {
    await writeRegistryPrivateFile(output, bytes);
  } finally {
    bytes.fill(0);
  }
  context.output({ exported: true, assetId, recordRevision: record.revision, output });
}

async function readCommand(
  context: ProjectCliContext,
  store: Store,
  document: PhoneRegistryDocument,
): Promise<void> {
  const epochs = await epochsFor(store, document);
  if (context.command === 'history') {
    const assetId = requestedAsset(context);
    const records = document.history
      .filter((entry) => entry.record.assetId === assetId)
      .map((entry) => entry.record);
    currentRecord(document, assetId);
    context.output(
      records.map((record) => phoneRegistryRecordSummary(record, undefined, context.project.inventory)),
    );
    return;
  }
  const summary = phoneRegistrySummary(document, epochs, context.project.inventory);
  if (context.command === 'show') {
    const record = currentRecord(document, requestedAsset(context));
    summary.devices = summary.devices.filter((item) => item.assetId === record.assetId);
  }
  context.output(summary);
}

async function unlockedCommand(
  context: ProjectCliContext,
  password: Buffer,
  path: string,
  store: Store,
): Promise<void> {
  const projectId = context.project.config.id;
  const anchor = await readRegistryAnchor(store, projectId);
  if (context.command === 'init') {
    if (anchor !== undefined)
      throw new Error('Registry initialization requires inspection of retained state');
    await createEncryptedRegistry(
      path,
      projectId,
      password,
      {
        schemaVersion: 1,
        projectId,
        revision: 0,
        devices: [],
        history: [],
      },
      ...registryCommitHooks(context, store, undefined),
    );
    context.output({ initialized: true });
    return;
  }
  const { value: document, revision } = await readEncryptedRegistry(path, projectId, password, (value) => {
    const document = validatePhoneRegistryDocument(value);
    if (document.projectId !== projectId) throw new Error('Registry project identity differs');
    return document;
  });
  if (context.command === 'reconcile') {
    await confirmation(
      context.io,
      'Reconcile this retained registry copy and mark every retained current credential stale?',
      context.flag('yes'),
    );
    const reconciled = reconcilePhoneRegistryDocument(document, new Date().toISOString());
    await writeEncryptedRegistry(
      path,
      projectId,
      password,
      reconciled,
      revision,
      ...registryCommitHooks(context, store, anchor),
    );
    context.output({ reconciled: true, revision: reconciled.revision, credentialsStale: true });
    return;
  }
  await assertRegistryAnchor(store, projectId, revision);
  if (context.command === 'rekey') {
    const replacement = await registryPassword(context, true, true);
    try {
      await rekeyEncryptedRegistry(
        path,
        projectId,
        password,
        replacement,
        revision,
        ...registryCommitHooks(context, store, anchor),
      );
    } finally {
      replacement.fill(0);
    }
    context.output({ rekeyed: true });
    return;
  }
  if (context.command === 'update')
    await updateRecord(context, store, path, password, document, revision, anchor);
  else if (context.command === 'reveal') await revealRecord(context, store, document);
  else await readCommand(context, store, document);
}

export async function registryCommand(context: ProjectCliContext): Promise<number> {
  if (
    !['init', 'list', 'show', 'history', 'update', 'reveal', 'rekey', 'reconcile'].includes(
      context.command ?? '',
    )
  )
    throw new Error('Unknown registry command');
  const password = await registryPassword(context, false, context.command === 'init');
  try {
    const path = await containedPath(context.project.root, 'secrets/phone-registry.pxv', false);
    const database = await containedPath(context.project.root, 'state/pxv.sqlite3');
    await access(database);
    const store = await SqliteStore.open(database, {
      readOnly: ['list', 'show', 'history', 'reveal'].includes(context.command ?? ''),
    });
    try {
      await unlockedCommand(context, password, path, store);
    } finally {
      await store.close();
    }
    return 0;
  } finally {
    password.fill(0);
  }
}
