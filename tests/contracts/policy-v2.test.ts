import { describe, expect, it } from 'vitest';
import {
  convertPolicyToV2,
  digest,
  evaluateObservation,
  osPolicyForTarget,
  resolvePolicy,
  validatePolicy,
  validatePolicyDocument,
  validateProduct,
  verifyResolvedPolicy,
  type OsPolicy,
} from '@pxv/contracts';
import { observation, policy, product, project } from './fixtures.js';

const image = (codename: string, release = '2026100600'): OsPolicy => ({
  codename,
  release,
  url: `https://releases.grapheneos.org/${codename}-install-${release}.zip`,
  signatureUrl: `https://releases.grapheneos.org/${codename}-install-${release}.zip.sig`,
  signerPrincipal: 'contact@grapheneos.org',
  namespace: 'factory images',
  publicKey: 'ssh-ed25519 AAAA',
});

describe('v2 policy authoring and historical locks', () => {
  it('defines a shared app once and normalizes device settings onto the owner exactly once', () => {
    const original = structuredClone(policy);
    const owner = original.profiles[0]!;
    const global = { namespace: 'global' as const, key: 'airplane_mode_on', value: '0' };
    owner.settings.push(global);
    original.profiles.push({ ...structuredClone(owner), id: 'work', name: 'Work', kind: 'secondary' });
    const document = convertPolicyToV2(original);
    expect(Object.keys(document.apps)).toEqual(['org.example.vpn']);
    expect(document.profiles.map((profile) => profile.apps)).toEqual([
      ['org.example.vpn'],
      ['org.example.vpn'],
    ]);
    expect(document.deviceSettings).toEqual([global]);
    expect(
      document.profiles.every((profile) =>
        profile.settings.every((setting) => setting.namespace !== 'global'),
      ),
    ).toBe(true);
    const normalized = validatePolicy(document);
    expect(normalized.profiles[0]?.settings).toContainEqual(global);
    expect(normalized.profiles[1]?.settings).not.toContainEqual(global);
    expect(normalized.profiles.map((profile) => profile.packages)).toEqual([owner.packages, owner.packages]);
    expect(original.profiles[1]?.settings).toContainEqual(global);
    expect(normalized.sourceSchemaVersion).toBe(2);
  });

  it('retains v1 normalized bytes and historical lock digests while v2 requires fresh approval', () => {
    expect(validatePolicy(policy)).toEqual(policy);
    expect(validatePolicy(policy)).not.toHaveProperty('sourceSchemaVersion');
    const retained = resolvePolicy(policy, project, product);
    expect(verifyResolvedPolicy(JSON.parse(JSON.stringify(retained)))).toEqual(retained);
    const converted = validatePolicy(convertPolicyToV2(policy));
    expect(converted.profiles).toEqual(policy.profiles);
    expect(digest(converted)).not.toBe(digest(policy));
    expect(resolvePolicy(converted, project, product).digest).not.toBe(retained.digest);
  });

  it('preserves distinct case-sensitive Android package IDs when catalog names would collide', () => {
    const original = structuredClone(policy);
    const owner = original.profiles[0]!;
    owner.packages.push({ ...owner.packages[0]!, packageId: 'org.example.VPN', sha256: 'b'.repeat(64) });
    const document = convertPolicyToV2(original);
    const references = document.profiles[0]!.apps;
    expect(new Set(references).size).toBe(2);
    expect(references.map((reference) => document.apps[reference]?.packageId)).toEqual([
      'org.example.vpn',
      'org.example.VPN',
    ]);
    expect(validatePolicy(document).profiles[0]!.packages).toEqual(owner.packages);
  });

  it('can convert an existing mixed-model v2 policy again without losing model pins or app references', () => {
    const document = convertPolicyToV2(policy);
    document.os = { akita: image('akita'), husky: image('husky', '2026100700') };
    const original = structuredClone(document);
    expect(convertPolicyToV2(document)).toEqual(original);
    expect(document).toEqual(original);
  });

  it('rejects conflicting legacy globals, unknown app references and misplaced v2 globals', () => {
    const owner = structuredClone(policy.profiles[0]!);
    owner.settings.push({ namespace: 'global', key: 'airplane_mode_on', value: '0' });
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [
          owner,
          {
            ...owner,
            id: 'work',
            name: 'Work',
            kind: 'secondary',
            settings: [{ namespace: 'global', key: 'airplane_mode_on', value: '1' }],
          },
        ],
      }),
    ).toThrow('Conflicting device-wide setting');
    const document = convertPolicyToV2(policy);
    document.profiles[0]!.apps.push('unknown');
    expect(() => validatePolicy(document)).toThrow('Unknown app catalog reference');
    const misplaced = convertPolicyToV2(policy);
    misplaced.profiles[0]!.settings.push({ namespace: 'global', key: 'airplane_mode_on', value: '0' });
    expect(() => validatePolicy(misplaced)).toThrow('deviceSettings');
    expect(() =>
      validatePolicy({
        ...convertPolicyToV2(policy),
        deviceSettings: [{ namespace: 'secure', key: 'screensaver_enabled', value: '0' }],
      }),
    ).toThrow('global namespace');
  });

  it('validates unused catalog entries and prevents contradictory device-wide APK versions', () => {
    const document = convertPolicyToV2(policy);
    const artifact = document.apps['org.example.vpn']!;
    expect(() =>
      validatePolicy({
        ...document,
        apps: { ...document.apps, unused: { ...artifact, repositoryId: 'missing' } },
      }),
    ).toThrow('Unknown repository');
    expect(() =>
      validatePolicy({
        ...document,
        apps: { ...document.apps, conflicting: { ...artifact, versionCode: 99 } },
      }),
    ).toThrow('Conflicting device-wide APK');
    expect(() => validatePolicy({ ...document, apps: undefined })).toThrow();
    expect(validatePolicyDocument(document)).toEqual(document);
  });
});

