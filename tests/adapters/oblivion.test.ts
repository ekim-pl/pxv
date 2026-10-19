import { afterEach, describe, expect, it, vi } from '../test-api.js';
import {
  AndroidAdapter,
  collectOblivionKeys,
  parseUiSnapshot,
  restoreOblivionForeground,
} from '@pxv/adapters';
import { readOblivionDialogKey } from '../../packages/adapters/src/oblivion-ui.js';
import type { RecoveryObligation, SelectedTarget } from '@pxv/contracts';
import { device } from '../contracts/fixtures.js';
import { oblivionUsers, syntheticOblivionKey, oblivionXml, mockOblivionAndroid } from './oblivion-fixture.js';
import { obligationWriter } from './obligations.js';

const target: SelectedTarget = { device, transport: device.transports[0]! };
const profiles = oblivionUsers.map((user, index) => ({ profileId: index ? 'work' : 'admin', user }));
const android = () =>
  new AndroidAdapter({ runner: { run: () => Promise.reject(new Error('Unexpected process')) } });
function options() {
  const retained: RecoveryObligation[] = [];
  const unlock = vi.fn<(_: string) => Promise<void>>(() => Promise.resolve());
  return {
    retained,
    unlock,
    lease: {},
    obligations: obligationWriter(
      'test-oblivion',
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
afterEach(() => vi.restoreAllMocks());

describe('Oblivion private UI extraction', () => {
  it('requires unique matching text fields and rejects malformed or changed hierarchies', () => {
    const main = parseUiSnapshot(oblivionXml());
    const dialog = parseUiSnapshot(oblivionXml(true));
    expect(readOblivionDialogKey(main, dialog)).toBe(syntheticOblivionKey);
    expect(() => readOblivionDialogKey([], dialog)).toThrow('missing');
    expect(() => readOblivionDialogKey(main, [...dialog, ...dialog])).toThrow('ambiguous');
    expect(() => readOblivionDialogKey(main, parseUiSnapshot(oblivionXml(true, 'DIFFERENT')))).toThrow(
      'do not match',
    );
    expect(() => readOblivionDialogKey(main, parseUiSnapshot(oblivionXml(true, 'BAD KEY')))).toThrow(
      'malformed',
    );
    expect(() =>
      readOblivionDialogKey(main, parseUiSnapshot(oblivionXml(true).replace('TextView', 'EditText'))),
    ).toThrow('malformed');
    expect(() => parseUiSnapshot('<!DOCTYPE x><hierarchy/>')).toThrow();
  });

  it('iterates enrolled profiles, reads any official-signed version and restores foreground without images', async () => {
    const { state, shell } = mockOblivionAndroid();
    const opts = options();
    const result = await collectOblivionKeys(android(), target, profiles, opts);
    expect(result.map((entry) => entry.key)).toEqual([
      `${syntheticOblivionKey}-0`,
      `${syntheticOblivionKey}-10`,
    ]);
    expect(opts.unlock.mock.calls.map((entry) => entry[0])).toEqual(['admin', 'work']);
    expect(state.current).toBe(0);
    expect(state.dialog).toBe(false);
    expect(opts.retained[0]?.status).toBe('resolved');
    expect(JSON.stringify(opts.retained)).not.toContain(syntheticOblivionKey);
    expect(shell.mock.calls.some(([, args]) => args.includes('screencap'))).toBe(false);
  });

  it('skips profiles without the app', async () => {
    const { state } = mockOblivionAndroid();
    state.absent.add(10);
    const opts = options();
    const result = await collectOblivionKeys(android(), target, profiles, opts);
    expect(result[1]?.key).toBeUndefined();
    expect(opts.unlock).toHaveBeenCalledExactlyOnceWith('admin');
  });
  it('rejects changed app versions and missing QR controls without retaining secrets', async () => {
    const { state } = mockOblivionAndroid();
    state.changeVersion = true;
    await expect(collectOblivionKeys(android(), target, profiles, options())).rejects.toMatchObject({
      code: 'OBLIVION_COLLECTION_FAILED',
    });
    state.changeVersion = false;
    state.mainXml = oblivionXml().replaceAll('qrButton', 'unrecognized');
    await expect(collectOblivionKeys(android(), target, profiles, options())).rejects.toMatchObject({
      code: 'OBLIVION_COLLECTION_FAILED',
    });
    state.mainXml = undefined;
    state.dialogXml = oblivionXml(true).replaceAll('closeQrPopup', 'unrecognized');
    await expect(collectOblivionKeys(android(), target, profiles, options())).rejects.toMatchObject({
      code: 'OBLIVION_COLLECTION_FAILED',
    });
    expect(state.current).toBe(0);
  });

  it('refuses an unidentified original foreground user before creating recovery state', async () => {
    const { state } = mockOblivionAndroid();
    state.current = 999;
    const opts = options();
    await expect(collectOblivionKeys(android(), target, profiles, opts)).rejects.toThrow(
      'cannot be identified',
    );
    expect(opts.retained).toEqual([]);
  });

  for (const failure of ['signer', 'locked', 'screenLocked', 'failRead', 'cancel', 'identity'] as const) {
    it(`sanitizes ${failure} failures and restores the original user`, async () => {
      const { state } = mockOblivionAndroid();
      const opts = options();
      if (failure === 'signer') state.signer = 'f'.repeat(64);
      else if (failure === 'cancel') opts.unlock.mockRejectedValue(new Error(syntheticOblivionKey));
      else if (failure === 'identity') state.users[1]!.serialNo++;
      else state[failure] = true;
      let thrown: unknown;
      try {
        await collectOblivionKeys(android(), target, profiles, opts);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'OBLIVION_COLLECTION_FAILED' });
      expect(String(thrown)).not.toContain(syntheticOblivionKey);
      expect(JSON.stringify(thrown)).not.toContain(syntheticOblivionKey);
      expect(state.current).toBe(0);
      expect(opts.retained[0]?.status).toBe('resolved');
    });
  }

  it('restores with a fresh cleanup signal after cancellation', async () => {
    const { state } = mockOblivionAndroid();
    const controller = new AbortController();
    const opts = options();
    opts.unlock.mockImplementation((profile) => {
      if (profile === 'work') controller.abort();
      return Promise.resolve();
    });
    await expect(
      collectOblivionKeys(android(), target, profiles, { ...opts, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'OBLIVION_COLLECTION_FAILED' });
    expect(state.current).toBe(0);
  });

  it('retains a typed obligation when restoration fails and supports inspected recovery', async () => {
    const { state } = mockOblivionAndroid();
    state.failRestore = true;
    const opts = options();
    const adapter = android();
    await expect(collectOblivionKeys(adapter, target, profiles, opts)).rejects.toMatchObject({
      code: 'OBLIVION_RECOVERY_REQUIRED',
    });
    expect(opts.retained[0]?.status).toBe('pending');
    state.failRestore = false;
    await restoreOblivionForeground(adapter, target, opts.retained[0]!, {
      lease: {},
      operationId: 'test-oblivion',
    });
    expect(state.current).toBe(0);
    await expect(
      restoreOblivionForeground(adapter, target, opts.retained[0]!, { lease: {}, operationId: 'other' }),
    ).rejects.toThrow('scope');
    const mismatched = { ...opts.retained[0]!, user: { ...oblivionUsers[0]!, serialNo: 9 } };
    await expect(
      restoreOblivionForeground(adapter, target, mismatched, { lease: {}, operationId: 'test-oblivion' }),
    ).rejects.toThrow('identity');
  });
});
