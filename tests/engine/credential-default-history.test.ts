import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digest, type Action, type SelectedTarget } from '@pxv/contracts';
import { SqliteStore } from '@pxv/runtime';
import {
  CredentialDefaultHistory,
  type DefaultCredentialAction,
} from '../../packages/engine/src/credential-default-history.js';
import { device, observation } from '../contracts/fixtures.js';

const target: SelectedTarget = { device, transport: { kind: 'usb', serial: device.canonicalSerial } };
const user = { userId: 0, serialNo: 0, name: 'Administrator' };
const normal: DefaultCredentialAction = {
  kind: 'default-credential',
  profileId: 'admin',
  credential: { type: 'pin', secretRef: 'owner-pin' },
};
const duress: DefaultCredentialAction = {
  kind: 'default-duress',
  profileId: 'admin',
  duress: { ownerCredentialRef: 'owner-pin', pinRef: 'duress-pin', passwordRef: 'duress-password' },
};
const language: Action = { kind: 'language', profileId: 'admin', language: 'pl-PL' };
const manual: Action = {
  kind: 'manual',
  capability: 'normal_credentials',
  instructions: 'Verify privately.',
};

describe('one-time credential default history', () => {
  let root: string;
  let store: SqliteStore;
  let history: CredentialDefaultHistory;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-credential-default-history-'));
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    history = new CredentialDefaultHistory(store);
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves every action until its exact profile, kind and stable user has been accepted', async () => {
    const actions = [normal, manual, language, duress];
    expect(await history.pending(target, observation, actions)).toEqual(actions);
    await history.recordAccepted(target, normal, user, 'first-run');
    expect(await history.pending(target, observation, actions)).toEqual([manual, language, duress]);
    expect(await history.alreadyAccepted(target, normal, user)).toBe(true);
    expect(await history.alreadyAccepted(target, duress, user)).toBe(false);
    const anotherProfile = { ...normal, profileId: 'work' };
    expect(await history.alreadyAccepted(target, anotherProfile, user)).toBe(false);
    expect(actions).toEqual([normal, manual, language, duress]);
  });

  it('never reapplies accepted defaults when policy references or credential types change', async () => {
    await history.recordAccepted(target, normal, user, 'first-run');
    await history.recordAccepted(target, duress, user, 'first-run');
    const changedNormal: DefaultCredentialAction = {
      ...normal,
      credential: { type: 'password', secretRef: 'replacement-password' },
    };
    const changedDuress: DefaultCredentialAction = {
      ...duress,
      duress: {
        ownerCredentialRef: 'replacement-password',
        pinRef: 'other-pin',
        passwordRef: 'other-password',
      },
    };
    expect(
      await history.pending(target, observation, [changedNormal, manual, language, changedDuress]),
    ).toEqual([manual, language]);
    expect(await history.alreadyAccepted(target, changedNormal, user)).toBe(true);
    expect(await history.alreadyAccepted(target, changedDuress, user)).toBe(true);
    await history.recordAccepted(target, changedNormal, user, 'later-run');
    const retained = await store.get<{ entries: unknown[] }>('credential-defaults', device.assetId);
    expect(retained?.entries).toHaveLength(2);
    expect(retained?.entries[1]).toEqual({
      kind: changedNormal.kind,
      profileId: 'admin',
      user,
      configurationDigest: digest(changedNormal),
      runId: 'later-run',
      status: 'command-accepted',
    });
    expect(JSON.stringify(retained)).not.toMatch(
      /owner-pin|replacement-password|other-password|pinRef|secretRef/,
    );
  });

  it('retains defaults for newly created or recreated users with a reused Android numeric ID', async () => {
    await history.recordAccepted(target, normal, user, 'first-run');
    expect(await history.pending(target, { ...observation, profiles: [] }, [normal])).toEqual([normal]);
    for (const changed of [
      { ...user, serialNo: 17 },
      { ...user, userId: 10 },
      { ...user, name: 'Changed' },
    ]) {
      const baseline = structuredClone(observation);
      baseline.profiles[0]!.user = changed;
      expect(await history.pending(target, baseline, [normal, language])).toEqual([normal, language]);
      expect(await history.alreadyAccepted(target, normal, changed)).toBe(false);
    }
    const recreated = { ...user, serialNo: 17 };
    await history.recordAccepted(target, normal, recreated, 'second-user-run');
    expect(await history.alreadyAccepted(target, normal, recreated)).toBe(true);
  });

  it('clears accepted owner defaults for explicit OS installation despite owner serial zero reuse', async () => {
    await history.recordAccepted(target, normal, user, 'first-run');
    await history.recordAccepted(target, duress, user, 'first-run');
    await history.clear(target);
    expect(await store.get('credential-defaults', device.assetId)).toBeUndefined();
    expect(await history.pending(target, observation, [normal, duress])).toEqual([normal, duress]);
    expect(await history.alreadyAccepted(target, normal, user)).toBe(false);
  });

  it('rejects a reused asset ID identifying another physical phone without erasing history', async () => {
    await history.recordAccepted(target, normal, user, 'first-run');
    const retained = await store.get('credential-defaults', device.assetId);
    const replacement = { ...target, device: { ...device, canonicalSerial: 'REPLACEMENT' } };
    await expect(history.pending(replacement, observation, [normal])).rejects.toThrow(
      'device identity changed',
    );
    await expect(history.alreadyAccepted(replacement, normal, user)).rejects.toThrow(
      'device identity changed',
    );
    await expect(history.recordAccepted(replacement, normal, user, 'unsafe-run')).rejects.toThrow(
      'device identity changed',
    );
    await expect(history.clear(replacement)).rejects.toThrow('device identity changed');
    expect(await store.get('credential-defaults', device.assetId)).toEqual(retained);
  });

  it('retains malformed history for inspection instead of treating it as uninitialized', async () => {
    const entry = {
      kind: normal.kind,
      profileId: normal.profileId,
      user,
      configurationDigest: digest(normal),
      runId: 'first-run',
      status: 'command-accepted',
    };
    for (const value of [
      null,
      { deviceSerial: device.canonicalSerial, entries: {} },
      { deviceSerial: device.canonicalSerial, entries: [entry, entry] },
      { deviceSerial: device.canonicalSerial, entries: [{ ...entry, user: { ...user, serialNo: -1 } }] },
      { deviceSerial: device.canonicalSerial, entries: [{ ...entry, status: 'completed' }] },
      { deviceSerial: device.canonicalSerial, entries: [{ ...entry, credentialValue: 'never-expose-this' }] },
    ]) {
      await store.set('credential-defaults', device.assetId, value);
      await expect(history.pending(target, observation, [normal])).rejects.toThrow(
        'Malformed credential default history',
      );
      await expect(history.recordAccepted(target, normal, user, 'unsafe-run')).rejects.toThrow(
        'Malformed credential default history',
      );
      await expect(history.clear(target)).rejects.toThrow('Malformed credential default history');
      expect(await store.get('credential-defaults', device.assetId)).toEqual(value);
    }
  });
});
