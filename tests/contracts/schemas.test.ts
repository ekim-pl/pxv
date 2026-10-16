import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  parseDocument,
  validateAction,
  validateArtifact,
  validateAttestation,
  validateExtension,
  validateHandoff,
  validateInventory,
  validateObligation,
  validateObservation,
  validatePlan,
  validatePolicy,
  validateProduct,
  validateProject,
  validateRunEvent,
  validateUserIdentity,
  validateRecipe,
  validateNetworkProbe,
  validateSharedEffect,
  requiredAttestations,
  evaluateObservation,
} from '@pxv/contracts';
import { device, hashA, hashB, observation, obligation, policy, product, project } from './fixtures.js';

describe('strict configuration parser', () => {
  it('reads JSON and YAML documents', () => {
    expect(parseDocument('{"a": [1,true,null]}')).toEqual({ a: [1, true, null] });
    expect(parseDocument('name: pxv\nprofiles:\n  - owner\n')).toEqual({ name: 'pxv', profiles: ['owner'] });
  });

  it.each([
    '{"a": 1, "a": 2}',
    'a: 1\na: 2\n',
    'a: [unterminated',
    'a: 1\n---\nb: 2',
    'a: &x {value: 1}\nb: *x',
    'a: !unknown value',
    '? [1,2]\n: value',
  ])('rejects ambiguous or unsupported syntax: %s', (text) => {
    expect(() => parseDocument(text)).toThrow();
  });

  it('does not coerce string booleans/numbers and rejects explicit undefined', () => {
    const changed = structuredClone(policy);
    const profile = changed.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    expect(() => validatePolicy({ ...changed, schemaVersion: '1' })).toThrow();
    expect(() =>
      validatePolicy({ ...changed, profiles: [{ ...profile, vpn: { ...profile.vpn, lockdown: 'true' } }] }),
    ).toThrow();
    expect(() => validatePolicy({ ...changed, os: undefined })).toThrow('undefined');
  });
});

