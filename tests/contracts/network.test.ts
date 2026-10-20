import { expect, it } from '../test-api.js';
import {
  ipInCidrs,
  validateEgressCidr,
  validateExecutionPolicy,
  validatePolicy,
  validateAction,
  toPolicyDocument,
  validateNetworkProbe,
} from '@pxv/contracts';
import { policy, hashA, hashB } from './fixtures.js';

it.each([
  ['0.0.0.0/0', '255.255.255.255', true],
  ['192.0.2.1/32', '192.0.2.1', true],
  ['192.0.2.1/32', '192.0.2.2', false],
  ['::/0', '2001:db8::1', true],
  ['2001:db8::1/128', '2001:db8::1', true],
  ['2001:db8::/32', '2001:db9::1', false],
  ['::ffff:c000:200/120', '::ffff:192.0.2.1', true],
  ['::/0', '192.0.2.1', false],
] as const)('matches %s against %s', (cidr, address, expected) => {
  validateEgressCidr(cidr);
  expect(ipInCidrs(address, [cidr])).toBe(expected);
});

it.each([
  'bad',
  '192.0.2.0/33',
  '192.0.2.1/24',
  '::/129',
  '2001:db8::1/32',
  'fe80::%eth0/64',
  '::/-1',
  '::/01',
  '::/1/',
  '::/999999999999999999999',
  '/0',
  '::/',
])('rejects invalid CIDR %s at policy validation', (cidr) => {
  expect(() => validateEgressCidr(cidr)).toThrow();
  expect(() => validateNetworkProbe(probe(cidr))).toThrow(/CIDR/);
});
function probe(cidr = '192.0.2.0/24') {
  return {
    artifact: {
      packageId: 'org.pxv.probe',
      versionCode: 1,
      sha256: hashA,
      signerSha256: hashB,
      path: 'probe.apk',
    },
    endpoint: 'https://example.org/check?format=json&tag=a%2Bb',
    expectedEgressCidrs: [cidr],
    requireVpn: false,
    failurePackages: [],
  };
}
it('retains the exact query endpoint and validates every CIDR even after a match', () => {
  expect(validateNetworkProbe(probe()).endpoint).toBe(probe().endpoint);
  expect(() => ipInCidrs('192.0.2.1', ['192.0.2.0/24', 'invalid'])).toThrow();
  expect(() => ipInCidrs('fe80::1%eth0', ['fe80::/64'])).toThrow(/scope/);
  expect(() => ipInCidrs('not-ip', [])).toThrow(/valid IP/);
});
it.each([
  [null, false, false, true],
  [null, false, true, false],
  [null, true, false, false],
  [null, true, true, false],
  ['org.example.vpn', false, false, false],
  ['org.example.vpn', false, true, false],
  ['org.example.vpn', true, false, true],
  ['org.example.vpn', true, true, true],
] as const)(
  'agrees on VPN %s/%s/%s across authored, execution and action contracts',
  (packageId, alwaysOn, lockdown, valid) => {
    const vpn = { packageId, alwaysOn, lockdown };
    const execution = { ...policy, profiles: policy.profiles.map((profile) => ({ ...profile, vpn })) };
    const document = {
      ...toPolicyDocument(policy),
      profiles: toPolicyDocument(policy).profiles.map((profile) => ({ ...profile, vpn })),
    };
    for (const validate of [
      () => validateExecutionPolicy(execution),
      () => validatePolicy(document),
      () => validateAction({ kind: 'vpn', profileId: 'admin', vpn }),
    ]) {
      if (valid) expect(validate).not.toThrow();
      else expect(validate).toThrow(/VPN/);
    }
  },
);
