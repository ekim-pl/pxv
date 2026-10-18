import { describe, expect, it } from './../test-api.js';
import {
  validateSeedvaultAdapter,
  validateSeedvaultEvidence,
  validateSeedvaultProgress,
  validateSeedvaultRequest,
} from '@pxv/contracts';

const selector = { resourceId: 'com.stevesoltys.seedvault:id/result', text: 'Public generation' };
const completion = {
  apps: selector,
  files: selector,
  finalized: selector,
  idle: selector,
  generation: selector,
  fileGeneration: selector,
};
const adapter = {
  schemaVersion: 1,
  id: 'fixture-only',
  buildFingerprint: 'fixture/build',
  package: { packageId: 'com.stevesoltys.seedvault', versionCode: 36050070, signerSha256: 'a'.repeat(64) },
  acceptance: { path: '/private/fixture-acceptance.json', sha256: 'b'.repeat(64) },
  activities: ['.settings.SettingsActivity'],
  restoreSourceResourceId: selector.resourceId,
  restoreFileSourceResourceId: selector.resourceId,
  backup: {
    steps: [
      { action: 'start-backup', selector },
      { action: 'observe-files-running', selector },
    ],
    completion,
  },
  restore: {
    steps: [
      { action: 'select-source' },
      { action: 'start-restore', selector },
      { action: 'select-file-source' },
      { action: 'start-files-restore', selector },
      { action: 'observe-files-running', selector },
    ],
    completion,
  },
};
describe('Seedvault reviewed requests', () => {
  it('requires exact build, signer and hashed external acceptance', () => {
    expect(validateSeedvaultAdapter(adapter).package.versionCode).toBe(36050070);
    expect(() => validateSeedvaultAdapter({ ...adapter, acceptance: { path: '/tmp/file' } })).toThrow();
    expect(() =>
      validateSeedvaultAdapter({ ...adapter, package: { ...adapter.package, signerSha256: '*' } }),
    ).toThrow();
    expect(() => validateSeedvaultAdapter({ ...adapter, root: true })).toThrow();
  });
  it('requires explicit unique profile source selection and hexadecimal tokens', () => {
    const source = { profileId: 'owner', token: '12af', selector, filesSelector: selector };
    expect(
      validateSeedvaultRequest({ operation: 'restore', adapter, sources: [source] }).sources,
    ).toHaveLength(1);
    expect(() => validateSeedvaultRequest({ operation: 'restore' })).toThrow('explicit');
    expect(() =>
      validateSeedvaultRequest({
        operation: 'restore',
        sources: [{ profileId: 'owner', token: '12af', selector }],
      }),
    ).toThrow('filesSelector');
    expect(() => validateSeedvaultRequest({ operation: 'restore', sources: [source, source] })).toThrow(
      'Duplicate',
    );
    expect(() =>
      validateSeedvaultRequest({ operation: 'restore', sources: [{ ...source, token: 'latest' }] }),
    ).toThrow();
  });
  it('does not accept mnemonic typing, shell commands, or an unbound restore flow', () => {
    expect(() =>
      validateSeedvaultAdapter({
        ...adapter,
        backup: { steps: [{ action: 'text', selector, value: 'secret words' }], completion },
      }),
    ).toThrow();
    expect(() => validateSeedvaultAdapter({ ...adapter, restore: { steps: [], completion } })).toThrow(
      'reviewed source',
    );
    expect(() => validateSeedvaultRequest({ operation: 'backup', command: 'adb root' })).toThrow();
  });
  it('validates resumable state and requires all categories in measured evidence', () => {
    const user = { userId: 0, serialNo: 0, name: 'Owner' };
    const progress = {
      phase: 'running',
      beforeTokens: ['a'],
      obligationIds: ['foreground', 'job'],
      adapterDigest: 'a'.repeat(64),
      step: 1,
      inFlight: 1,
      previousForeground: user,
    };
    expect(validateSeedvaultProgress(progress).inFlight).toBe(1);
    expect(() =>
      validateSeedvaultProgress({ ...progress, previousForeground: { ...user, serialNo: -1 } }),
    ).toThrow();
    expect(() =>
      validateSeedvaultEvidence({
        profileId: 'owner',
        user,
        operation: 'backup',
        token: 'b',
        observedAt: new Date().toISOString(),
        adapterDigest: 'a'.repeat(64),
        apps: true,
        files: false,
        finalized: true,
        source: { profileId: 'owner', token: 'b', selector, filesSelector: selector },
      }),
    ).toThrow();
  });
});
