import type { SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError } from './command.js';
import { RecipeService } from './recipes.js';
import { matchUiNode } from './ui-snapshot.js';
import { OBLIVION_PACKAGE, OBLIVION_SIGNER, oblivionKeyField, readOblivionDialogKey } from './oblivion-ui.js';
import {
  assertCollectionUnlocked,
  collectProfileValues,
  type CollectionProfile,
  type CollectedProfileValue,
  type ProfileCollectionOptions,
} from './profile-collection.js';
export { OBLIVION_PACKAGE, OBLIVION_SIGNER } from './oblivion-ui.js';
export { restoreCollectionForeground as restoreOblivionForeground } from './profile-collection.js';

export type OblivionProfile = CollectionProfile;
export interface CollectedOblivionProfile extends Omit<CollectedProfileValue, 'value'> {
  key?: string;
}
export type OblivionCollectionOptions = ProfileCollectionOptions;

async function readProfile(
  android: AndroidAdapter,
  target: SelectedTarget,
  profile: OblivionProfile,
  options: OblivionCollectionOptions,
): Promise<string> {
  await android.launch(target, profile.user, OBLIVION_PACKAGE, options);
  const ui = new RecipeService(android);
  const main = await ui.snapshot(target, profile.user, OBLIVION_PACKAGE, options.signal);
  oblivionKeyField(main, 'idDisplay');
  const button = matchUiNode(main, { resourceId: `${OBLIVION_PACKAGE}:id/qrButton` }, OBLIVION_PACKAGE);
  if (!button) throw new AdapterError('Expected Oblivion QR control is missing');
  await ui.tap(target, profile.user, OBLIVION_PACKAGE, button, options);
  const dialog = await ui.snapshot(target, profile.user, OBLIVION_PACKAGE, options.signal);
  const key = readOblivionDialogKey(main, dialog);
  await assertCollectionUnlocked(android, target, profile.user, options.signal);
  const close = matchUiNode(dialog, { resourceId: `${OBLIVION_PACKAGE}:id/closeQrPopup` }, OBLIVION_PACKAGE);
  if (!close) throw new AdapterError('Expected Oblivion dialog close control is missing');
  await ui.tap(target, profile.user, OBLIVION_PACKAGE, close, options);
  return key;
}

export async function collectOblivionKeys(
  android: AndroidAdapter,
  target: SelectedTarget,
  profiles: OblivionProfile[],
  options: OblivionCollectionOptions,
): Promise<CollectedOblivionProfile[]> {
  const results = await collectProfileValues(
    android,
    target,
    profiles,
    {
      name: 'Oblivion',
      code: 'OBLIVION',
      packageId: OBLIVION_PACKAGE,
      signer: OBLIVION_SIGNER,
      obligationKind: 'oblivion-foreground',
      read: readProfile,
    },
    options,
  );
  return results.map(({ value, ...entry }) => ({ ...entry, ...(value === undefined ? {} : { key: value }) }));
}
