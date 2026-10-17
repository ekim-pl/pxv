import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReadinessRequirements,
  canonicalJson,
  digest,
  evaluateObservation,
  finalSetupActions,
  observationDigest,
  ownedObligations,
  parseDocument,
  requiredAttestations,
  resolvePolicy,
  resolveSelection,
  sameAndroidUser,
  validatePolicy,
  validatePolicyPack,
  validateProduct,
  validateProject,
} from '@pxv/contracts';
import { device, observation, obligation, policy, product, project } from './fixtures.js';

describe('canonical policy locks', () => {
  it('binds the complete policy, artifacts, product identity and installed extensions', () => {
    expect(canonicalJson({ z: 3, a: { y: 2, b: [1, true, null] } })).toBe(
      '{"a":{"b":[1,true,null],"y":2},"z":3}',
    );
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
    const first = resolvePolicy(policy, project, product);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolvePolicy({ ...policy, name: 'Changed' }, project, product).digest).not.toBe(first.digest);
    expect(resolvePolicy(policy, project, { ...product, name: 'Fork' }).digest).not.toBe(first.digest);
    const extension = {
      id: '@private/feature',
      version: '0.1.0',
      integrity: `sha512-${'A'.repeat(86)}==`,
      apiVersion: 1 as const,
      entry: 'index.js',
      installPath: 'extensions/feature',
    };
    expect(resolvePolicy(policy, { ...project, extensions: [extension] }, product).digest).not.toBe(
      first.digest,
    );
    expect(() => resolvePolicy(policy, { ...project, productId: 'different' }, product)).toThrow(
      'product ID',
    );
  });

  it.each([undefined, Number.NaN, Infinity, () => 'bad', 1n, new Date(), Symbol('x')])(
    'rejects non-JSON values %s',
    (value) => {
      expect(() => canonicalJson(value)).toThrow();
    },
  );

  it('rejects cycles, sparse arrays, symbol properties and decorated arrays', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => canonicalJson(cycle)).toThrow('cycles');
    expect(() => canonicalJson(new Array<unknown>(2))).toThrow('sparse');
    expect(() => canonicalJson({ [Symbol('x')]: 1 })).toThrow('symbol');
    expect(() => canonicalJson(Object.assign([1], { extra: 2 }))).toThrow('decorated');
    expect(canonicalJson(Object.assign(Object.create(null) as Record<string, unknown>, { a: null }))).toBe(
      '{"a":null}',
    );
  });
});

describe('explicit device selection', () => {
  const second = {
    ...device,
    assetId: 'second',
    canonicalSerial: 'PIXEL2',
    transports: [{ kind: 'usb' as const, serial: 'PIXEL2' }],
    groups: ['other'],
  };
  const inventory = { schemaVersion: 1 as const, devices: [device, second] };

  it('treats an asset called all literally and selects the fleet only explicitly (regression 5)', () => {
    expect(
      resolveSelection(inventory, { kind: 'asset', assetId: 'all' }).map(
        (item) => item.device.canonicalSerial,
      ),
    ).toEqual(['PIXEL1']);
    expect(resolveSelection(inventory, { kind: 'fleet' })).toHaveLength(2);
    expect(resolveSelection(inventory, { kind: 'group', group: 'other' })[0]?.device.assetId).toBe('second');
    expect(resolveSelection(inventory, { kind: 'asset', assetId: 'all' }, 'wifi')[0]?.transport.serial).toBe(
      '192.0.2.10:5555',
    );
  });

  it('fails closed for empty selections and ambiguous/missing transports', () => {
    expect(() => resolveSelection(inventory, { kind: 'asset', assetId: 'unknown' })).toThrow('empty');
    expect(() => resolveSelection(inventory, { kind: 'asset', assetId: 'second' }, 'wifi')).toThrow(
      'No wifi',
    );
    const ambiguous = {
      schemaVersion: 1 as const,
      devices: [
        {
          ...device,
          transports: [
            { kind: 'wifi' as const, serial: '192.0.2.10:1' },
            { kind: 'wifi' as const, serial: '192.0.2.10:2' },
          ],
        },
      ],
    };
    expect(() => resolveSelection(ambiguous, { kind: 'fleet' })).toThrow('Ambiguous');
    expect(() => resolveSelection(ambiguous, { kind: 'fleet' }, 'wifi')).toThrow('Ambiguous');
    expect(() => resolveSelection(inventory, { kind: 'unexpected' } as never)).toThrow('Unsupported');
  });
});

