import { describe, expect, it } from 'vitest';
import { observationDigest, type OperatorAttestation } from '@pxv/contracts';
import { checkLanguageDelta, normalReceiptMatches } from '../../packages/engine/src/setup-evidence.js';
import { hashA, hashB, observation } from '../contracts/fixtures.js';

describe('shared private-setup evidence decisions', () => {
  it('recognizes only an exact normal-credential receipt or explicitly consumed receipt lineage', () => {
    const receipt: OperatorAttestation = {
      schemaVersion: 1,
      id: 'receipt',
      check: 'normal_credentials',
      operator: 'Alice',
      recordedAt: '2026-10-16T09:00:00.000Z',
      planDigest: hashA,
      observationDigest: observationDigest(observation),
      profileIds: ['owner'],
      note: 'Privately entered',
    };
    expect(normalReceiptMatches(receipt, hashA, observation)).toBe(true);
    expect(normalReceiptMatches({ ...receipt, check: 'operator_signoff' }, hashA, observation)).toBe(false);
    expect(normalReceiptMatches(receipt, hashB, observation)).toBe(false);
    const lineage = [{ check: receipt.check, receiptId: receipt.id, planDigest: receipt.planDigest }];
    expect(normalReceiptMatches(receipt, hashB, observation, lineage)).toBe(true);
    expect(
      normalReceiptMatches(receipt, hashB, observation, [{ ...lineage[0]!, receiptId: 'different' }]),
    ).toBe(false);
  });
  it('permits only the planned language delta, including an initially unmeasured language', () => {
    const expected = structuredClone(observation),
      actual = structuredClone(observation);
    const profile = actual.profiles[0],
      prior = expected.profiles[0];
    if (!profile || !prior) throw new Error('Missing profile fixture');
    delete prior.language;
    profile.language = 'pl-PL';
    expect(checkLanguageDelta(expected, actual, prior.profileId)).toBe('pl-PL');
    expect(prior.language).toBeUndefined();
    const changed = structuredClone(actual);
    changed.debuggingEnabled = !expected.debuggingEnabled;
    expect(() => checkLanguageDelta(expected, changed, prior.profileId)).toThrow(
      'Other live requirements changed',
    );
    expect(() => checkLanguageDelta({ ...expected, profiles: [] }, actual, prior.profileId)).toThrow(
      'profile identity changed',
    );
    expect(() => checkLanguageDelta(expected, { ...actual, profiles: [] }, prior.profileId)).toThrow(
      'profile identity changed',
    );
  });
});