describe('policy validation', () => {
  it('rejects unknown fields at every important boundary', () => {
    expect(() => validatePolicy({ ...policy, inheritedEnvironment: { TOKEN: 'sentinel' } })).toThrow();
    expect(() => validateProject({ ...project, pythonState: 'state.json' })).toThrow();
    expect(() => validateProduct({ ...product, activationServer: 'https://example.org' })).toThrow();
    expect(() => validateObservation({ ...observation, proof: true })).toThrow();
  });

  it('normalizes SHA-256 text and requires actual artifact source/trust pins', () => {
    expect(
      validateArtifact({
        packageId: 'org.example.app',
        versionCode: 1,
        sha256: hashA.toUpperCase(),
        signerSha256: hashB.toUpperCase(),
        path: '/tmp/app.apk',
      }).sha256,
    ).toBe(hashA);
    expect(() =>
      validateArtifact({ packageId: 'org.example.app', versionCode: 1, sha256: hashA, signerSha256: hashB }),
    ).toThrow('requires a path');
    expect(() =>
      validateArtifact({
        packageId: 'app',
        versionCode: 1,
        sha256: 'bad',
        signerSha256: hashB,
        url: 'http://example.org/app.apk',
      }),
    ).toThrow();
  });

  it('requires exactly one owner, unique profiles and unique user names', () => {
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    expect(() => validatePolicy({ ...policy, profiles: [] })).toThrow();
    expect(() => validatePolicy({ ...policy, profiles: [{ ...profile, kind: 'secondary' }] })).toThrow(
      'owner',
    );
    expect(() =>
      validatePolicy({ ...policy, profiles: [profile, { ...profile, kind: 'secondary' }] }),
    ).toThrow('Duplicate profile');
    expect(() =>
      validatePolicy({ ...policy, profiles: [profile, { ...profile, id: 'second', kind: 'secondary' }] }),
    ).toThrow('Duplicate Android');
    expect(() =>
      validatePolicy({ ...policy, profiles: [profile, { ...profile, id: 'second', name: 'Second' }] }),
    ).toThrow('owner');
  });

  it('rejects duplicate app, settings, permissions and unresolved package references', () => {
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    const withProfile = (changes: Record<string, unknown>): unknown => ({
      ...policy,
      profiles: [{ ...profile, ...changes }],
    });
    expect(() =>
      validatePolicy(withProfile({ packages: [...profile.packages, ...profile.packages] })),
    ).toThrow('Duplicate profile package');
    expect(() =>
      validatePolicy(withProfile({ settings: [...profile.settings, ...profile.settings] })),
    ).toThrow('Duplicate profile setting');
    expect(() =>
      validatePolicy(withProfile({ permissions: [...profile.permissions, ...profile.permissions] })),
    ).toThrow('Duplicate profile permission');
    expect(() =>
      validatePolicy(
        withProfile({
          permissions: [
            { packageId: 'org.example.unknown', permission: 'android.permission.CAMERA', granted: true },
          ],
        }),
      ),
    ).toThrow('undeclared package');
    expect(() => validatePolicy(withProfile({ packages: [] }))).toThrow('undeclared package');
    expect(() =>
      validatePolicy(
        withProfile({ vpn: { packageId: 'org.example.unknown', alwaysOn: true, lockdown: true } }),
      ),
    ).toThrow('undeclared package');
  });

  it('rejects impossible VPN enforcement', () => {
    const profile = policy.profiles[0];
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...profile, vpn: { packageId: null, alwaysOn: true, lockdown: true } }],
      }),
    ).toThrow('requires a package');
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...profile, vpn: { packageId: 'org.example.vpn', alwaysOn: false, lockdown: true } }],
      }),
    ).toThrow('requires always-on');
  });

  it('accepts credential references and rejects literal values and unsafe reference names', () => {
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const credential = { type: 'pin', secretRef: 'owner-pin' };
    const duress = {
      ownerCredentialRef: 'owner-pin',
      pinRef: 'duress-pin',
      passwordRef: 'duress-password',
    };
    const configured = {
      ...policy,
      profiles: [{ ...owner, defaultCredential: credential, defaultDuress: duress }],
    };
    expect(validatePolicy(configured).profiles[0]?.defaultDuress).toEqual(duress);
    for (const defaultCredential of [
      { ...credential, type: 'pattern' },
      { ...credential, secretRef: '../owner-pin' },
      { ...credential, secretRef: 'OwnerPin' },
      { ...credential, value: '123456' },
    ])
      expect(() => validatePolicy({ ...policy, profiles: [{ ...owner, defaultCredential }] })).toThrow();
    expect(() =>
      validateAction({
        kind: 'default-credential',
        profileId: owner.id,
        credential: { ...credential, pin: '123456' },
      }),
    ).toThrow();
    expect(() =>
      validateAction({
        kind: 'default-duress',
        profileId: owner.id,
        duress: { ...duress, password: 'private-value' },
      }),
    ).toThrow();
  });

  it('limits default duress to the owner and accepts a separate current owner credential reference', () => {
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const duress = { ownerCredentialRef: 'owner-pin', pinRef: 'duress-pin', passwordRef: 'duress-password' };
    const secondary = { ...owner, id: 'work', name: 'Work', kind: 'secondary' };
    expect(() =>
      validatePolicy({ ...policy, profiles: [owner, { ...secondary, defaultDuress: duress }] }),
    ).toThrow('owner profile');
    expect(
      validatePolicy({
        ...policy,
        profiles: [
          {
            ...owner,
            defaultCredential: { type: 'password', secretRef: 'owner-password' },
            defaultDuress: duress,
          },
        ],
      }).profiles[0]?.defaultDuress,
    ).toEqual(duress);
    expect(
      validatePolicy({ ...policy, profiles: [{ ...owner, defaultDuress: duress }] }).profiles[0]
        ?.defaultDuress,
    ).toEqual(duress);
  });

  it('rejects duress references shared with any normal profile credential', () => {
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const duress = {
      ownerCredentialRef: 'owner-current',
      pinRef: 'duress-pin',
      passwordRef: 'duress-password',
    };
    const secondary = {
      ...owner,
      id: 'work',
      name: 'Work',
      kind: 'secondary',
      defaultCredential: { type: 'pin', secretRef: 'work-pin' },
    };
    for (const normalRef of ['owner-pin', 'owner-current', 'work-pin'])
      for (const field of ['pinRef', 'passwordRef'])
        expect(() =>
          validatePolicy({
            ...policy,
            profiles: [
              {
                ...owner,
                defaultCredential: { type: 'pin', secretRef: 'owner-pin' },
                defaultDuress: { ...duress, [field]: normalRef },
              },
              secondary,
            ],
          }),
        ).toThrow('differ from normal credentials');
  });

  it('rejects unknown/duplicate repositories and inconsistent device-wide APK versions', () => {
    const profile = policy.profiles[0];
    const artifact = profile?.packages[0];
    if (!profile || !artifact) throw new Error('Fixture artifact missing');
    const repository = {
      id: 'trusted',
      url: 'https://example.org/repo',
      signerSha256: hashA,
      maxAgeDays: 7,
      redirectHosts: ['cdn.example.org'],
    };
    expect(validatePolicy({ ...policy, repositories: [repository] }).repositories).toHaveLength(1);
    expect(() => validatePolicy({ ...policy, repositories: [repository, repository] })).toThrow(
      'Duplicate repository',
    );
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...profile, packages: [{ ...artifact, repositoryId: 'missing' }] }],
      }),
    ).toThrow('Unknown repository');
    const secondary = {
      ...profile,
      id: 'work',
      name: 'Work',
      kind: 'secondary',
      packages: [{ ...artifact, versionCode: 13 }],
    };
    expect(() => validatePolicy({ ...policy, profiles: [profile, secondary] })).toThrow(
      'Conflicting device-wide APK',
    );
    expect(
      validatePolicy({ ...policy, profiles: [profile, { ...secondary, packages: [artifact] }] }).profiles,
    ).toHaveLength(2);
    expect(() =>
      validatePolicy({
        ...policy,
        repositories: [{ ...repository, url: 'https://user:password@example.org' }],
      }),
    ).toThrow('HTTPS URL');
    expect(() =>
      validatePolicy({
        ...policy,
        repositories: [{ ...repository, url: 'https://example.org/repo#fragment' }],
      }),
    ).toThrow('HTTPS URL');
  });
});

