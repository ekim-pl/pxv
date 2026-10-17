import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateObservation,
  observationDigest,
  ownedObligations,
  requiredAttestations,
  resolveSelection,
  sameAndroidUser,
  validateObligation,
  validatePolicy,
} from '@pxv/contracts';
import { device, observation, obligation, policy } from './fixtures.js';

interface Regressions {
  androidUserReuse: {
    original: { userId: number; serialNo: number; name: string };
    replacement: { userId: number; serialNo: number; name: string };
    cleanupAllowed: boolean;
  };
  permissionDrift: {
    packageId: string;
    permission: string;
    originalGranted: boolean;
    replacementGranted: boolean;
    signoffValid: boolean;
  };
  childResourceScope: {
    parentOperation: string;
    childOperation: string;
    parentResource: string;
    childResource: string;
    expectedReleased: string[];
  };
  secretEnvironmentRetention: {
    name: string;
    sentinel: string;
    durableField: string;
    retentionAllowed: boolean;
  };
  allAssetSelection: { assetId: string; expectedDeviceSerial: string; expectedSelectedCount: number };
  emulatorFinalSetup: { capabilities: string[]; requiredEvidence: string; forbiddenEvidence: string };
}
const cases = JSON.parse(readFileSync('tests/acceptance/safety-regressions.json', 'utf8')) as Regressions;

describe('language-independent acceptance contracts', () => {
  it('prevents cleanup of a recreated user', () => {
    expect(sameAndroidUser(cases.androidUserReuse.original, cases.androidUserReuse.replacement)).toBe(
      cases.androidUserReuse.cleanupAllowed,
    );
  });
  it('invalidates permission drift in the shared signoff measurement', () => {
    const changed = structuredClone(observation);
    const profile = changed.profiles[0];
    if (!profile) throw new Error('Fixture profile missing');
    profile.permissions = [
      {
        packageId: cases.permissionDrift.packageId,
        permission: cases.permissionDrift.permission,
        granted: cases.permissionDrift.replacementGranted,
      },
    ];
    expect(evaluateObservation(policy, changed).passed).toBe(cases.permissionDrift.signoffValid);
    expect(observationDigest(changed)).not.toBe(observationDigest(observation));
  });
  it('restricts nested cleanup to child ownership', () => {
    const fixture = cases.childResourceScope;
    const resources = [
      {
        ...obligation,
        operationId: fixture.parentOperation,
        ownerOperationId: fixture.parentOperation,
        resource: fixture.parentResource,
      },
      {
        ...obligation,
        id: 'child',
        operationId: fixture.parentOperation,
        ownerOperationId: fixture.childOperation,
        resource: fixture.childResource,
      },
    ];
    expect(ownedObligations(resources, fixture.childOperation).map((item) => item.resource)).toEqual(
      fixture.expectedReleased,
    );
  });
  it('refuses inherited environment fields in durable ownership evidence', () => {
    const fixture = cases.secretEnvironmentRetention;
    expect(fixture.retentionAllowed).toBe(false);
    expect(() =>
      validateObligation({ ...obligation, [fixture.durableField]: { [fixture.name]: fixture.sentinel } }),
    ).toThrow();
  });
  it('resolves an asset called all exactly', () => {
    const selected = resolveSelection(
      { schemaVersion: 1, devices: [device] },
      { kind: 'asset', assetId: cases.allAssetSelection.assetId },
    );
    expect(selected).toHaveLength(cases.allAssetSelection.expectedSelectedCount);
    expect(selected[0]?.device.canonicalSerial).toBe(cases.allAssetSelection.expectedDeviceSerial);
  });
  it('supports emulator image provenance with final language and duress capabilities', () => {
    const selected = { ...policy, capabilities: cases.emulatorFinalSetup.capabilities };
    expect(requiredAttestations(selected, 'emulator')).toContain(cases.emulatorFinalSetup.requiredEvidence);
    expect(requiredAttestations(selected, 'emulator')).not.toContain(
      cases.emulatorFinalSetup.forbiddenEvidence,
    );
  });
  it('uses the workflow inventory to validate supported independent profile layouts', () => {
    const inventory = JSON.parse(readFileSync('tests/acceptance/workflow-inventory.json', 'utf8')) as {
      profileLayouts: { pack: string; count: number }[];
    };
    for (const layout of inventory.profileLayouts)
      expect(
        validatePolicy(
          JSON.parse(readFileSync(`policy-packs/${layout.pack}/policy.v2.json`, 'utf8')) as unknown,
        ).profiles,
      ).toHaveLength(layout.count);
  });
});
