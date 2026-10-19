import { validatePhoneRegistryDocument, type PhoneRegistryDocument } from '@pxv/contracts';
import {
  assertRegistryAnchor,
  containedPath,
  inspectRegistryBinding,
  readRegistryGeneration,
} from '@pxv/engine';
import { writeCredentialInsert } from '@pxv/guides';
import { readEncryptedRegistry, SqliteStore, type Store } from '@pxv/runtime';
import type { ProjectCliContext } from './arguments.js';
import { registryOutputPath } from './registry-output.js';
import { registryPassword } from './registry-password.js';

async function writeInsert(
  context: ProjectCliContext,
  store: Store,
  document: PhoneRegistryDocument,
): Promise<void> {
  if (context.flag('all') || context.values['group'] !== undefined)
    throw new Error('Registry access requires one exact --asset');
  const device = context.project.inventory.devices.find((entry) => entry.assetId === context.value('asset'));
  if (!device) throw new Error('Registry asset is not enrolled');
  const locale = context.value('locale', 'en');
  if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
  const output = registryOutputPath(context);
  if (!output.toLowerCase().endsWith('.pdf')) throw new Error('Insert output must be a PDF file');
  const saved = document.devices.find((entry) => entry.assetId === device.assetId);
  if (!saved) throw new Error('Phone has no registry record');
  const record = inspectRegistryBinding(
    saved,
    await readRegistryGeneration(store, saved),
    context.project.inventory,
  );
  const support = context.project.product.support;
  await writeCredentialInsert(record, output, {
    locale,
    model: device.model,
    exportedAt: new Date().toISOString(),
    support: `${support.name}: ${support.email} · ${support.url}`,
    chromiumExecutable: context.value('chromium'),
  });
  context.output({ exported: true, assetId: device.assetId, recordRevision: record.revision, output });
}

/** Shared offline, read-only registry loading and private rendering for both insert entry points. */
export async function exportRegistryInsert(context: ProjectCliContext): Promise<void> {
  if (context.dockerMode || context.value('execution', 'host') !== 'host')
    throw new Error('The private insert requires local host execution');
  const password = await registryPassword(context);
  try {
    const store = await SqliteStore.open(await containedPath(context.project.root, 'state/pxv.sqlite3'), {
      readOnly: true,
    });
    try {
      const { value: document, revision } = await readEncryptedRegistry(
        await containedPath(context.project.root, 'secrets/phone-registry.pxv'),
        context.project.config.id,
        password,
        validatePhoneRegistryDocument,
      );
      if (document.projectId !== context.project.config.id)
        throw new Error('Registry project identity differs');
      await assertRegistryAnchor(store, context.project.config.id, revision);
      await writeInsert(context, store, document);
    } finally {
      await store.close();
    }
  } finally {
    password.fill(0);
  }
}