describe('physical identity and observations', () => {
  it('rejects ambiguous inventory identities', () => {
    expect(validateInventory({ schemaVersion: 1, devices: [] }).devices).toEqual([]);
    expect(() => validateInventory({ schemaVersion: 1, devices: [device, device] })).toThrow(
      'Duplicate asset',
    );
    expect(() =>
      validateInventory({ schemaVersion: 1, devices: [device, { ...device, assetId: 'second' }] }),
    ).toThrow('physical device identity');
    expect(() =>
      validateInventory({
        schemaVersion: 1,
        devices: [device, { ...device, assetId: 'second', canonicalSerial: 'SECOND' }],
      }),
    ).toThrow('transport cannot identify');
    expect(() =>
      validateInventory({
        schemaVersion: 1,
        devices: [{ ...device, transports: [...device.transports, ...device.transports] }],
      }),
    ).toThrow('Duplicate transport');
    expect(() =>
      validateInventory({
        schemaVersion: 1,
        devices: [{ ...device, transports: [{ kind: 'emulator', serial: 'emulator-5554' }] }],
      }),
    ).toThrow('Physical devices');
    expect(() => validateInventory({ schemaVersion: 1, devices: [{ ...device, kind: 'emulator' }] })).toThrow(
      'Emulators require',
    );
  });

  it('requires safe numeric user identifiers and unique measured identities', () => {
    expect(validateUserIdentity({ userId: 10, serialNo: 17, name: 'Work' }).serialNo).toBe(17);
    expect(() => validateUserIdentity({ userId: -1, serialNo: 17, name: 'Work' })).toThrow();
    expect(() => validateUserIdentity({ userId: 10, serialNo: 1.1, name: 'Work' })).toThrow();
    const profile = observation.profiles[0];
    if (!profile) throw new Error('Fixture observation missing');
    expect(() => validateObservation({ ...observation, profiles: [profile, profile] })).toThrow(
      'Duplicate observed profile',
    );
    expect(() =>
      validateObservation({ ...observation, profiles: [profile, { ...profile, profileId: 'other' }] }),
    ).toThrow('share a user ID');
    expect(() =>
      validateObservation({
        ...observation,
        profiles: [profile, { ...profile, profileId: 'other', user: { ...profile.user, userId: 10 } }],
      }),
    ).toThrow('share a user serial');
  });

  it('rejects duplicate measurement keys rather than selecting one arbitrarily', () => {
    const profile = observation.profiles[0];
    if (!profile) throw new Error('Fixture observation missing');
    for (const key of ['packages', 'settings', 'permissions'] as const) {
      expect(() =>
        validateObservation({
          ...observation,
          profiles: [{ ...profile, [key]: [...profile[key], ...profile[key]] }],
        }),
      ).toThrow('Duplicate observed');
    }
  });
});

