import { vi } from '../test-api.js';
import { AndroidAdapter, OBLIVION_PACKAGE, OBLIVION_SIGNER } from '@pxv/adapters';
import { sameAndroidUser, type AndroidUserIdentity } from '@pxv/contracts';

export const oblivionUsers = [
  { userId: 0, serialNo: 0, name: 'Administrator' },
  { userId: 10, serialNo: 22, name: 'Work' },
];
export const syntheticOblivionKey = 'SYNTHETIC-OBLIVION-SECRET';
export function oblivionXml(dialog = false, key = syntheticOblivionKey): string {
  const node = (id: string, text: string, klass: string, bounds: string) =>
    `<node package="${OBLIVION_PACKAGE}" resource-id="${OBLIVION_PACKAGE}:id/${id}" text="${text}" class="android.widget.${klass}" enabled="true" password="false" bounds="${bounds}"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy>' +
    (dialog
      ? node('QRcontent', key, 'TextView', '[50,50][100,100]') +
        node('closeQrPopup', '', 'Button', '[20,20][40,40]')
      : node('idDisplay', key, 'TextView', '[50,50][100,100]') +
        node('qrButton', '', 'ImageButton', '[0,0][10,10]')) +
    '</hierarchy>'
  );
}

export function mockOblivionAndroid() {
  const state = {
    current: 0,
    dialog: false,
    absent: new Set<number>(),
    locked: false,
    screenLocked: false,
    signer: OBLIVION_SIGNER,
    version: 999,
    changeVersion: false,
    failRead: false,
    failRestore: false,
    mainXml: undefined as string | undefined,
    dialogXml: undefined as string | undefined,
    users: structuredClone(oblivionUsers),
  };
  vi.spyOn(AndroidAdapter.prototype, 'guardTarget').mockResolvedValue();
  vi.spyOn(AndroidAdapter.prototype, 'users').mockImplementation(() =>
    Promise.resolve(structuredClone(state.users)),
  );
  vi.spyOn(AndroidAdapter.prototype, 'guardUser').mockImplementation((_target, user) => {
    if (!state.users.some((entry) => sameAndroidUser(entry, user))) throw new Error('User identity changed');
    return Promise.resolve();
  });
  vi.spyOn(AndroidAdapter.prototype, 'listPackages').mockImplementation((_target, user) =>
    Promise.resolve(new Set(state.absent.has(user.userId) ? [] : [OBLIVION_PACKAGE])),
  );
  vi.spyOn(AndroidAdapter.prototype, 'installedIdentity').mockImplementation(() =>
    Promise.resolve({
      packageId: OBLIVION_PACKAGE,
      versionCode: state.version,
      signerSha256: state.signer,
    }),
  );
  vi.spyOn(AndroidAdapter.prototype, 'launch').mockImplementation(() => {
    state.dialog = false;
    return Promise.resolve();
  });
  const shell = vi.spyOn(AndroidAdapter.prototype, 'shell').mockImplementation((_target, args) => {
    if (args[0] === 'am') return Promise.resolve(am(args, state));
    if (args.join(' ') === 'dumpsys window windows')
      return Promise.resolve(`mCurrentFocus=Window{abc u${state.current} ${OBLIVION_PACKAGE}/.MainActivity}`);
    if (args.join(' ') === 'dumpsys window policy')
      return Promise.resolve(`mKeyguardShowing=${state.screenLocked}`);
    if (args[0] === 'uiautomator') {
      if (state.failRead)
        throw Object.assign(new Error(syntheticOblivionKey), { result: { stdout: syntheticOblivionKey } });
      return Promise.resolve(
        (state.dialog ? state.dialogXml : state.mainXml) ??
          oblivionXml(state.dialog, `${syntheticOblivionKey}-${state.current}`),
      );
    }
    if (args[0] === 'input' && args[1] === 'tap') {
      state.dialog = args[2] === '5';
      if (!state.dialog && state.changeVersion) state.version++;
      return Promise.resolve('');
    }
    throw new Error('Unexpected Android command');
  });
  return { state, shell };
}

function am(
  args: string[],
  state: { current: number; locked: boolean; failRestore: boolean; users: AndroidUserIdentity[] },
) {
  if (args[1] === 'get-current-user') return String(state.current);
  if (args[1] === 'get-started-user-state') return state.locked ? 'RUNNING_LOCKED' : 'RUNNING_UNLOCKED';
  if (args[1] === 'switch-user') {
    if (state.failRestore && state.current === 10 && args[2] === '0') throw new Error('Restore unavailable');
    state.current = Number(args[2]);
    return '';
  }
  throw new Error('Unexpected Android user command');
}
