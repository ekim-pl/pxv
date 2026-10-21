import { expect, it } from '../test-api.js';
import { validatePreparedEvidence } from '../../packages/engine/src/prepared-evidence.js';
import { EvidenceValidationError, validateEvidence } from '../../packages/engine/src/evidence-validation.js';
import { alteredPrepared, preparedFixture, sealPrepared } from './prepared-fixture.js';

const empty = preparedFixture();
const prepared = sealPrepared({
  ...empty,
  plan: {
    ...empty.plan,
    actions: [{ kind: 'manual', capability: 'normal_credentials', instructions: 'Verify privately' }],
  },
});

it('authenticates exact prepared content independently of current time or installed extensions', () => {
  expect(validatePreparedEvidence(prepared, [])).toBe(prepared);
  expect(validatePreparedEvidence(empty, [])).toBe(empty);
  expect(() => validatePreparedEvidence(prepared, [{ changed: true }])).toThrow(EvidenceValidationError);
});
for (const [name, value] of Object.entries(alteredPrepared(prepared)))
  it(`rejects altered ${name} while retaining the claimed plan digest`, () => {
    expect(() => validatePreparedEvidence(value, [])).toThrow(EvidenceValidationError);
  });
it('rejects malformed prepared metadata before accepting a claimed digest', () => {
  for (const value of [
    { ...prepared, schemaVersion: 2 },
    { ...prepared, operation: 'unknown' },
    { ...prepared, expiresAt: 'invalid' },
    { ...prepared, baseline: null },
    {
      ...prepared,
      sharedEffects: [
        { packageId: 'org.example.other', users: [] },
        { packageId: 'org.example.other', users: [] },
      ],
    },
    null,
  ])
    expect(() => validatePreparedEvidence(value, [])).toThrow(EvidenceValidationError);
});
it('rejects inconsistent target bindings even when content was hashed again', () => {
  for (const draft of [
    {
      ...prepared,
      baseline: { ...prepared.baseline, device: { ...prepared.plan.device, canonicalSerial: 'OTHER' } },
    },
    { ...prepared, target: { ...prepared.target, transport: { kind: 'usb' as const, serial: 'OTHER' } } },
  ])
    expect(() => validatePreparedEvidence(sealPrepared(draft), [])).toThrow(EvidenceValidationError);
});
it('classifies only synchronous evidence validation and preserves existing validation errors', () => {
  const error = new EvidenceValidationError('Already classified');
  expect(() =>
    validateEvidence(() => {
      throw error;
    }),
  ).toThrow(error);
  expect(() =>
    validateEvidence(() => {
      // Exercise the boundary's handling of malformed legacy validation throws.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'malformed';
    }),
  ).toThrow('Invalid retained evidence');
});