describe('public workflow contracts', () => {
  const at = '2026-10-16T09:00:00Z';
  it('validates every typed action and a reviewed plan', () => {
    const profile = policy.profiles[0];
    const artifact = profile?.packages[0];
    if (!profile || !artifact) throw new Error('Fixture policy missing');
    const actions = [
      { kind: 'create-user', profileId: 'work', name: 'Work' },
      { kind: 'install-apk', profileId: 'admin', artifact },
      { kind: 'setting', profileId: 'admin', setting: profile.settings[0] },
      { kind: 'permission', profileId: 'admin', permission: profile.permissions[0] },
      { kind: 'vpn', profileId: 'admin', vpn: profile.vpn },
      { kind: 'language', profileId: 'admin', language: 'pl-PL' },
      {
        kind: 'default-credential',
        profileId: 'admin',
        credential: { type: 'password', secretRef: 'owner-password' },
      },
      {
        kind: 'default-duress',
        profileId: 'admin',
        duress: {
          ownerCredentialRef: 'owner-password',
          pinRef: 'duress-pin',
          passwordRef: 'duress-password',
        },
      },
      {
        kind: 'manual',
        capability: 'normal_credentials',
        instructions: 'Recipient privately enters normal credentials.',
      },
      {
        kind: 'install-os',
        os: {
          codename: 'akita',
          release: '2026100600',
          url: 'https://example.org/image.zip',
          signatureUrl: 'https://example.org/image.zip.sig',
          signerPrincipal: 'release@example.org',
          namespace: 'factory images',
          publicKey: 'ssh-ed25519 AAAA',
        },
      },
    ];
    for (const action of actions) expect(validateAction(action).kind).toBe(action.kind);
    expect(
      validatePlan({
        schemaVersion: 1,
        id: 'plan-1',
        projectId: 'pilot',
        device,
        policyDigest: hashA,
        createdAt: at,
        actions,
        digest: hashB,
      }).actions,
    ).toHaveLength(10);
    expect(() => validateAction({ kind: 'shell', command: 'wipe' })).toThrow();
  });

  it('validates evidence, durable obligations and run events without inherited execution inputs (regression 4)', () => {
    const attestation = {
      schemaVersion: 1,
      id: 'receipt',
      planDigest: hashA,
      observationDigest: hashB,
      check: 'operator_signoff',
      operator: 'Alice',
      recordedAt: at,
      profileIds: ['admin'],
    };
    expect(validateAttestation(attestation).check).toBe('operator_signoff');
    expect(validateAttestation({ ...attestation, note: 'Observed on bench.' }).note).toBe(
      'Observed on bench.',
    );
    expect(validateObligation(obligation)).toEqual(obligation);
    expect(() =>
      validateObligation({ ...obligation, inheritedEnvironment: { TOKEN: 'do-not-retain' } }),
    ).toThrow();
    expect(
      validateRunEvent({
        schemaVersion: 1,
        id: 'event-1',
        runId: 'run-1',
        sequence: 0,
        at,
        type: 'intent',
        data: { action: 'setting' },
      }).sequence,
    ).toBe(0);
    expect(canonicalJson(validateObligation(obligation))).not.toContain('inheritedEnvironment');
  });

  it('requires paired recipient acceptance for completed custody', () => {
    const handoff = {
      schemaVersion: 1,
      id: 'handoff',
      projectId: 'pilot',
      deviceSerial: 'PIXEL1',
      policyDigest: hashA,
      observationDigest: hashB,
      locale: 'pl',
      outcome: 'ready-for-handoff',
      operator: 'Alice',
      createdAt: at,
    };
    expect(validateHandoff(handoff).locale).toBe('pl');
    expect(() => validateHandoff({ ...handoff, outcome: 'completed-custody' })).toThrow('requires recipient');
    expect(() => validateHandoff({ ...handoff, acceptedBy: 'Recipient' })).toThrow('recorded together');
    expect(
      validateHandoff({ ...handoff, outcome: 'completed-custody', acceptedBy: 'Recipient', acceptedAt: at })
        .outcome,
    ).toBe('completed-custody');
  });

  it('requires exact extension versions, pinned integrity and contained compiled entries', () => {
    const extension = {
      id: '@private/test',
      version: '0.1.0',
      integrity: `sha512-${'A'.repeat(86)}==`,
      apiVersion: 1,
      entry: 'dist/index.mjs',
      installPath: 'extensions/test',
    };
    expect(validateExtension(extension).version).toBe('0.1.0');
    for (const entry of ['../escape.js', '/absolute.js', 'dist\\escape.js', './index.js', 'index.ts'])
      expect(() => validateExtension({ ...extension, entry })).toThrow();
    expect(() => validateExtension({ ...extension, version: '^0.1.0' })).toThrow('exact semantic');
    expect(() => validateExtension({ ...extension, integrity: 'sha256-unpinned' })).toThrow('SHA-512');
    expect(() => validateProject({ ...project, extensions: [extension, extension] })).toThrow(
      'Duplicate extension',
    );
    expect(() => validateProject({ ...project, policyFile: '../legacy/manifest.json' })).toThrow(
      'contained relative',
    );
  });
});

