import {
  validatePolicy,
  validatePolicyDocument,
  validatePolicySourceDocument,
  type PolicySourceDocument,
} from '@pxv/contracts';
import { expect, it } from '../test-api.js';
import { hashA, hashB, policyDocument } from './fixtures.js';

const draft = (): PolicySourceDocument => {
  const document: PolicySourceDocument = structuredClone(policyDocument);
  document.apps['org.example.vpn'] = { packageId: 'org.example.vpn', source: { kind: 'fdroid' } };
  return document;
};
it('accepts source-only authoring while keeping executable and normal authored validation strict', () => {
  const document = draft();
  expect(validatePolicySourceDocument(document).apps).toEqual(document.apps);
  expect(() => validatePolicyDocument(document)).toThrow();
  expect(() => validatePolicy(document)).toThrow();
});
for (const key of ['versionCode', 'sha256', 'signerSha256'] as const)
  it(`allows the ${key} pin independently`, () => {
    const document = draft();
    if (key === 'versionCode') document.apps['org.example.vpn']!.versionCode = 12;
    else document.apps['org.example.vpn']![key] = hashA;
    expect(validatePolicySourceDocument(document).apps).toEqual(document.apps);
  });
for (const app of [
  { packageId: 'org.example.vpn' },
  { packageId: 'org.example.vpn', source: { kind: 'fdroid' }, url: 'https://example.com/app.apk' },
  { packageId: 'org.example.vpn', source: { kind: 'fdroid-repository', url: 'https://example.com/repo' } },
  { packageId: 'org.example.vpn', source: { kind: 'direct', url: 'http://example.com/app.apk' } },
  { packageId: 'org.example.vpn', source: { kind: 'fdroid' }, versionCode: 0 },
  { packageId: 'org.example.vpn', source: { kind: 'fdroid' }, sha256: 'wrong' },
  { packageId: 'org.example.vpn', source: { kind: 'fdroid' }, unexpected: true },
  { packageId: 'org.example.vpn', url: 'https://example.com/a.apk', path: 'a.apk' },
])
  it(`rejects invalid source declarations ${JSON.stringify(app)}`, () => {
    expect(() => validatePolicySourceDocument({ ...draft(), apps: { 'org.example.vpn': app } })).toThrow();
  });
it('checks catalog references, repository references, profile invariants and known conflicting pins before acquisition', () => {
  const document = draft();
  document.profiles[0]!.apps.push('missing');
  expect(() => validatePolicySourceDocument(document)).toThrow('Unknown app catalog reference');
  document.profiles[0]!.apps.pop();
  document.apps['unused'] = { packageId: 'org.example.unused', repositoryId: 'missing' };
  expect(() => validatePolicySourceDocument(document)).toThrow('Unknown repository');
  delete document.apps['unused'];
  document.apps['org.example.vpn']!.signerSha256 = hashA;
  document.apps['duplicate'] = {
    packageId: 'org.example.vpn',
    signerSha256: hashB,
    source: { kind: 'fdroidcl' },
  };
  expect(() => validatePolicySourceDocument(document)).toThrow('Conflicting device-wide APK');
  delete document.apps['duplicate'];
  document.profiles[0]!.kind = 'secondary';
  expect(() => validatePolicySourceDocument(document)).toThrow('Exactly one owner');
});
it('defers missing recipe pins but rejects known recipe conflicts and undeclared packages', () => {
  const document = draft();
  const recipe = {
    schemaVersion: 1 as const,
    id: 'setup',
    packageId: 'org.example.vpn',
    versionCode: 12,
    signerSha256: hashB,
    buildFingerprint: 'fingerprint',
    steps: [{ action: 'tap' as const, selector: { resourceId: 'org.example.vpn:id/start' } }],
    postconditions: [{ resourceId: 'org.example.vpn:id/done' }],
  };
  document.profiles[0]!.recipes = [recipe];
  expect(validatePolicySourceDocument(document)).toBeDefined();
  document.apps['org.example.vpn']!.versionCode = 13;
  expect(() => validatePolicySourceDocument(document)).toThrow('Recipe app identity');
  delete document.apps['org.example.vpn']!.versionCode;
  recipe.packageId = 'org.example.other';
  expect(() => validatePolicySourceDocument(document)).toThrow('Recipe app identity');
});
