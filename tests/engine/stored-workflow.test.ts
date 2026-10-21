import { expect, it } from '../test-api.js';
import { validateStoredWorkflow } from '../../packages/engine/src/stored-workflow.js';
import { observation, device, hashA } from '../contracts/fixtures.js';
const state = {
  schemaVersion: 1,
  assetId: device.assetId,
  policyDigest: hashA,
  planDigest: hashA,
  pending: [],
  languageReady: true,
  status: 'verified',
  observation,
  observedAt: 'invalid',
};
it('preserves stored evidence and leaves timestamp freshness to readiness', () => {
  expect(validateStoredWorkflow(state, device.assetId)).toBe(state);
});
for (const [name, value] of Object.entries({
  absent: undefined,
  planIdType: { ...state, planId: 1 },
  planIdEmpty: { ...state, planId: '' },
  referenceType: { ...state, completedSetup: {} },
  referenceNull: { ...state, completedSetup: [null] },
  referencePrimitive: { ...state, capabilityEvidence: [1] },
  referenceFields: { ...state, completedSetup: [{ check: 'normal_credentials' }] },
  null: null,
  schema: { ...state, schemaVersion: 2 },
  asset: { ...state, assetId: 'other' },
  policy: { ...state, policyDigest: 'bad' },
  plan: { ...state, planDigest: 'bad' },
  pending: { ...state, pending: null },
  pendingItem: { ...state, pending: [1] },
  language: { ...state, languageReady: 'yes' },
  status: { ...state, status: 'unknown' },
  observation: { ...state, observation: null },
  observedAsset: { ...state, observation: { ...observation, device: { ...device, assetId: 'other' } } },
}))
  it(`rejects malformed retained ${name}`, () => {
    expect(() => validateStoredWorkflow(value, device.assetId)).toThrow();
  });

it('validates optional retained reference collections without discarding them', () => {
  const value = {
    ...state,
    planId: 'plan',
    completedSetup: [{ check: 'normal_credentials', receiptId: 'receipt', planDigest: hashA }],
    capabilityEvidence: [
      {
        kind: 'vpn-settings',
        profileId: 'owner',
        configurationDigest: hashA,
        evidenceId: 'proof',
        status: 'manual-completed',
      },
    ],
  };
  expect(validateStoredWorkflow(value, device.assetId)).toBe(value);
});
