import {
  AdapterError,
  collectOblivionKeys,
  collectSessionIds,
  collectSimCards,
  inspectSimCards,
  sameSimCards,
  normalizePhoneNumber,
  normalizeSessionId,
  OBLIVION_PACKAGE,
  OBLIVION_SIGNER,
  SESSION_PACKAGE,
  SESSION_SIGNER,
  type CollectedProfileValue,
} from '@pxv/adapters';
import type { SelectedTarget } from '@pxv/contracts';
import type { CollectedRegistryValue } from '@pxv/engine';
import type { ApplicationCliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import type { CollectionSource, PrivateCollection } from './collection-types.js';
import { privateCollectionInput } from './private-input.js';

function normalizeOblivionKey(value: string): string | undefined {
  return value.length <= 16_384 && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

async function guardProfiles(
  context: ApplicationCliContext,
  target: SelectedTarget,
  profiles: CollectedProfileValue[],
  packageId: string,
  signer: string,
): Promise<void> {
  for (const entry of profiles) {
    await context.app.android.guardUser(target, entry.user, context.signal);
    if (entry.versionCode === undefined) continue;
    const identity = await context.app.android.installedIdentity(
      target,
      entry.user,
      packageId,
      context.signal,
    );
    if (
      identity.packageId !== packageId ||
      identity.signerSha256 !== signer ||
      identity.versionCode !== entry.versionCode
    )
      throw new AdapterError('App signing identity or version changed before saving');
  }
}

function profileResult(
  context: ApplicationCliContext,
  target: SelectedTarget,
  entries: CollectedProfileValue[],
  source: 'oblivion' | 'sessionid',
): PrivateCollection {
  const oblivion = source === 'oblivion';
  const values: CollectedRegistryValue[] = entries.flatMap((entry) =>
    entry.value === undefined
      ? []
      : [
          {
            scope: 'profile',
            profileId: entry.profileId,
            user: entry.user,
            field: oblivion ? 'oblivionNotificationWipeKey' : 'sessionMessengerId',
            value: entry.value,
            source: entry.manual
              ? `private ${oblivion ? 'Oblivion' : 'Session'} entry`
              : oblivion
                ? 'net.oblivion.wipe QR dialog'
                : 'Session own account settings',
          },
        ],
  );
  return {
    values,
    outcomes: entries.map((entry) => ({
      scope: 'profile',
      profileId: entry.profileId,
      status: entry.status,
    })),
    guard: () =>
      guardProfiles(
        context,
        target,
        entries,
        oblivion ? OBLIVION_PACKAGE : SESSION_PACKAGE,
        oblivion ? OBLIVION_SIGNER : SESSION_SIGNER,
      ),
  };
}

function appSource(name: 'oblivion' | 'sessionid'): CollectionSource {
  const label = name === 'oblivion' ? 'Oblivion' : 'Session';
  return {
    name,
    label,
    profiles: true,
    async collect(context, target, profiles, scope, lease) {
      const options = {
        lease,
        signal: context.signal,
        obligations: scope.writer(),
        unlock: (profileId: string) =>
          confirmation(
            context.io,
            `Privately unlock and dismiss the lock screen for profile ${profileId}. ${name === 'oblivion' ? 'Opening Oblivion may enable its wipe triggers; confirm opening the configured app' : 'Confirm opening Session to read your own account ID'}`,
            false,
            context.signal,
          ),
        manual: (profileId: string) =>
          privateCollectionInput(
            context,
            `Privately enter ${label} ${name === 'oblivion' ? 'wipe key' : 'account ID'} for ${profileId}`,
            name === 'oblivion' ? normalizeOblivionKey : normalizeSessionId,
          ),
      };
      if (name === 'sessionid')
        return profileResult(
          context,
          target,
          await collectSessionIds(context.app.android, target, profiles, options),
          name,
        );
      const entries = await collectOblivionKeys(context.app.android, target, profiles, options);
      return profileResult(
        context,
        target,
        entries.map(({ key, ...entry }) => ({ ...entry, ...(key === undefined ? {} : { value: key }) })),
        name,
      );
    },
  };
}

async function privateSimNumbers(context: ApplicationCliContext, slot?: number): Promise<string | undefined> {
  if (slot !== undefined)
    return privateCollectionInput(
      context,
      `Privately enter the phone number for SIM slot ${slot + 1}`,
      normalizePhoneNumber,
    );
  const numbers: string[] = [];
  for (let index = 0; index < 64; index++) {
    const number = await privateCollectionInput(
      context,
      `Subscription details unavailable. Privately enter current SIM number ${index + 1}; empty finishes the list`,
      normalizePhoneNumber,
    );
    if (!number) break;
    numbers.push(number);
  }
  return numbers.length ? [...new Set(numbers)].join('\n') : undefined;
}

const simSource: CollectionSource = {
  name: 'simcards',
  label: 'SIM cards',
  profiles: false,
  async collect(context, target, _profiles, _scope, lease) {
    const result = await collectSimCards(context.app.android, target, {
      lease,
      signal: context.signal,
      manual: (slot) => privateSimNumbers(context, slot),
    });
    return {
      values: result.numbers.length
        ? [
            {
              scope: 'device',
              field: 'phoneNumber',
              value: [...new Set(result.numbers)].join('\n'),
              source: result.manual ? 'SIM collection with private entry' : 'current SIM subscriptions',
            },
          ]
        : [],
      outcomes: result.outcomes,
      async guard() {
        if (!sameSimCards(result, await inspectSimCards(context.app.android, target, context.signal)))
          throw new AdapterError('Current SIM subscriptions changed; collect and confirm numbers again');
      },
    };
  },
};

export function collectionSource(name: string | undefined): CollectionSource {
  if (name === 'collect-oblivion') return appSource('oblivion');
  if (name === 'collect-sessionid') return appSource('sessionid');
  if (name === 'collect-simcards') return simSource;
  throw new Error('Unknown collection command');
}
