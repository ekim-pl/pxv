import { readFile } from 'node:fs/promises';
import { describe, expect, it } from './../test-api.js';
import {
  effectiveProfileSettings,
  evaluateObservation,
  finalSetupActions,
  PIN_SCRAMBLING_KEY,
  requiredAttestations,
  resolvePolicy,
  toPolicyDocument,
  validateExecutionPolicy,
  validatePolicy,
  validatePolicySourceDocument,
  verifyResolvedPolicy,
} from '@pxv/contracts';
import { observation, policy, product, project } from './fixtures.js';

const setting = (value: string) => ({ namespace: 'secure' as const, key: PIN_SCRAMBLING_KEY, value });

describe('optional primary profile PIN scrambling', () => {
  it.each([true, false])(
    'preserves %s through authoring, source validation and locked policies',
    (enabled) => {
      const execution = structuredClone(policy);
      execution.profiles[0]!.scramblePinLayout = enabled;
      const document = toPolicyDocument(execution);
      expect(validatePolicySourceDocument(document).profiles[0]?.scramblePinLayout).toBe(enabled);
      expect(validatePolicy(document)).toEqual(execution);
      const locked = resolvePolicy(execution, project, product);
      expect(verifyResolvedPolicy(locked).policy.profiles[0]?.scramblePinLayout).toBe(enabled);
      expect(effectiveProfileSettings(execution.profiles[0]!)).toContainEqual(setting(enabled ? '1' : '0'));
      expect(execution.profiles[0]?.settings).not.toContainEqual(setting(enabled ? '1' : '0'));
    },
  );

  it('enables only initial PIN profiles in the fleet starters', async () => {
    for (const pack of ['fleet-nerd', 'fleet-privacy']) {
      const document: unknown = JSON.parse(await readFile(`policy-packs/${pack}/policy.json`, 'utf8'));
      const configured = validatePolicySourceDocument(document);
      expect(configured.profiles.some((profile) => profile.defaultCredential?.type === 'pin')).toBe(true);
      for (const profile of configured.profiles) {
        if (profile.defaultCredential?.type === 'pin') expect(profile.scramblePinLayout).toBe(true);
        else expect(profile).not.toHaveProperty('scramblePinLayout');
      }
    }
  });

  it('leaves an omitted option unmanaged and preserves existing raw declarations', () => {
    const profile = structuredClone(policy.profiles[0]!);
    expect(effectiveProfileSettings(profile)).toEqual(profile.settings);
    profile.settings.push(setting('1'));
    expect(effectiveProfileSettings(profile)).toEqual(profile.settings);
    expect(toPolicyDocument(policy).profiles[0]).not.toHaveProperty('scramblePinLayout');
  });

  it.each([true, false])('deduplicates matching declarations and rejects conflicts for %s', (enabled) => {
    const execution = structuredClone(policy);
    const profile = execution.profiles[0]!;
    profile.scramblePinLayout = enabled;
    profile.settings.push(setting(enabled ? '1' : '0'));
    expect(validateExecutionPolicy(execution)).toEqual(execution);
    expect(effectiveProfileSettings(profile).filter((item) => item.key === PIN_SCRAMBLING_KEY)).toHaveLength(
      1,
    );
    const document = toPolicyDocument(execution);
    profile.settings.at(-1)!.value = enabled ? '0' : '1';
    document.profiles[0]!.settings.at(-1)!.value = enabled ? '0' : '1';
    expect(() => validateExecutionPolicy(execution)).toThrow('scramblePinLayout conflicts');
    expect(() => validatePolicy(document)).toThrow('scramblePinLayout conflicts');
    expect(() => validatePolicySourceDocument(document)).toThrow('scramblePinLayout conflicts');
    expect(() => effectiveProfileSettings(profile)).toThrow('scramblePinLayout conflicts');
  });

  it.each(['true', 1, null])('rejects a non-boolean option %s', (invalid) => {
    const execution = structuredClone(policy);
    expect(() =>
      validateExecutionPolicy({
        ...execution,
        profiles: [{ ...execution.profiles[0], scramblePinLayout: invalid }],
      }),
    ).toThrow();
  });

  it.each([true, false])('requires private confirmation and evaluates measured state for %s', (enabled) => {
    const execution = structuredClone(policy);
    execution.capabilities = [];
    execution.requiredAttestations = [];
    const profile = execution.profiles[0]!;
    delete profile.language;
    profile.scramblePinLayout = enabled;
    expect(requiredAttestations(execution)).toContain('normal_credentials');
    const check = finalSetupActions(execution).find((action) => action.kind === 'manual');
    expect(check).toMatchObject({ capability: 'normal_credentials' });
    expect(check?.kind === 'manual' && check.instructions).toContain(
      'privately verify the primary PIN keypad layout',
    );
    expect(check?.kind === 'manual' && check.instructions).toContain(
      `${profile.id}: ${enabled ? 'shuffled' : 'standard'}`,
    );
    const measured = structuredClone(observation);
    const key = `${profile.id}.setting.secure.${PIN_SCRAMBLING_KEY}`;
    expect(evaluateObservation(execution, measured).checks.find((item) => item.key === key)?.passed).toBe(
      false,
    );
    measured.profiles[0]!.settings.push(setting(enabled ? '1' : '0'));
    expect(evaluateObservation(execution, measured).checks.find((item) => item.key === key)?.passed).toBe(
      true,
    );
    measured.profiles[0]!.settings.at(-1)!.value = enabled ? '0' : '1';
    expect(evaluateObservation(execution, measured).checks.find((item) => item.key === key)?.passed).toBe(
      false,
    );
  });
});
