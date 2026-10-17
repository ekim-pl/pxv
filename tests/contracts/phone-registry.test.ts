import { describe, expect, it } from 'vitest';
import {
  validatePhoneRegistryDocument,
  validatePhoneRegistryEpoch,
  validatePhoneRegistryRecordInput,
} from '@pxv/contracts';
import { registryDocument, registryInput, registryMarker } from './phone-registry-fixtures.js';

describe('strict private registry contracts', () => {
  it('accepts explicit per-profile identities and private fields without inventing confirmations for inputs', () => {
    const input = validatePhoneRegistryRecordInput(registryInput());
    expect(input.profiles[1]?.user).toEqual({ userId: 10, serialNo: 22, name: 'Work' });
    expect(input.profiles[1]?.fields.oblivionNotificationWipeKey).not.toHaveProperty('confirmedAt');
    expect(validatePhoneRegistryDocument(registryDocument())).toEqual(registryDocument());
  });

  it('rejects unknown fields, invalid state, undefined and excessive values without echoing private input', () => {
    const invalid: unknown[] = [
      { ...registryInput(), [registryMarker]: 'unrecognized-private-field' },
      { ...registryInput(), fields: { duressPin: { value: registryMarker, state: 'verified-by-device' } } },
      { ...registryInput(), fields: { phoneNumber: undefined } },
      {
        ...registryInput(),
        fields: { phoneNumber: { value: registryMarker.repeat(1024), state: 'unknown' } },
      },
    ];
    for (const input of invalid) {
      try {
        validatePhoneRegistryRecordInput(input);
        throw new Error('Expected rejection');
      } catch (error) {
        expect((error as Error).message).toBe('Invalid private phone registry data');
        expect((error as Error).message).not.toContain(registryMarker);
      }
    }
  });

  it('requires confirmation metadata for retained current values and rejects duplicate profile identities', () => {
    const document = registryDocument();
    delete document.devices[0]!.fields.duressPin!.confirmedAt;
    expect(() => validatePhoneRegistryDocument(document)).toThrow('Invalid private phone registry data');
    const input = registryInput();
    input.profiles[1]!.user.serialNo = input.profiles[0]!.user.serialNo;
    expect(() => validatePhoneRegistryRecordInput(input)).toThrow('Invalid private phone registry data');
    expect(() =>
      validatePhoneRegistryEpoch({
        canonicalSerial: 'TEST',
        codename: 'akita',
        deviceEpoch: '',
        profileEpochs: { work: '-'.repeat(36) },
      }),
    ).toThrow('Invalid private phone registry data');
  });

  it('rejects truncated or substituted revision history instead of silently dropping old credentials', () => {
    const missing = registryDocument();
    missing.history = [];
    expect(() => validatePhoneRegistryDocument(missing)).toThrow('history');
    const changed = registryDocument();
    changed.devices[0]!.fields.duressPassword!.value = `${registryMarker}_changed`;
    expect(() => validatePhoneRegistryDocument(changed)).toThrow('history');
    const revision = registryDocument();
    revision.history[0]!.revision = 2;
    expect(() => validatePhoneRegistryDocument(revision)).toThrow('history');
  });
});