describe('shared measured evidence', () => {
  it('validates all desired settings, packages, permissions, language and VPN state', () => {
    const report = evaluateObservation(policy, observation);
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThan(8);
    const lock = resolvePolicy(policy, project, product);
    expect(evaluateObservation(lock, observation).policyDigest).toBe(lock.digest);
  });

  it('invalidates signoff after permission drift (regression 2)', () => {
    const changed = structuredClone(observation);
    const permission = changed.profiles[0]?.permissions[0];
    if (!permission) throw new Error('Fixture permission missing');
    permission.granted = false;
    expect(observationDigest(changed)).not.toBe(observationDigest(observation));
    const report = evaluateObservation(policy, changed);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.key.includes('.permission.'))?.passed).toBe(false);
  });

  it('does not turn absent evidence into success and distinguishes owner user 0', () => {
    const changed = structuredClone(observation);
    const profile = changed.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.packages = [];
    profile.settings = [];
    profile.permissions = [];
    profile.user.userId = 10;
    profile.vpn = { packageId: null, alwaysOn: false, lockdown: false };
    delete profile.language;
    const report = evaluateObservation(policy, changed);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.key === 'admin.owner')?.passed).toBe(false);
    expect(report.checks.find((check) => check.key.includes('.version'))?.actual).toBeNull();
    expect(evaluateObservation(policy, { ...observation, profiles: [] }).passed).toBe(false);
  });

  it('checks pinned OS and requires verified boot only for physical devices', () => {
    const os = {
      codename: 'akita',
      release: 'different',
      url: 'https://example.org/image.zip',
      signatureUrl: 'https://example.org/image.zip.sig',
      signerPrincipal: 'release@example.org',
      namespace: 'factory images',
      publicKey: 'ssh-ed25519 AAAA',
    };
    expect(evaluateObservation({ ...policy, osByCodename: { akita: os } }, observation).passed).toBe(false);
    expect(
      evaluateObservation(policy, { ...observation, os: { ...observation.os, bootVerified: false } }).passed,
    ).toBe(false);
    const emulator = {
      ...observation,
      device: {
        ...device,
        kind: 'emulator' as const,
        transports: [{ kind: 'emulator' as const, serial: 'emulator-5554' }],
      },
      os: { ...observation.os, bootVerified: false },
    };
    expect(evaluateObservation(policy, emulator).passed).toBe(true);
  });

  it('ignores collection time and unordered ADB listings while retaining identity and safety state', () => {
    const later = structuredClone(observation);
    later.observedAt = '2026-10-16T10:00:00Z';
    later.device.transports.reverse();
    expect(observationDigest(later)).toBe(observationDigest(observation));
    later.debuggingEnabled = false;
    expect(observationDigest(later)).not.toBe(observationDigest(observation));
  });
});

describe('recovery ownership and identity', () => {
  it('rejects a recreated Android user even when ID and name match (regression 1)', () => {
    const original = { userId: 10, serialNo: 17, name: 'contacts' };
    expect(sameAndroidUser(original, { ...original })).toBe(true);
    expect(sameAndroidUser(original, { ...original, serialNo: 18 })).toBe(false);
    expect(sameAndroidUser(original, { ...original, name: 'other' })).toBe(false);
    expect(sameAndroidUser(original, { ...original, userId: 11 })).toBe(false);
  });

  it('leaves parent resources active when a child probe finishes (regression 3)', () => {
    const child = {
      ...obligation,
      id: 'child-obligation',
      operationId: 'child',
      ownerOperationId: 'child',
      resource: 'probe-helper',
    };
    const resolved = { ...child, id: 'already-resolved', status: 'resolved' as const };
    expect(ownedObligations([obligation, child, resolved], 'child')).toEqual([child]);
    expect(ownedObligations([obligation, child], 'parent')).toEqual([obligation]);
  });
});

