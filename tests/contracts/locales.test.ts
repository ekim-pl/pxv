import { describe, expect, it } from 'vitest';
import {
  canonicalLocale,
  evaluateObservation,
  finalSetupActions,
  profileLocale,
  requiredAttestations,
  validateAction,
  validateObservation,
  validatePolicy,
} from '@pxv/contracts';
import type { DeviceObservation, ProfilePolicy } from '@pxv/contracts';
import { observation, policy } from './fixtures.js';

function unconfiguredProfile(): ProfilePolicy {
  const profile = structuredClone(policy.profiles[0]!);
  delete profile.language;
  return profile;
}

function localePolicy() {
  const owner = { ...unconfiguredProfile(), defaultLocale: 'de-DE' };
  return validatePolicy({
    ...policy,
    capabilities: [],
    profiles: [
      owner,
      { ...structuredClone(owner), id: 'work', name: 'Work', kind: 'secondary', defaultLocale: 'zh-Hant-TW' },
    ],
  });
}

describe('explicit Android profile locales', () => {
  it.each([
    ['de', 'de'],
    ['de-de', 'de-DE'],
    ['EN-us', 'en-US'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
    ['iw-il', 'he-IL'],
    ['sh', 'sr-Latn'],
    ['en-US-u-nu-latn', 'en-US-u-nu-latn'],
  ])('canonicalizes %s as %s', (input, expected) => {
    expect(canonicalLocale(input)).toBe(expected);
  });

  it('accepts a complete locale at the maximum input length', () => {
    const locale = `en-x-${'abcdefgh-'.repeat(13)}abcdef`;
    expect(locale).toHaveLength(128);
    expect(canonicalLocale(locale)).toBe(locale);
  });

  it.each([
    undefined,
    null,
    42,
    {},
    ['de-DE'],
    '',
    'a',
    'en_US',
    ' en-US',
    'en-US ',
    'en\nUS',
    'en-US,pl-PL',
    'de-ß',
    'und',
    'UND-Latn',
    'x-private',
    'en-u',
    'de-12',
    'en-abcdefghi',
    `en-x-${'abcdefgh-'.repeat(13)}abcdefg`,
  ])('rejects malformed or unspecified locale %j', (input) => {
    expect(() => canonicalLocale(input)).toThrow('BCP 47');
    if (input !== undefined)
      for (const field of ['defaultLocale', 'language'])
        expect(() =>
          validatePolicy({ ...policy, profiles: [{ ...unconfiguredProfile(), [field]: input }] }),
        ).toThrow();
  });

  it('resolves the default, legacy alias, or absence without introducing a locale', () => {
    expect(profileLocale({ defaultLocale: 'de-DE', language: 'pl-PL' })).toBe('de-DE');
    expect(profileLocale({ language: 'pl-PL' })).toBe('pl-PL');
    expect(profileLocale({})).toBeUndefined();
    const selected = validatePolicy({ ...policy, profiles: [unconfiguredProfile()], capabilities: [] });
    expect(selected.profiles[0]).not.toHaveProperty('defaultLocale');
    expect(selected.profiles[0]).not.toHaveProperty('language');
    expect(finalSetupActions(selected)).toEqual([]);
    expect(requiredAttestations(selected)).not.toContain('normal_credentials');
  });

  it('normalizes both aliases and rejects conflicting canonical values', () => {
    const selected = validatePolicy({
      ...policy,
      profiles: [{ ...unconfiguredProfile(), defaultLocale: 'iw-il', language: 'he-IL' }],
    });
    expect(selected.profiles[0]).toMatchObject({ defaultLocale: 'he-IL', language: 'he-IL' });
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...unconfiguredProfile(), defaultLocale: 'de-DE', language: 'pl-PL' }],
      }),
    ).toThrow('conflicts with legacy language');
    expect(validatePolicy(policy).profiles[0]?.language).toBe('pl-PL');
  });

  it('canonicalizes arbitrary locale observations and durable language actions', () => {
    expect(validateAction({ kind: 'language', profileId: 'admin', language: 'SR-latn-rs' })).toEqual({
      kind: 'language',
      profileId: 'admin',
      language: 'sr-Latn-RS',
    });
    const actual = validateObservation({
      ...observation,
      profiles: [{ ...observation.profiles[0], language: 'de-de' }],
    });
    expect(actual.profiles[0]?.language).toBe('de-DE');
    expect(() => validateAction({ kind: 'language', profileId: 'admin', language: 'en-US,pl-PL' })).toThrow(
      'BCP 47',
    );
  });

  it('orders owner and secondary locale defaults after normal verification and before owner duress', () => {
    const selected = localePolicy();
    const owner = selected.profiles[0]!;
    owner.defaultCredential = { type: 'pin', secretRef: 'owner-lock' };
    selected.profiles[1]!.defaultCredential = { type: 'password', secretRef: 'work-lock' };
    owner.defaultDuress = {
      ownerCredentialRef: 'owner-current',
      pinRef: 'duress-pin',
      passwordRef: 'duress-password',
    };
    expect(finalSetupActions(validatePolicy(selected))).toEqual([
      { kind: 'default-credential', profileId: 'admin', credential: owner.defaultCredential },
      {
        kind: 'default-credential',
        profileId: 'work',
        credential: selected.profiles[1]!.defaultCredential,
      },
      expect.objectContaining({ kind: 'manual', capability: 'normal_credentials' }),
      { kind: 'language', profileId: 'admin', language: 'de-DE' },
      { kind: 'language', profileId: 'work', language: 'zh-Hant-TW' },
      { kind: 'default-duress', profileId: 'admin', duress: owner.defaultDuress },
      expect.objectContaining({ kind: 'manual', capability: 'duress' }),
    ]);
  });

  it('requires ordinary verification for locale-only defaults and compares each profile observation', () => {
    const selected = localePolicy();
    expect(requiredAttestations(selected)).toContain('normal_credentials');
    expect(finalSetupActions(selected)).toEqual([
      expect.objectContaining({ kind: 'manual', capability: 'normal_credentials' }),
      { kind: 'language', profileId: 'admin', language: 'de-DE' },
      { kind: 'language', profileId: 'work', language: 'zh-Hant-TW' },
    ]);
    const owner = { ...structuredClone(observation.profiles[0]!), language: 'de-DE' };
    const actual: DeviceObservation = {
      ...observation,
      profiles: [
        owner,
        {
          ...structuredClone(owner),
          profileId: 'work',
          user: { userId: 10, serialNo: 20, name: 'Work' },
          language: 'zh-Hant-TW',
        },
      ],
    };
    expect(evaluateObservation(selected, actual).passed).toBe(true);
    actual.profiles[1]!.language = 'en-US';
    expect(evaluateObservation(selected, actual).checks).toContainEqual({
      key: 'work.language',
      expected: 'zh-Hant-TW',
      actual: 'en-US',
      passed: false,
    });
    delete actual.profiles[0]!.language;
    expect(evaluateObservation(selected, actual).checks).toContainEqual({
      key: 'admin.language',
      expected: 'de-DE',
      actual: null,
      passed: false,
    });
  });
});
