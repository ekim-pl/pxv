import { expect, it } from '../test-api.js';
import {
  validAndroidUserName,
  validAndroidSettingKey,
  validAndroidPermission,
  validAndroidSettingValue,
  validProbeEndpoint,
  validateExecutionPolicy,
  validatePolicyDocument,
  validateAction,
  validateObservation,
  toPolicyDocument,
  validateNetworkProbe,
} from '@pxv/contracts';
import { policy, observation, hashA, hashB } from './fixtures.js';

it('shares executable constraints across policies and contributed actions without narrowing observations', () => {
  const cases = [
    { field: 'name', value: 'bad:name', action: { kind: 'create-user', name: 'bad:name' } },
    { field: 'name', value: 'x'.repeat(81), action: { kind: 'create-user', name: 'x'.repeat(81) } },
    {
      field: 'settings',
      value: [{ namespace: 'secure', key: 'bad key', value: '1' }],
      action: { kind: 'setting', setting: { namespace: 'secure', key: 'bad key', value: '1' } },
    },
    {
      field: 'settings',
      value: [{ namespace: 'secure', key: 'good', value: 'a\nb' }],
      action: { kind: 'setting', setting: { namespace: 'secure', key: 'good', value: 'a\nb' } },
    },
    {
      field: 'permissions',
      value: [{ packageId: 'org.example.vpn', permission: 'custom.permission', granted: true }],
      action: {
        kind: 'permission',
        permission: { packageId: 'org.example.vpn', permission: 'custom.permission', granted: true },
      },
    },
  ];
  for (const entry of cases) {
    const execution = structuredClone(policy);
    Object.assign(execution.profiles[0]!, { [entry.field]: entry.value });
    const authored = toPolicyDocument(policy);
    Object.assign(authored.profiles[0]!, { [entry.field]: entry.value });
    expect(() => validateExecutionPolicy(execution)).toThrow('Profile admin');
    expect(() => validateExecutionPolicy(execution)).toThrow(entry.field);
    expect(() => validatePolicyDocument(authored)).toThrow('Profile admin');
    expect(() => validateAction({ ...entry.action, profileId: 'admin' })).toThrow('Profile admin');
  }
  const retained = structuredClone(observation);
  retained.profiles[0]!.user.name = 'Historical:name';
  retained.profiles[0]!.settings[0]!.key = 'historical key';
  retained.profiles[0]!.permissions[0]!.permission = 'custom.permission';
  expect(() => validateObservation(retained)).not.toThrow();
});
it('accepts executable boundary values and rejects invalid names, keys, permissions and values', () => {
  for (const name of ['A', 'x'.repeat(80), 'Właściciel 🔒']) expect(validAndroidUserName(name)).toBe(true);
  for (const name of ['', 'x'.repeat(81), ':', '}', '\n', '\u007f', '\u0085', '\u009f'])
    expect(validAndroidUserName(name)).toBe(false);
  for (const key of ['A', 'a'.repeat(128), 'a._:-1']) expect(validAndroidSettingKey(key)).toBe(true);
  for (const key of ['', 'a'.repeat(129), '_key', 'bad key']) expect(validAndroidSettingKey(key)).toBe(false);
  expect(validAndroidPermission('android.permission.CAMERA_1')).toBe(true);
  for (const permission of ['', 'custom.permission', 'android.permission.lower'])
    expect(validAndroidPermission(permission)).toBe(false);
  for (const value of ['', 'x'.repeat(4096), 'tab\tvalue'])
    expect(validAndroidSettingValue(value)).toBe(true);
  for (const value of ['x'.repeat(4097), '\0', '\r', '\n'])
    expect(validAndroidSettingValue(value)).toBe(false);
});
it('preserves exact accepted probe URLs and rejects empty user-info/fragments before normalization', () => {
  const probe = {
    artifact: {
      packageId: 'org.pxv.probe',
      versionCode: 1,
      sha256: hashA,
      signerSha256: hashB,
      path: 'probe.apk',
    },
    expectedEgressCidrs: ['0.0.0.0/0'],
    requireVpn: false,
    failurePackages: [],
  };
  for (const endpoint of [
    'https://example.org/check?tag=a%2Bb&email=a@b&fragment=%23',
    'HTTPS://example.org:443/check?a=1&a=2',
  ]) {
    expect(validProbeEndpoint(endpoint)).toBe(true);
    expect(validateNetworkProbe({ ...probe, endpoint }).endpoint).toBe(endpoint);
  }
  for (const endpoint of [
    '',
    'https://@example.org',
    'https://user:pass@example.org',
    'https://example.org/#',
    'https://example.org/#part',
    'http://example.org',
    'https:example.org',
    'https://example.org/\n',
    'https://example.org/a b',
    'https://example.org/\u0085',
    'https://example.org/\ufeff',
    'https://example.org/\\a',
    'https://example.org:bad',
    'https://example.org/' + 'x'.repeat(4096),
  ]) {
    expect(validProbeEndpoint(endpoint)).toBe(false);
    expect(() => validateNetworkProbe({ ...probe, endpoint })).toThrow(/endpoint/);
  }
});

it.each(['always_on_vpn_app', 'always_on_vpn_lockdown'])(
  'reserves secure %s for the witnessed VPN workflow at every contract boundary',
  (key) => {
    const setting = { namespace: 'secure' as const, key, value: '0' };
    const expanded = structuredClone(policy);
    expanded.profiles[0]!.settings.push(setting);
    const authored = toPolicyDocument(policy);
    authored.profiles[0]!.settings.push(setting);
    for (const validate of [
      () => validateExecutionPolicy(expanded),
      () => validatePolicyDocument(authored),
      () => validateAction({ kind: 'setting', profileId: 'admin', setting }),
    ]) {
      expect(validate).toThrow('Profile admin');
      expect(validate).toThrow('vpn block');
      expect(validate).toThrow('key');
    }
    const retained = structuredClone(observation);
    retained.profiles[0]!.settings.push(setting);
    expect(() => validateObservation(retained)).not.toThrow();
    expect(() =>
      validateAction({ kind: 'setting', profileId: 'admin', setting: { ...setting, namespace: 'system' } }),
    ).not.toThrow();
  },
);