describe('inline recipes, private inputs and scoped probes', () => {
  const recipe = {
    schemaVersion: 1,
    id: 'vpn-setup',
    packageId: 'org.example.vpn',
    versionCode: 12,
    signerSha256: hashB,
    buildFingerprint: 'test/akita/build',
    steps: [
      { action: 'tap', selector: { resourceId: 'org.example.vpn:id/open' }, timeoutMs: 1000 },
      { action: 'wait', selector: { description: 'Ready' } },
      { action: 'toggle', selector: { text: 'Enabled' }, value: true },
      { action: 'text', selector: { resourceId: 'org.example.vpn:id/dns' }, value: 'dns.example.org' },
      { action: 'back' },
      { action: 'stage-file', file: 'vpn_config' },
      { action: 'select-staged-file', file: 'vpn_config' },
    ],
    postconditions: [{ resourceId: 'org.example.vpn:id/enabled', checked: true }],
  };
  const probe = {
    artifact: {
      packageId: 'org.pxv.probe',
      versionCode: 1,
      sha256: hashA,
      signerSha256: hashB,
      path: 'helper.apk',
    },
    endpoint: 'https://example.org/check',
    expectedEgressCidrs: ['192.0.2.0/24'],
    requireVpn: true,
    failurePackages: ['org.example.vpn'],
  };

  it('binds exact app/build recipes and enforces bounded non-secret steps before any UI automation', () => {
    expect(validateRecipe(recipe).steps).toHaveLength(7);
    for (const steps of [
      [{ action: 'text', selector: { text: 'password' }, value: 'secret' }],
      [{ action: 'text', selector: { resourceId: 'org.example.vpn:id/value' }, value: 'unsafe value;cmd' }],
      [{ action: 'tap', selector: {} }],
      [{ action: 'wait', selector: { text: 'Ready' }, timeoutMs: 180_001 }],
      [{ action: 'stage-file', file: '../secrets' }],
    ])
      expect(() => validateRecipe({ ...recipe, steps })).toThrow();
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    expect(
      validatePolicy({ ...policy, profiles: [{ ...profile, recipes: [recipe] }] }).profiles[0]?.recipes,
    ).toHaveLength(1);
    expect(() =>
      validatePolicy({ ...policy, profiles: [{ ...profile, recipes: [{ ...recipe, versionCode: 99 }] }] }),
    ).toThrow('app identity');
    expect(() =>
      validatePolicy({ ...policy, profiles: [{ ...profile, recipes: [recipe, recipe] }] }),
    ).toThrow('Duplicate recipe');
    expect(validateAction({ kind: 'recipe', profileId: 'admin', recipe }).kind).toBe('recipe');
  });

  it('accepts only a pinned helper and declared failure exercises under enforced lockdown', () => {
    expect(validateNetworkProbe(probe).artifact.packageId).toBe('org.pxv.probe');
    expect(() =>
      validateNetworkProbe({ ...probe, artifact: { ...probe.artifact, packageId: 'org.example.arbitrary' } }),
    ).toThrow('probe helper');
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    const configured = validatePolicy({
      ...policy,
      profiles: [
        {
          ...profile,
          recipes: [recipe],
          networkProbe: probe,
          backup: { enabled: true, transportPackage: 'org.example.backup' },
        },
      ],
    });
    expect(requiredAttestations(configured)).toEqual(
      expect.arrayContaining(['app_setup', 'routes', 'network_failure_tests', 'backup_recovery']),
    );
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...profile, networkProbe: { ...probe, failurePackages: ['org.example.missing'] } }],
      }),
    ).toThrow('not declared');
    expect(() =>
      validatePolicy({
        ...policy,
        profiles: [{ ...profile, networkProbe: { ...probe, requireVpn: false } }],
      }),
    ).toThrow('enforced VPN lockdown');
    expect(validateAction({ kind: 'network-probe', profileId: 'admin', probe }).kind).toBe('network-probe');
    expect(evaluateObservation(configured, observation).passed).toBe(false);
    const measured = structuredClone(observation);
    const measuredProfile = measured.profiles[0];
    if (!measuredProfile) throw new Error('Fixture measured profile missing');
    measuredProfile.backup = { enabled: true, transportPackage: 'org.example.backup' };
    expect(evaluateObservation(configured, measured).passed).toBe(true);
  });

  it('contains private file references under secrets and prevents cross-device key/template sharing', () => {
    const enrolled = { ...device, inputs: { vpn_config: { path: 'secrets/all-vpn.conf', sha256: hashA } } };
    expect(
      validateInventory({ schemaVersion: 1, devices: [enrolled] }).devices[0]?.inputs?.['vpn_config']?.path,
    ).toBe('secrets/all-vpn.conf');
    for (const path of ['config/public.conf', 'secrets/../escape', '/tmp/private.conf'])
      expect(() =>
        validateInventory({
          schemaVersion: 1,
          devices: [{ ...enrolled, inputs: { vpn_config: { path, sha256: hashA } } }],
        }),
      ).toThrow();
    const second = {
      ...device,
      assetId: 'second',
      canonicalSerial: 'SECOND',
      transports: [{ kind: 'usb', serial: 'SECOND' }],
      inputs: { vpn_config: { path: 'secrets/second.conf', sha256: hashA } },
    };
    expect(() => validateInventory({ schemaVersion: 1, devices: [enrolled, second] })).toThrow(
      'unique per device',
    );
    expect(
      validateInventory({
        schemaVersion: 1,
        devices: [
          enrolled,
          { ...second, inputs: { vpn_config: { path: 'secrets/second.conf', sha256: hashB } } },
        ],
      }).devices,
    ).toHaveLength(2);
  });

  it('rejects ambiguous shared APK effects while preserving all stable user identities', () => {
    const effect = {
      packageId: 'org.example.vpn',
      users: [{ user: { userId: 10, serialNo: 17, name: 'Work' }, versionCode: 12, signerSha256: hashB }],
    };
    expect(validateSharedEffect(effect).users[0]?.user.serialNo).toBe(17);
    expect(() => validateSharedEffect({ ...effect, users: [...effect.users, ...effect.users] })).toThrow(
      'Duplicate shared',
    );
  });
});
