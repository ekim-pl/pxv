import type { SelectedTarget } from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import { AdapterError } from './command.js';
import { RecipeService } from './recipes.js';
import { matchUiNode } from './ui-snapshot.js';
import { readSessionAccountId } from './sessionid-ui.js';
export { normalizeSessionId } from './sessionid-ui.js';
import {
  collectProfileValues,
  type CollectionProfile,
  type ProfileCollectionOptions,
} from './profile-collection.js';

export const SESSION_PACKAGE = 'network.loki.messenger';
export const SESSION_SIGNER = 'f2a0ecf70686447d1d6c6cbbf58c42890500ccf41af372ae2099303980824edd';

async function readProfile(
  android: AndroidAdapter,
  target: SelectedTarget,
  profile: CollectionProfile,
  options: ProfileCollectionOptions,
): Promise<string> {
  await android.launch(target, profile.user, SESSION_PACKAGE, options);
  const ui = new RecipeService(android);
  const home = await ui.snapshot(target, profile.user, SESSION_PACKAGE, options.signal);
  const avatar =
    matchUiNode(home, { description: 'User settings' }, SESSION_PACKAGE) ??
    matchUiNode(home, { resourceId: `${SESSION_PACKAGE}:id/profilePicture` }, SESSION_PACKAGE);
  if (avatar) await ui.tap(target, profile.user, SESSION_PACKAGE, avatar, options);
  const settings = await ui.snapshot(target, profile.user, SESSION_PACKAGE, options.signal);
  const windows = await android.shell(
    target,
    ['dumpsys', 'window', 'windows'],
    options.signal ? { signal: options.signal } : {},
  );
  const focus = /mCurrentFocus=Window\{[^\n]*?\bu(\d+)\s+([^\s}]+)/u.exec(windows);
  if (
    focus?.[1] !== String(profile.user.userId) ||
    focus[2] !== `${SESSION_PACKAGE}/org.thoughtcrime.securesms.preferences.SettingsActivity`
  )
    throw new AdapterError('Open your own Session account settings privately');
  return readSessionAccountId(settings);
}

export function collectSessionIds(
  android: AndroidAdapter,
  target: SelectedTarget,
  profiles: CollectionProfile[],
  options: ProfileCollectionOptions,
) {
  return collectProfileValues(
    android,
    target,
    profiles,
    {
      name: 'Session',
      code: 'SESSION',
      packageId: SESSION_PACKAGE,
      signer: SESSION_SIGNER,
      obligationKind: 'collection-foreground',
      read: readProfile,
    },
    options,
  );
}
