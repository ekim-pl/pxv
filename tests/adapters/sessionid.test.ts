import { readSessionAccountId } from '../../packages/adapters/src/sessionid-ui.js';
import { afterEach, describe, expect, it, vi } from '../test-api.js';
import { AndroidAdapter, collectSessionIds, normalizeSessionId, parseUiSnapshot } from '@pxv/adapters';
import type { RecoveryObligation } from '@pxv/contracts';
import { device } from '../contracts/fixtures.js';
import { obligationWriter } from './obligations.js';
import { oblivionUsers } from './oblivion-fixture.js';
import { mockCollectionAndroid, sessionId, secondSessionId, sessionXml } from './collection-fixture.js';

const target = { device, transport: device.transports[0]! };
const profiles = oblivionUsers.map((user, index) => ({ profileId: index ? 'work' : 'admin', user }));
function options() {
  const retained: RecoveryObligation[] = [];
  return {
    retained,
    lease: {},
    unlock: () => Promise.resolve(),
    obligations: obligationWriter(
      'session-test',
      (entry) => {
        retained.push(entry);
        return Promise.resolve();
      },
      (id) => {
        retained.find((entry) => entry.id === id)!.status = 'resolved';
        return Promise.resolve();
      },
    ),
  };
}
const android = () =>
  new AndroidAdapter({ runner: { run: () => Promise.reject(new Error('Unexpected process')) } });
afterEach(() => vi.restoreAllMocks());

describe('private Session account collection', () => {
  it('reads only a unique own-account field and validates normal account IDs', () => {
    const nodes = parseUiSnapshot(sessionXml(true));
    expect(readSessionAccountId(nodes)).toBe(sessionId);
    expect(normalizeSessionId(sessionId.toUpperCase())).toBe(sessionId);
    expect(normalizeSessionId('07' + 'a'.repeat(64))).toBeUndefined();
    expect(() => readSessionAccountId([...nodes, ...nodes])).toThrow('ambiguous');
    expect(() => readSessionAccountId(parseUiSnapshot(sessionXml(false)))).toThrow('missing');
    expect(() =>
      readSessionAccountId(parseUiSnapshot(sessionXml(true).replace('Account ID', 'Contact ID'))),
    ).toThrow();
  });
  it('visits enrolled installations, reads settings and restores the original profile', async () => {
    const { state } = mockCollectionAndroid('sessionid');
    const opts = options();
    const result = await collectSessionIds(android(), target, profiles, opts);
    expect(result.map((entry) => entry.value)).toEqual([sessionId, secondSessionId]);
    expect(state.current).toBe(0);
    expect(opts.retained[0]?.kind).toBe('collection-foreground');
    expect(opts.retained[0]?.status).toBe('resolved');
    expect(JSON.stringify(opts.retained)).not.toContain(sessionId);
  });
  it('skips absent apps and offers private entry or an explicit skip on unsupported UI', async () => {
    const { state } = mockCollectionAndroid('sessionid');
    state.absent.add(10);
    state.failRead = true;
    const manual = vi.fn(() => Promise.resolve(sessionId));
    const result = await collectSessionIds(android(), target, profiles, { ...options(), manual });
    expect(result[0]).toMatchObject({ value: sessionId, manual: true, status: 'collected' });
    expect(result[1]?.status).toBe('not-present');
    expect(manual).toHaveBeenCalledExactlyOnceWith('admin');
    const skipped = await collectSessionIds(android(), target, profiles, {
      ...options(),
      manual: () => Promise.resolve(undefined),
    });
    expect(skipped[0]?.status).toBe('skipped');
  });
  for (const failure of ['signer', 'version', 'locked', 'identity', 'cancel'] as const) {
    it(`rejects ${failure} changes without leaking account data`, async () => {
      const { state } = mockCollectionAndroid('sessionid');
      const opts = options();
      if (failure === 'signer') state.signer = 'f'.repeat(64);
      if (failure === 'version') state.changeVersion = true;
      if (failure === 'locked') state.screenLocked = true;
      if (failure === 'identity') state.users[1]!.serialNo++;
      if (failure === 'cancel') opts.unlock = () => Promise.reject(new Error(sessionId));
      await expect(collectSessionIds(android(), target, profiles, opts)).rejects.toMatchObject({
        code: 'SESSION_COLLECTION_FAILED',
      });
      expect(state.current).toBe(0);
      expect(JSON.stringify(opts.retained)).not.toContain(sessionId);
    });
  }
  it('retains recoverable foreground ownership if restoration fails', async () => {
    const { state } = mockCollectionAndroid('sessionid');
    state.failRestore = true;
    const opts = options();
    await expect(collectSessionIds(android(), target, profiles, opts)).rejects.toMatchObject({
      code: 'SESSION_RECOVERY_REQUIRED',
    });
    expect(opts.retained[0]?.status).toBe('pending');
  });
});