describe('mixed-model image pins', () => {
  it('selects and verifies the exact model pin without accepting another model release', () => {
    const document = convertPolicyToV2(policy);
    document.os = { akita: image('akita'), husky: image('husky', '2026100700') };
    const normalized = validatePolicy(document);
    expect(osPolicyForTarget(normalized, 'akita')).toEqual(document.os.akita);
    expect(osPolicyForTarget(normalized, 'husky')).toEqual(document.os.husky);
    expect(osPolicyForTarget(normalized, 'unknown')).toBeUndefined();
    expect(osPolicyForTarget(normalized, 'constructor')).toBeUndefined();
    expect(evaluateObservation(normalized, observation).passed).toBe(true);
    const husky = {
      ...observation,
      device: { ...observation.device, codename: 'husky' },
      os: { ...observation.os, codename: 'husky', release: '2026100700' },
    };
    expect(evaluateObservation(normalized, husky).passed).toBe(true);
    expect(
      evaluateObservation(normalized, { ...husky, os: { ...husky.os, release: observation.os.release } })
        .passed,
    ).toBe(false);
    const unsupported = {
      ...husky,
      device: { ...husky.device, codename: 'unknown' },
      os: { ...husky.os, codename: 'unknown' },
    };
    expect(evaluateObservation(normalized, unsupported).checks).toContainEqual({
      key: 'os.supported',
      expected: true,
      actual: false,
      passed: false,
    });
  });

  it('rejects empty or mismatched model maps and ambiguous legacy/mixed pins', () => {
    const document = convertPolicyToV2(policy);
    expect(() => validatePolicy({ ...document, os: {} })).toThrow('cannot be empty');
    expect(() => validatePolicy({ ...document, os: { akita: image('husky') } })).toThrow(
      'differs from codename',
    );
    expect(() =>
      validatePolicy({ ...policy, os: image('akita'), osByCodename: { husky: image('husky') } }),
    ).toThrow('not both');
    expect(osPolicyForTarget({ os: image('akita') }, 'husky')).toBeUndefined();
    expect(osPolicyForTarget({ os: image('akita') }, 'akita')).toEqual(image('akita'));
  });
});

it('keeps product feature gates optional and rejects unrecognized or incomplete gates', () => {
  expect(validateProduct(product)).toEqual(product);
  expect(validateProduct({ ...product, features: { extensions: false, seedvault: false } }).features).toEqual(
    { extensions: false, seedvault: false },
  );
  expect(() => validateProduct({ ...product, features: { extensions: false } })).toThrow();
  expect(() =>
    validateProduct({ ...product, features: { extensions: false, seedvault: false, extra: true } }),
  ).toThrow();
});
