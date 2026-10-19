import { AndroidAdapter, SESSION_PACKAGE, SESSION_SIGNER } from '@pxv/adapters';
import { vi } from '../test-api.js';
import { mockOblivionAndroid } from './oblivion-fixture.js';

export const sessionId = '05' + 'a'.repeat(64);
export const secondSessionId = '05' + 'b'.repeat(64);
export const firstNumber = '+48111222333';
export const secondNumber = '+48222333444';
export const subscriptions = (number = firstNumber, second = secondNumber) =>
  `SubscriptionManagerService:\nActive subscriptions:\n  [SubscriptionInfoInternal: id=1 simSlotIndex=0 isEmbedded=false number=${number} dataRoaming=0]\n  [SubscriptionInfoInternal: id=2 simSlotIndex=1 isEmbedded=true number=${second} dataRoaming=0]\nAll subscriptions:\n  [SubscriptionInfoInternal: id=3 simSlotIndex=-1 number=+48999999999 dataRoaming=0]\n`;
export const sessionXml = (settings: boolean, user = 0) =>
  '<?xml version="1.0"?><hierarchy><node package="' +
  SESSION_PACKAGE +
  '" enabled="true" password="false" bounds="[0,0][20,20]" content-desc="' +
  (settings ? 'Account ID' : 'User settings') +
  '" text="' +
  (settings ? (user === 0 ? sessionId : secondSessionId) : '') +
  '"/></hierarchy>';

export function mockCollectionAndroid(name: 'oblivion' | 'sessionid' | 'simcards') {
  const simulation = mockOblivionAndroid();
  const state = Object.assign(simulation.state, { settings: false, subscriptions: subscriptions() });
  const baseShell = simulation.shell.getMockImplementation()!;
  if (name === 'sessionid') {
    state.signer = SESSION_SIGNER;
    vi.spyOn(AndroidAdapter.prototype, 'listPackages').mockImplementation((_target, user) =>
      Promise.resolve(new Set(state.absent.has(user.userId) ? [] : [SESSION_PACKAGE])),
    );
    vi.spyOn(AndroidAdapter.prototype, 'installedIdentity').mockImplementation(() =>
      Promise.resolve({
        packageId: SESSION_PACKAGE,
        signerSha256: state.signer,
        versionCode: state.version,
      }),
    );
    vi.spyOn(AndroidAdapter.prototype, 'launch').mockImplementation(() => {
      state.settings = false;
      return Promise.resolve();
    });
  }
  simulation.shell.mockImplementation((target, args, options) => {
    if (args.join(' ') === 'dumpsys isub') return Promise.resolve(state.subscriptions);
    if (name !== 'sessionid') return baseShell(target, args, options);
    if (args.join(' ') === 'dumpsys window windows')
      return Promise.resolve(
        `mCurrentFocus=Window{abc u${state.current} ${SESSION_PACKAGE}/org.thoughtcrime.securesms.preferences.${state.settings ? 'Settings' : 'Home'}Activity}`,
      );
    if (args[0] === 'uiautomator') {
      if (state.failRead) throw new Error(sessionId);
      return Promise.resolve(state.mainXml ?? sessionXml(state.settings, state.current));
    }
    if (args[0] === 'input') {
      state.settings = true;
      if (state.changeVersion) state.version++;
      return Promise.resolve('');
    }
    return baseShell(target, args, options);
  });
  return { ...simulation, state };
}