describe('capability-based readiness and private setup', () => {
  it('accepts emulator provenance with language and duress enabled (regression 6)', () => {
    expect(requiredAttestations(policy, 'emulator')).toContain('emulator_image_provenance');
    expect(requiredAttestations(policy, 'emulator')).not.toContain('verified_boot');
    expect(requiredAttestations({ ...policy, requiredAttestations: ['emulator_image_provenance'] })).toEqual([
      'duress',
      'normal_credentials',
      'operator_signoff',
      'recipient_acceptance',
      'verified_boot',
    ]);
    const requirements = buildReadinessRequirements(policy, 'emulator');
    expect(requirements.find((item) => item.id === 'emulator_image_provenance')?.profileIds).toEqual([]);
    expect(requirements.find((item) => item.id === 'routes')?.profileIds).toEqual(['admin']);
    expect(
      buildReadinessRequirements({ ...policy, requiredAttestations: ['custom_check'] }).find(
        (item) => item.id === 'custom_check',
      )?.instructions.pl,
    ).toContain('custom_check');
  });

  it('orders recipient normal credentials before language and optional duress', () => {
    const actions = finalSetupActions(policy);
    expect(actions.map((action) => (action.kind === 'manual' ? action.capability : action.kind))).toEqual([
      'normal_credentials',
      'language',
      'duress',
    ]);
    const final = actions.at(-1);
    expect(final?.kind).toBe('manual');
    if (final?.kind === 'manual') expect(final.instructions).toContain('Never activate');
    expect(
      finalSetupActions({
        ...policy,
        capabilities: [],
        profiles: policy.profiles.map((profile) => {
          const clean = { ...profile };
          delete clean.language;
          return clean;
        }),
      }),
    ).toEqual([]);
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const fleetProfiles = finalSetupActions({
      ...policy,
      profiles: [...policy.profiles, { ...owner, id: 'work', name: 'Work', kind: 'secondary' }],
    });
    const credentials = fleetProfiles.filter(
      (action) => action.kind === 'manual' && action.capability === 'normal_credentials',
    );
    expect(credentials).toHaveLength(1);
    const credential = credentials[0];
    if (credential?.kind !== 'manual') throw new Error('Manual credential gate missing');
    expect(credential.instructions).toContain('every selected profile: admin, work');
    expect(fleetProfiles.map((action) => action.kind)).toEqual(['manual', 'language', 'language', 'manual']);
  });

  it('applies all normal defaults before the private gate and owner duress after language', () => {
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const configured = validatePolicyPack({
      ...policy,
      capabilities: [],
      profiles: [
        {
          ...owner,
          defaultCredential: { type: 'password', secretRef: 'owner-password' },
          defaultDuress: {
            ownerCredentialRef: 'owner-password',
            pinRef: 'duress-pin',
            passwordRef: 'duress-password',
          },
        },
        {
          ...owner,
          id: 'work',
          name: 'Work',
          kind: 'secondary',
          defaultCredential: { type: 'pin', secretRef: 'work-pin' },
        },
      ],
    });
    const actions = finalSetupActions(configured);
    expect(actions.map((action) => (action.kind === 'manual' ? action.capability : action.kind))).toEqual([
      'default-credential',
      'default-credential',
      'normal_credentials',
      'language',
      'language',
      'default-duress',
      'duress',
    ]);
    expect(actions[0]).toEqual({
      kind: 'default-credential',
      profileId: owner.id,
      credential: configured.profiles[0]?.defaultCredential,
    });
    expect(actions[5]).toEqual({
      kind: 'default-duress',
      profileId: owner.id,
      duress: configured.profiles[0]?.defaultDuress,
    });
    const normal = actions[2];
    expect(normal?.kind === 'manual' && normal.instructions).toContain(
      'verify or replace configured defaults',
    );
    const requirements = buildReadinessRequirements(configured);
    expect(requirements.find((item) => item.id === 'normal_credentials')?.profileIds).toEqual([
      owner.id,
      'work',
    ]);
    expect(requirements.find((item) => item.id === 'duress')?.profileIds).toEqual([owner.id]);
  });

  it('requires private normal checks for credential defaults and both private checks for duress defaults', () => {
    const owner = policy.profiles[0];
    if (!owner) throw new Error('Fixture owner missing');
    const cleanOwner = { ...owner };
    delete cleanOwner.language;
    const plain = { ...policy, capabilities: [], profiles: [cleanOwner] };
    const credentials = validatePolicyPack({
      ...plain,
      profiles: [{ ...cleanOwner, defaultCredential: { type: 'pin', secretRef: 'owner-pin' } }],
    });
    expect(requiredAttestations(credentials)).toContain('normal_credentials');
    expect(requiredAttestations(credentials)).not.toContain('duress');
    expect(finalSetupActions(credentials).map((action) => action.kind)).toEqual([
      'default-credential',
      'manual',
    ]);
    const duress = validatePolicyPack({
      ...plain,
      profiles: [
        {
          ...cleanOwner,
          defaultDuress: {
            ownerCredentialRef: 'existing-owner-pin',
            pinRef: 'duress-pin',
            passwordRef: 'duress-password',
          },
        },
      ],
    });
    expect(requiredAttestations(duress)).toEqual(expect.arrayContaining(['normal_credentials', 'duress']));
    expect(
      finalSetupActions(duress).map((action) => (action.kind === 'manual' ? action.capability : action.kind)),
    ).toEqual(['normal_credentials', 'default-duress', 'duress']);
  });

  it('loads starter packs, the project template and the active Community product', () => {
    for (const name of ['reference-five', 'simple', 'custom']) {
      const loaded = validatePolicy(
        parseDocument(readFileSync(`policy-packs/${name}/policy.v2.json`, 'utf8')),
      );
      expect(loaded.profiles.filter((profile) => profile.kind === 'owner')).toHaveLength(1);
      expect(loaded.profiles.length).toBe(name === 'reference-five' ? 5 : name === 'simple' ? 1 : 3);
    }
    expect(validateProject(parseDocument(readFileSync('config/templates/project.json', 'utf8'))).format).toBe(
      'pxv-ts',
    );
    const activeProduct = validateProduct(parseDocument(readFileSync('product.json', 'utf8')));
    expect(activeProduct).toMatchObject({
      id: 'pxv',
      name: 'pxv Community',
      engineApi: 1,
      features: { extensions: false, seedvault: false },
      defaultPolicy: 'policy-packs/reference-five/policy.v2.json',
    });
    const defaultPolicy = validatePolicy(parseDocument(readFileSync(activeProduct.defaultPolicy, 'utf8')));
    expect(defaultPolicy.profiles).toHaveLength(5);
  });
});
