import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  toPolicyDocument,
  digest,
  evaluateObservation,
  osPolicyForTarget,
  resolvePolicy,
  validatePolicy,
  validateExecutionPolicy,
  validatePolicyDocument,
  validateProduct,
  verifyResolvedPolicy,
  type OsPolicy,
  type ExecutionPolicy,
  type PolicyDocument,
} from '@pxv/contracts';
import { observation, policy, policyDocument, product, project } from './fixtures.js';

const image = (codename: string, release = '2026100600'): OsPolicy => ({
  codename,
  release,
  url: `https://releases.grapheneos.org/${codename}-install-${release}.zip`,
  signatureUrl: `https://releases.grapheneos.org/${codename}-install-${release}.zip.sig`,
  signerPrincipal: 'contact@grapheneos.org',
  namespace: 'factory images',
  publicKey: 'ssh-ed25519 AAAA',
});

describe('policy authoring and locks', () => {
  it('separates authored input from expanded engine data', () => {
    expectTypeOf(validatePolicy).returns.toEqualTypeOf<ExecutionPolicy>();
    expectTypeOf(toPolicyDocument).returns.toEqualTypeOf<PolicyDocument>();
    const execution: ExecutionPolicy = validatePolicy(policyDocument);
    expect(toPolicyDocument(execution)).toEqual(policyDocument);
  });
  it('defines a shared app once and normalizes device settings onto the owner exactly once', () => {
    const original = structuredClone(policy);
    const owner = original.profiles[0]!;
    const global = { namespace: 'global' as const, key: 'airplane_mode_on', value: '0' };
    owner.settings.push(global);
    original.profiles.push({ ...structuredClone(owner), id: 'work', name: 'Work', kind: 'secondary' });
    const document = toPolicyDocument(original);
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
    expect(normalized).not.toHaveProperty('schemaVersion');
    expect(normalized).not.toHaveProperty('version');
  });

  it('rejects unknown fields in authored input, execution data and retained policies', () => {
    const invalid = { ...policy, unexpected: true };
    expect(() => validateExecutionPolicy(invalid)).toThrow();
    expect(() => validatePolicy({ ...policyDocument, unexpected: true })).toThrow();
    expect(() => validatePolicyDocument({ ...policyDocument, unexpected: true })).toThrow();
    const retained = resolvePolicy(policy, project, product);
    expect(() => verifyResolvedPolicy({ ...retained, policy: invalid })).toThrow();
    expect(() => evaluateObservation(invalid as typeof policy, observation)).toThrow();
    expect(() => resolvePolicy(invalid as typeof policy, project, product)).toThrow();
    expect(() => toPolicyDocument(invalid as typeof policy)).toThrow();
  });

  it('roundtrips authored policies and locks without policy version fields', () => {
    expect(validatePolicy(policyDocument)).toEqual(policy);
    expect(validateExecutionPolicy(policy)).toEqual(policy);
    expect(toPolicyDocument(policy)).toEqual(policyDocument);
    expect(() => validatePolicy(policy)).toThrow();
    expect(() => validatePolicyDocument(policy)).toThrow();
    expect(() => validateExecutionPolicy(policyDocument)).toThrow();
    const retained = resolvePolicy(policy, project, product);
    expect(verifyResolvedPolicy(JSON.parse(JSON.stringify(retained)))).toEqual(retained);
    expect(digest(validatePolicy(toPolicyDocument(policy)))).toBe(digest(policy));
    expect(retained.schemaVersion).toBe(1);
    expect(retained.policy).not.toHaveProperty('schemaVersion');
    expect(retained.policy).not.toHaveProperty('version');
  });

  it.each([
    { path: 'apks/alternate.apk' },
    { url: 'https://downloads.example.org/vpn.apk', redirectHosts: ['cdn.example.org'] },
    { repositoryId: 'trusted' },
  ])('preserves distinct artifact sources through authored roundtrips: %j', (source) => {
    const document = structuredClone(policyDocument);
    const artifact = document.apps['org.example.vpn']!;
    const { packageId, versionCode, sha256, signerSha256 } = artifact;
    document.repositories = [
      {
        id: 'trusted',
        url: 'https://repository.example.org',
        signerSha256,
        maxAgeDays: 7,
        redirectHosts: [],
      },
    ];
    document.apps = {
      original: artifact,
      alternate: { packageId, versionCode, sha256, signerSha256, ...source },
      duplicate: { ...artifact },
    };
    const owner = document.profiles[0]!;
    document.profiles = [
      { ...owner, apps: ['original'] },
      { ...owner, id: 'work', name: 'Work', kind: 'secondary', apps: ['alternate'] },
      { ...owner, id: 'shared', name: 'Shared', kind: 'secondary', apps: ['duplicate'] },
    ];
    const normalized = validatePolicy(document);
    const serialized = toPolicyDocument(normalized);
    expect(Object.keys(serialized.apps)).toHaveLength(2);
    expect(serialized.profiles[0]!.apps).toEqual(serialized.profiles[2]!.apps);
    expect(serialized.profiles[0]!.apps).not.toEqual(serialized.profiles[1]!.apps);
    const reloaded = validatePolicy(serialized);
    expect(reloaded).toEqual(normalized);
    expect(digest(reloaded)).toBe(digest(normalized));
  });

  it('preserves distinct case-sensitive Android package IDs when catalog names would collide', () => {
    const original = structuredClone(policy);
    const owner = original.profiles[0]!;
    owner.packages.push({ ...owner.packages[0]!, packageId: 'org.example.VPN', sha256: 'b'.repeat(64) });
    const document = toPolicyDocument(original);
    const references = document.profiles[0]!.apps;
    expect(new Set(references).size).toBe(2);
    expect(references.map((reference) => document.apps[reference]?.packageId)).toEqual([
      'org.example.vpn',
      'org.example.VPN',
    ]);
    expect(validatePolicy(document).profiles[0]!.packages).toEqual(owner.packages);
  });

  it('serializes mixed-model policies without losing model pins or app references', () => {
    const document = toPolicyDocument(policy);
    document.os = { akita: image('akita'), husky: image('husky', '2026100700') };
    const original = structuredClone(document);
    expect(toPolicyDocument(validatePolicy(document))).toEqual(original);
    expect(document).toEqual(original);
  });

  it('rejects conflicting normalized globals, unknown app references and misplaced globals', () => {
    const owner = structuredClone(policy.profiles[0]!);
    owner.settings.push({ namespace: 'global', key: 'airplane_mode_on', value: '0' });
    expect(() =>
      validateExecutionPolicy({
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
    const document = toPolicyDocument(policy);
    document.profiles[0]!.apps.push('unknown');
    expect(() => validatePolicy(document)).toThrow('Unknown app catalog reference');
    const misplaced = toPolicyDocument(policy);
    misplaced.profiles[0]!.settings.push({ namespace: 'global', key: 'airplane_mode_on', value: '0' });
    expect(() => validatePolicy(misplaced)).toThrow('deviceSettings');
    expect(() =>
      validatePolicy({
        ...toPolicyDocument(policy),
        deviceSettings: [{ namespace: 'secure', key: 'screensaver_enabled', value: '0' }],
      }),
    ).toThrow('global namespace');
  });

  it('validates unused catalog entries and prevents contradictory device-wide APK versions', () => {
    const document = toPolicyDocument(policy);
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
    const document = toPolicyDocument(policy);
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

  it('rejects empty or mismatched model maps and non-map image pins', () => {
    const document = toPolicyDocument(policy);
    expect(() => validatePolicy({ ...document, os: {} })).toThrow('cannot be empty');
    expect(() => validatePolicy({ ...document, os: { akita: image('husky') } })).toThrow(
      'differs from codename',
    );
    expect(() => validatePolicy({ ...document, os: image('akita') })).toThrow();
    expect(() => validateExecutionPolicy({ ...policy, os: image('akita') })).toThrow();
    expect(osPolicyForTarget({}, 'akita')).toBeUndefined();
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
