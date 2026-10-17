import { toPolicyDocument, validatePolicy } from '@pxv/contracts';
import type {
  DeviceObservation,
  DeviceTarget,
  ProductDescriptor,
  ProjectConfig,
  RecoveryObligation,
} from '@pxv/contracts';

export const hashA = 'a'.repeat(64);
export const hashB = 'b'.repeat(64);
export const device: DeviceTarget = {
  assetId: 'all',
  kind: 'pixel',
  canonicalSerial: 'PIXEL1',
  model: 'Pixel 8a',
  codename: 'akita',
  transports: [
    { kind: 'usb', serial: 'PIXEL1' },
    { kind: 'wifi', serial: '192.0.2.10:5555' },
  ],
  groups: ['pilot'],
};
export const policy = validatePolicy({
  id: 'fixture',
  name: 'Fixture policy',
  capabilities: ['normal_credentials', 'duress'],
  repositories: [],
  apps: {
    'org.example.vpn': {
      packageId: 'org.example.vpn',
      versionCode: 12,
      sha256: hashA,
      signerSha256: hashB,
      path: '/tmp/vpn.apk',
    },
  },
  deviceSettings: [],
  profiles: [
    {
      id: 'admin',
      name: 'Administrator',
      kind: 'owner',
      apps: ['org.example.vpn'],
      settings: [{ namespace: 'secure', key: 'screensaver_enabled', value: '0' }],
      permissions: [
        { packageId: 'org.example.vpn', permission: 'android.permission.POST_NOTIFICATIONS', granted: true },
      ],
      vpn: { packageId: 'org.example.vpn', alwaysOn: true, lockdown: true },
      language: 'pl-PL',
    },
  ],
});
export const policyDocument = toPolicyDocument(policy);
export const observation: DeviceObservation = {
  schemaVersion: 1,
  device,
  observedAt: '2026-10-16T09:00:00Z',
  os: { codename: 'akita', release: '2026100600', bootVerified: true },
  profiles: [
    {
      profileId: 'admin',
      user: { userId: 0, serialNo: 0, name: 'Administrator' },
      packages: [{ packageId: 'org.example.vpn', versionCode: 12, signerSha256: hashB }],
      settings: [{ namespace: 'secure', key: 'screensaver_enabled', value: '0' }],
      permissions: [
        { packageId: 'org.example.vpn', permission: 'android.permission.POST_NOTIFICATIONS', granted: true },
      ],
      vpn: { packageId: 'org.example.vpn', alwaysOn: true, lockdown: true },
      language: 'pl-PL',
    },
  ],
  helpers: [],
  debuggingEnabled: true,
};
export const project: ProjectConfig = {
  schemaVersion: 1,
  format: 'pxv-ts',
  id: 'pilot',
  productId: 'pxv',
  policyFile: 'policy.json',
  inventoryFile: 'inventory.json',
  extensions: [],
};
export const product: ProductDescriptor = {
  schemaVersion: 1,
  id: 'pxv',
  name: 'pxv Community',
  command: 'pxv',
  packageName: '@pxv/cli',
  debName: 'pxv',
  image: 'pxv/community',
  upstreamVersion: '0.1.0',
  engineApi: 1,
  assets: { logo: 'assets/logo.svg' },
  defaultPolicy: 'policy-packs/reference-five/policy.json',
  support: { name: 'Community', email: 'support@example.org', url: 'https://example.org/pxv' },
};
export const obligation: RecoveryObligation = {
  schemaVersion: 1,
  id: 'obligation-1',
  operationId: 'parent',
  ownerOperationId: 'parent',
  deviceSerial: 'PIXEL1',
  user: { userId: 10, serialNo: 17, name: 'contacts' },
  kind: 'setting',
  resource: 'keep-awake',
  payload: { original: '0' },
  status: 'pending',
};
