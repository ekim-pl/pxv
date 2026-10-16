import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { writeFile } from 'node:fs/promises';
import {
  AndroidAdapter,
  ArtifactService,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  parseUsers,
  parseBackupObservation,
  parseNamedUsers,
  probeAdbServer,
  type AdbServerEndpoint,
} from '../../packages/adapters/src/index.js';
import {
  evaluateObservation,
  observationDigest,
  type AndroidUserIdentity,
  type PolicyPack,
  type RecoveryObligation,
  type SelectedTarget,
} from '@pxv/contracts';

const user: AndroidUserIdentity = { userId: 10, serialNo: 42, name: 'work' };
const target: SelectedTarget = {
  device: {
    assetId: 'all',
    kind: 'pixel',
    canonicalSerial: 'PIXEL123',
    model: 'Pixel 8a',
    codename: 'akita',
    transports: [
      { kind: 'usb', serial: 'PIXEL123' },
      { kind: 'wifi', serial: '192.0.2.2:5555' },
    ],
    groups: [],
  },
  transport: { kind: 'usb', serial: 'PIXEL123' },
};
const policy: PolicyPack = {
  schemaVersion: 1,
  id: 'test',
  version: '1.0.0',
  name: 'Test',
  capabilities: [],
  repositories: [],
  profiles: [
    {
      id: 'work',
      name: 'work',
      kind: 'secondary',
      packages: [
        {
          packageId: 'org.example.app',
          versionCode: 1,
          sha256: 'a'.repeat(64),
          signerSha256: 'b'.repeat(64),
          path: 'fixture.apk',
        },
      ],
      settings: [],
      permissions: [{ packageId: 'org.example.app', permission: 'android.permission.CAMERA', granted: true }],
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    },
    {
      id: 'owner',
      name: 'Owner',
      kind: 'owner',
      packages: [],
      settings: [],
      permissions: [],
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    },
  ],
};
const decode = (arg: string): string =>
  arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg;
class FakeRunner implements CommandRunner {
  serialNo = 42;
  version = 1;
  extraUser = false;
  extraSerialNo = 99;
  createdName: string | undefined;
  helperInstalled = false;
  helperUserId: number | undefined;
  shutdownResult: CommandResult = { code: 0, stdout: '', stderr: '' };
  shutdownRequested = false;
  shutdownListing: CommandResult | undefined;
  onShutdown: (() => void) | undefined;
  wifiShutdownCode = 0;
  granted = true;
  hardware = 'PIXEL123';
  failedListing = false;
  mutations: string[][] = [];
  calls: { args: string[]; options?: CommandOptions }[] = [];
  values = new Map([
    ['secure:always_on_vpn_app', 'null'],
    ['secure:always_on_vpn_lockdown', 'null'],
    ['global:adb_enabled', '1'],
    ['global:adb_wifi_enabled', '0'],
  ]);
  async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ args, ...(options ? { options } : {}) });
    if (options?.mutation) this.mutations.push(args);
    const result = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: '' });
    if (args.includes('pull')) {
      await writeFile(args.at(-1) ?? '', 'fixture apk');
      return result('pulled');
    }
    if (args.includes('install')) {
      this.version = 2;
      return result('Success\n');
    }
    if (args.includes('devices'))
      return this.shutdownRequested && this.shutdownListing
        ? this.shutdownListing
        : result(
            'List of devices attached\nPIXEL123 device product:akita\n192.0.2.2:5555 device product:akita\n',
          );
    const shell = args.indexOf('shell');
    const command = args.slice(shell + 1).map(decode);
    if (command[0] === 'getprop') {
      const properties: Record<string, string> = {
        'ro.serialno': this.hardware,
        'ro.product.model': 'Pixel 8a',
        'ro.product.device': 'akita',
        'ro.build.version.incremental': '2026100600',
        'ro.boot.verifiedbootstate': 'yellow',
        'ro.boot.flash.locked': '1',
        'ro.boot.vbmeta.device_state': 'locked',
        'ro.build.fingerprint': 'test/fingerprint',
        'ro.build.version.sdk': '35',
        'ro.product.cpu.abilist': 'arm64-v8a,armeabi-v7a',
      };
      return result(`${properties[command[1] ?? ''] ?? ''}\n`);
    }
    if (command[0] === 'bmgr')
      return result(
        command.at(-1) === 'enabled'
          ? 'Backup Manager currently enabled\n'
          : '* com.stevesoltys.seedvault/.transport.ConfigurableBackupTransport\n',
      );
    if (command.join(' ') === 'cmd user list -v')
      return result(
        `Users:\n UserInfo{0:Owner:c13} serialNo=0 isPrimary=true\n UserInfo{10:work:10} serialNo=${this.serialNo}\n${this.extraUser ? ` UserInfo{11:private:10} serialNo=${this.extraSerialNo}\n` : ''}${this.createdName ? ` UserInfo{12:${this.createdName}:10} serialNo=55\n` : ''}`,
      );
    if (command.slice(0, 2).join(' ') === 'pm create-user') {
      this.createdName = command[2];
      return result('Success: created user id 12\n');
    }
    if (command.slice(0, 2).join(' ') === 'pm grant') {
      this.granted = true;
      return result('');
    }
    if (command.slice(0, 2).join(' ') === 'pm revoke') {
      this.granted = false;
      return result('');
    }
    if (command.slice(0, 2).join(' ') === 'pm uninstall') {
      this.helperInstalled = false;
      return result('Success\n');
    }
    if (command.slice(0, 3).join(' ') === 'pm list packages')
      return this.failedListing
        ? result('', 1)
        : result(
            `package:android\npackage:org.example.app\n${this.helperInstalled && (this.helperUserId === undefined || Number(command[command.indexOf('--user') + 1]) === this.helperUserId) ? 'package:org.pxv.probe\n' : ''}`,
          );
    if (command.slice(0, 2).join(' ') === 'pm path')
      return result('package:/data/app/~~X/org.example.app-Y/base.apk\n');
    if (command[0] === 'dumpsys')
      return result(
        `Packages:\n User 0: ceDataInode=0 installed=false\n User 10: ceDataInode=1 installed=true\n  runtime permissions:\n   android.permission.CAMERA: granted=${String(this.granted)}, flags=[]\n`,
      );
    if (command.slice(0, 3).join(' ') === 'cmd package resolve-activity')
      return result('org.example.app/.Main\n');
    if (command.slice(0, 2).join(' ') === 'am start') return result('Starting: intent\n');
    if (command[0] === 'rm' || command[0] === 'test') return result('');
    if (command[0] === 'settings') {
      const get = command.indexOf('get');
      const put = command.indexOf('put');
      const deletion = command.indexOf('delete');
      if (get >= 0)
        return result(`${this.values.get(`${command[get + 1]}:${command[get + 2]}`) ?? 'null'}\n`);
      if (put >= 0) {
        if (command[put + 2] === 'adb_wifi_enabled' && this.wifiShutdownCode !== 0)
          return result('', this.wifiShutdownCode);
        this.values.set(`${command[put + 1]}:${command[put + 2]}`, command[put + 3] ?? '');
        if (command[put + 2] === 'adb_enabled' && command[put + 3] === '0') {
          this.shutdownRequested = true;
          this.onShutdown?.();
          return this.shutdownResult;
        }
      }
      if (deletion >= 0) this.values.delete(`${command[deletion + 1]}:${command[deletion + 2]}`);
      return result('');
    }
    throw new Error(`Unexpected test command: ${command.join(' ')}`);
  }
}
let server: Server;
let endpoint: AdbServerEndpoint;
let serverAvailable = true;
beforeAll(async () => {
  server = createServer((socket) =>
    socket.once('data', (data) => {
      if (serverAvailable && data.toString() === '000chost:version') socket.write('OKAY00040029');
      else socket.end('FAIL');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  endpoint = { host: '127.0.0.1', port: address.port };
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
function adapter(runner: FakeRunner): AndroidAdapter {
  const artifacts = new ArtifactService({ runner });
  artifacts.identity = () =>
    Promise.resolve({
      packageId: 'org.example.app',
      versionCode: runner.version,
      signerSha256: 'b'.repeat(64),
    });
  artifacts.withStaged = (artifact, action) => action(artifact);
  artifacts.checkCompatibility = () => Promise.resolve();
  return new AndroidAdapter({ runner, artifacts, adbServer: endpoint });
}
describe('identity-bound Android adapter', () => {
  it('binds modern GrapheneOS named users to redacted dumpsys serial identities', async () => {
    const names =
      '2 users:\n0: id=0, name=Właściciel, type=full.SYSTEM, flags=ADMIN|INITIALIZED\n1: id=10, name=Kontakty, type=full.SECONDARY, flags=INITIALIZED\n';
    const identities =
      'Users:\n UserInfo{0:null:4c13} serialNo=0 isPrimary=true\n UserInfo{10:null:410} serialNo=42\n';
    expect(parseNamedUsers(names)).toEqual([
      { userId: 0, name: 'Właściciel' },
      { userId: 10, name: 'Kontakty' },
    ]);
    const android = adapter(new FakeRunner());
    const output = [names, identities, names, identities];
    android.shell = () => Promise.resolve(output.shift() ?? '');
    expect(await android.users(target)).toEqual([
      { userId: 0, serialNo: 0, name: 'Właściciel' },
      { userId: 10, serialNo: 42, name: 'Kontakty' },
    ]);
    expect(output).toHaveLength(0);
    const recreated = [names, identities, names, identities.replace('serialNo=42', 'serialNo=43')];
    android.shell = () => Promise.resolve(recreated.shift() ?? '');
    await expect(android.users(target)).rejects.toThrow(/changed while binding/);
    const incomplete = [
      names,
      identities.replace('UserInfo{10:null:410} serialNo=42', ''),
      names,
      identities.replace('UserInfo{10:null:410} serialNo=42', ''),
    ];
    android.shell = () => Promise.resolve(incomplete.shift() ?? '');
    await expect(android.users(target)).rejects.toThrow(/changed while binding/);
    expect(() => parseNamedUsers(names.replace('name=Kontakty', 'name=null'))).toThrow(/names could not/);
  });
  it('refuses invalid transport bindings, malformed VPN state and unsafe mutation inputs', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    await expect(
      android.guardTarget({ ...target, transport: { kind: 'usb', serial: 'UNENROLLED' } }),
    ).rejects.toThrow(/not enrolled/);
    await expect(
      android.guardTarget({
        device: { ...target.device, canonicalSerial: '192.0.2.1:5555' },
        transport: target.transport,
      }),
    ).rejects.toThrow(/canonical USB/);
    runner.values.set('secure:always_on_vpn_lockdown', 'invalid');
    await expect(android.vpn(target, user)).rejects.toThrow(/malformed/);
    runner.values.set('secure:always_on_vpn_lockdown', '0');
    await expect(
      android.applySetting(target, user, { namespace: 'secure', key: 'bad key', value: 'x' }, { lease: {} }),
    ).rejects.toThrow(/setting key/);
    await expect(
      android.applySetting(
        target,
        user,
        { namespace: 'secure', key: 'key', value: 'x'.repeat(4097) },
        { lease: {} },
      ),
    ).rejects.toThrow(/Invalid/);
    await expect(
      android.applyPermission(
        target,
        user,
        { packageId: 'org.example.app', permission: 'invalid', granted: true },
        { lease: {} },
      ),
    ).rejects.toThrow(/runtime permission/);
    await expect(
      android.applyVpn(
        target,
        user,
        { packageId: 'org.uninstalled.app', alwaysOn: true, lockdown: true },
        { lease: {} },
      ),
    ).rejects.toThrow(/Install and configure/);
    expect(runner.mutations).toHaveLength(0);
  });
  it('measures backup enablement and selected transport without asserting restore acceptance', async () => {
    expect(parseBackupObservation('Backup Manager currently disabled', 'No transports available.')).toEqual({
      enabled: false,
      transportPackage: null,
    });
    expect(() => parseBackupObservation('Unknown', 'No transports available.')).toThrow(/enablement/);
    expect(() =>
      parseBackupObservation(
        'Backup Manager currently enabled',
        '* org.first/.Transport\n* org.second/.Transport',
      ),
    ).toThrow(/ambiguous/);
    expect(() =>
      parseBackupObservation('Backup Manager currently enabled', 'User 10 is not running'),
    ).toThrow(/transports/);
    const configured: PolicyPack = {
      ...policy,
      profiles: policy.profiles.map((profile) =>
        profile.id === 'work'
          ? { ...profile, backup: { enabled: true, transportPackage: 'com.stevesoltys.seedvault' } }
          : profile,
      ),
    };
    const observation = await adapter(new FakeRunner()).inspect(target, configured);
    expect(observation.profiles[0]?.backup).toEqual({
      enabled: true,
      transportPackage: 'com.stevesoltys.seedvault',
    });
  });
  it('requires stable Android serial numbers and rejects ambiguous or truncated users', () => {
    expect(parseUsers('UserInfo{0:Owner:c13} serialNo=0\nUserInfo{10:work:10} serialNo=42')).toEqual([
      { userId: 0, name: 'Owner', serialNo: 0 },
      user,
    ]);
    expect(() => parseUsers('UserInfo{0:Owner:c13}')).toThrow(/serial identity/);
    expect(() => parseUsers('UserInfo{0:Owner:c13} serialNo=0\nUserInfo{10:work:10} serialNo=0')).toThrow(
      /ambiguous/,
    );
  });
  it('blocks cleanup after an ID and name are reused by a new Android user', async () => {
    const runner = new FakeRunner();
    runner.serialNo = 43;
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'cleanup',
      operationId: 'parent',
      ownerOperationId: 'parent/probe',
      deviceSerial: 'PIXEL123',
      user,
      kind: 'restore-setting',
      resource: 'awake',
      payload: { namespace: 'global', key: 'stay_on_while_plugged_in', previous: '0' },
      status: 'pending',
    };
    await expect(
      adapter(runner).cleanup(target, obligation, { lease: {}, operationId: 'parent/probe' }),
    ).rejects.toMatchObject({ code: 'USER_IDENTITY_CHANGED' });
    expect(runner.mutations).toHaveLength(0);
  });
  it('never releases a parent resource during child cleanup', async () => {
    const runner = new FakeRunner();
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'awake',
      operationId: 'parent',
      ownerOperationId: 'parent',
      deviceSerial: 'PIXEL123',
      user,
      kind: 'restore-setting',
      resource: 'awake',
      payload: { namespace: 'global', key: 'stay_on_while_plugged_in', previous: '0' },
      status: 'pending',
    };
    await expect(
      adapter(runner).cleanup(target, obligation, { lease: {}, operationId: 'parent/probe' }),
    ).rejects.toThrow(/scope/);
    expect(runner.mutations).toHaveLength(0);
  });
  it('reviews every live Android user before a shared APK upgrade, including users outside the policy', async () => {
    const runner = new FakeRunner();
    runner.extraUser = true;
    const android = adapter(runner);
    const artifact = {
      path: '/reviewed.apk',
      packageId: 'org.example.app',
      versionCode: 2,
      signerSha256: 'b'.repeat(64),
      sha256: 'a'.repeat(64),
    };
    const effects = await android.inspectSharedEffects(target, [artifact.packageId]);
    const effect = effects[0];
    if (!effect) throw new Error('No effects');
    expect(effect.users.map((entry) => entry.user.name)).toEqual(['Owner', 'work', 'private']);
    await expect(android.install(target, user, artifact, { lease: {} })).rejects.toMatchObject({
      code: 'SHARED_APK_REVIEW_REQUIRED',
    });
    expect(runner.mutations).toHaveLength(0);
    const reviewed = { ...effect, toVersionCode: 2 };
    runner.extraSerialNo = 100;
    await expect(
      android.install(target, user, artifact, { lease: {}, reviewedDeviceWideEffect: reviewed }),
    ).rejects.toMatchObject({ code: 'SHARED_APK_REVIEW_REQUIRED' });
    expect(runner.mutations).toHaveLength(0);
    runner.extraSerialNo = 99;
    await android.install(target, user, artifact, { lease: {}, reviewedDeviceWideEffect: reviewed });
    expect(runner.mutations).toHaveLength(1);
  });
  it('includes measured runtime permission revocation in the shared observation digest', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const before = await android.inspect(target, policy);
    runner.granted = false;
    const after = await android.inspect(target, policy);
    expect(before.profiles[0]?.permissions[0]?.granted).toBe(true);
    expect(after.profiles[0]?.permissions[0]?.granted).toBe(false);
    expect(observationDigest(after)).not.toBe(observationDigest(before));
    expect(evaluateObservation(policy, after).passed).toBe(false);
    expect(runner.mutations).toHaveLength(0);
  });
  it('blocks handoff for helpers in an unselected Android user with its stable serial identity', async () => {
    const runner = new FakeRunner();
    runner.extraUser = true;
    runner.helperInstalled = true;
    runner.helperUserId = 11;
    const android = adapter(runner);
    const observed = await android.inspect(target, policy);
    expect(observed.profiles.map((profile) => profile.user.userId).sort()).toEqual([0, 10]);
    expect(observed.helpers).toEqual(['org.pxv.probe@user:11:serial:99']);
    // The stable helper owner is included in the same evidence checked by finalization.
    const before = observationDigest(observed);
    runner.extraSerialNo = 100;
    const changed = await android.inspect(target, policy);
    expect(changed.helpers).toEqual(['org.pxv.probe@user:11:serial:100']);
    expect(observationDigest(changed)).not.toBe(before);
    runner.helperInstalled = false;
    expect((await android.inspect(target, policy)).helpers).toEqual([]);
    expect(runner.mutations).toHaveLength(0);
  });
  it('creates arbitrary secondary profiles and records Android-assigned stable identity', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    expect(
      await android.createUser(target, { id: 'owner', name: 'Owner', kind: 'owner' }, { lease: {} }),
    ).toEqual({ userId: 0, serialNo: 0, name: 'Owner' });
    await expect(
      android.createUser(target, { id: 'duplicate', name: 'work', kind: 'secondary' }, { lease: {} }),
    ).rejects.toThrow(/already has/);
    const created = await android.createUser(
      target,
      { id: 'personal', name: 'Personal Account', kind: 'secondary' },
      { lease: {} },
    );
    expect(created).toEqual({ userId: 12, serialNo: 55, name: 'Personal Account' });
    await expect(
      android.createUser(target, { id: 'unsafe', name: 'bad:name', kind: 'secondary' }, { lease: {} }),
    ).rejects.toThrow(/Invalid/);
  });
  it('applies and remeasures settings, permissions and VPN configuration through the guarded service', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const profile = policy.profiles[0];
    if (!profile) throw new Error('Missing profile');
    await android.applySettings(
      target,
      user,
      {
        ...profile,
        settings: [{ namespace: 'system', key: 'screen_off_timeout', value: '30000' }],
        vpn: { packageId: 'org.example.app', alwaysOn: true, lockdown: true },
      },
      { lease: {} },
    );
    expect(await android.vpn(target, user)).toEqual({
      packageId: 'org.example.app',
      alwaysOn: true,
      lockdown: true,
    });
    const permission = profile.permissions[0];
    if (!permission) throw new Error('Missing permission');
    await android.applyPermission(target, user, { ...permission, granted: false }, { lease: {} });
    expect(runner.granted).toBe(false);
    await expect(
      android.applyVpn(target, user, { packageId: null, alwaysOn: false, lockdown: true }, { lease: {} }),
    ).rejects.toThrow(/Inconsistent/);
  });
  it('restores settings and deletes absent old values only for the recorded stable user', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'restore',
      operationId: 'run',
      ownerOperationId: 'run',
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'restore-setting',
      resource: 'setting',
      payload: { namespace: 'secure', key: 'test_key', previous: 'old-value' },
      status: 'pending',
    };
    await android.cleanup(target, obligation, { lease: {}, operationId: 'run' });
    expect(runner.values.get('secure:test_key')).toBe('old-value');
    await android.cleanup(
      target,
      { ...obligation, payload: { ...obligation.payload, previous: 'null' } },
      { lease: {}, operationId: 'run' },
    );
    expect(runner.values.has('secure:test_key')).toBe(false);
    await expect(
      android.cleanup(target, { ...obligation, kind: 'unknown' }, { lease: {}, operationId: 'run' }),
    ).rejects.toThrow(/Unknown cleanup/);
  });
  it('removes temporary private imports only inside the recorded user and proves their absence', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const path = '/storage/emulated/10/Download/pxv-import-4c2b3aab-1b6e-4ad6-a326-359ee320c7e5.conf';
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'file',
      operationId: 'run',
      ownerOperationId: 'run/recipe',
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'remove-file',
      resource: path,
      payload: { path },
      status: 'pending',
    };
    await android.cleanup(target, obligation, { lease: {}, operationId: 'run/recipe' });
    expect(runner.mutations).toHaveLength(1);
    await expect(
      android.cleanup(
        target,
        { ...obligation, payload: { path: path.replace('/10/', '/11/') } },
        { lease: {}, operationId: 'run/recipe' },
      ),
    ).rejects.toThrow(/outside the recorded user/);
    expect(runner.mutations).toHaveLength(1);
  });
  it('verifies helper identity before removal and disables debugging through the explicit final step', async () => {
    const runner = new FakeRunner();
    runner.helperInstalled = true;
    const android = adapter(runner);
    android.installedIdentity = (_target, _user, packageId) =>
      Promise.resolve({ packageId, versionCode: 1, signerSha256: 'b'.repeat(64) });
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'helper',
      operationId: 'run',
      ownerOperationId: 'run/probe',
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'remove-helper',
      resource: 'helper',
      payload: { packageId: 'org.pxv.probe', versionCode: 1, signerSha256: 'b'.repeat(64) },
      status: 'pending',
    };
    await expect(
      android.cleanup(
        target,
        { ...obligation, payload: { ...obligation.payload, versionCode: 2 } },
        { lease: {}, operationId: 'run/probe' },
      ),
    ).rejects.toThrow(/identity changed/);
    expect(runner.helperInstalled).toBe(true);
    await android.cleanup(target, obligation, { lease: {}, operationId: 'run/probe' });
    expect(runner.helperInstalled).toBe(false);
    await android.cleanup(target, obligation, { lease: {}, operationId: 'run/probe' });
    await android.launch(target, user, 'org.example.app', { lease: {} });
    await android.finalize(target, { lease: {} });
    expect(runner.values.get('global:adb_enabled')).toBe('0');
    expect(runner.values.get('global:adb_wifi_enabled')).toBe('0');
  });
  it('treats inspection failure as an error instead of reporting absent packages', async () => {
    const runner = new FakeRunner();
    runner.failedListing = true;
    await expect(adapter(runner).inspect(target, policy)).rejects.toThrow(/failed/);
    expect(runner.mutations).toHaveLength(0);
  });
  it.each(['', 'PIXEL123 offline\n'])(
    'accepts only the final code255 closure after the selected transport is absent/offline: %s',
    async (row) => {
      const runner = new FakeRunner();
      runner.shutdownResult = { code: 255, stdout: '', stderr: row ? 'adb: error: closed\n' : '' };
      runner.shutdownListing = {
        code: 0,
        stdout: `List of devices attached\nOTHERPHONE device product:akita\n${row}`,
        stderr: '',
      };
      await adapter(runner).finalize(target, { lease: {} });
      expect(runner.mutations).toHaveLength(2);
      const shutdown = runner.calls.find(
        (call) => call.args.includes("'adb_enabled'") && call.options?.mutation,
      );
      expect(shutdown?.options).toMatchObject({ check: false, expectedExitCodes: [0, 255], mutation: true });
      expect(runner.shutdownResult.code).toBe(255);
      expect(runner.calls.at(-1)?.args.slice(-2)).toEqual(['devices', '-l']);
    },
  );
  it.each([
    { code: 0, stdout: 'List of devices attached\nPIXEL123 device product:akita\n', stderr: '' },
    { code: 0, stdout: 'List of devices attached\nPIXEL123 unauthorized\n', stderr: '' },
    { code: 0, stdout: 'List of devices attached\nPIXEL123 offline\nPIXEL123 offline\n', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: 'garbled listing\n', stderr: '' },
    { code: 0, stdout: 'List of devices attached\nmalformed\n', stderr: '' },
    { code: 0, stdout: 'List of devices attached\n', stderr: 'daemon restarted' },
    { code: 1, stdout: 'List of devices attached\n', stderr: 'transport inspection failed' },
  ])(
    'preserves uncertainty when code255 cannot prove the selected transport disconnected: %j',
    async (listing) => {
      const runner = new FakeRunner();
      runner.shutdownResult = { code: 255, stdout: '', stderr: '' };
      runner.shutdownListing = listing;
      await expect(adapter(runner).finalize(target, { lease: {} })).rejects.toMatchObject({
        code: 'MUTATION_UNCERTAIN',
      });
      expect(runner.mutations).toHaveLength(2);
    },
  );
  it.each([
    { code: 1, stdout: '', stderr: 'adb: error: closed' },
    { code: 124, stdout: '', stderr: '' },
    { code: 255, stdout: 'Security exception: permission denied', stderr: '' },
    { code: 255, stdout: '', stderr: 'error: device unauthorized' },
    { code: 255, stdout: '', stderr: 'adb: device PIXEL123 not found' },
    { code: 255, stdout: '', stderr: 'Permission denied' },
  ])('does not accept failed, interrupted or pre-command shutdown results: %j', async (result) => {
    const runner = new FakeRunner();
    runner.shutdownResult = result;
    runner.shutdownListing = { code: 0, stdout: 'List of devices attached\n', stderr: '' };
    await expect(adapter(runner).finalize(target, { lease: {} })).rejects.toMatchObject({
      code: 'MUTATION_UNCERTAIN',
    });
    expect(runner.mutations).toHaveLength(2);
    expect(runner.calls.at(-1)?.options?.mutation).toBe(true);
  });
  it('does not accept a disconnect after cancellation, loss of the existing server or failed wireless shutdown', async () => {
    const runner = new FakeRunner();
    const controller = new AbortController();
    runner.shutdownResult = { code: 255, stdout: '', stderr: '' };
    runner.onShutdown = () => controller.abort(new Error('shutdown cancelled'));
    await expect(adapter(runner).finalize(target, { lease: {}, signal: controller.signal })).rejects.toThrow(
      'shutdown cancelled',
    );
    expect(runner.mutations).toHaveLength(2);
    const before = new FakeRunner();
    await expect(adapter(before).finalize(target, { lease: {}, signal: controller.signal })).rejects.toThrow(
      'shutdown cancelled',
    );
    expect(before.mutations).toHaveLength(0);
    const unavailable = new FakeRunner();
    unavailable.shutdownResult = { code: 255, stdout: '', stderr: '' };
    unavailable.onShutdown = () => {
      serverAvailable = false;
    };
    try {
      await expect(adapter(unavailable).finalize(target, { lease: {} })).rejects.toMatchObject({
        code: 'ADB_SERVER_UNAVAILABLE',
      });
      expect(unavailable.mutations).toHaveLength(2);
    } finally {
      serverAvailable = true;
    }
    const wireless = new FakeRunner();
    wireless.wifiShutdownCode = 255;
    await expect(adapter(wireless).finalize(target, { lease: {} })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(wireless.shutdownRequested).toBe(false);
    expect(wireless.mutations).toHaveLength(1);
  });
  it('binds wireless endpoints to the enrolled physical USB identity', async () => {
    const runner = new FakeRunner();
    runner.hardware = 'OTHERPHONE';
    const wifi = { ...target, transport: target.device.transports[1] ?? target.transport };
    await expect(adapter(runner).guardTarget(wifi)).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });
  it('quotes Android remote-shell values and uses the external ADB server explicitly', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const value = "custom'$(danger)";
    await android.applySetting(target, user, { namespace: 'secure', key: 'test_key', value }, { lease: {} });
    const mutation = runner.calls.find((call) => call.options?.mutation);
    expect(mutation?.args).toContain("'custom'\\''$(danger)'");
    expect(mutation?.args.slice(0, 5)).toEqual(['adb', '-H', endpoint.host, '-P', String(endpoint.port)]);
    expect(mutation?.options?.env?.['ANDROID_ADB_SERVER_ADDRESS']).toBe(endpoint.host);
    expect(mutation?.options?.env).not.toHaveProperty('NPM_TOKEN');
  });
  it('keeps language setup manual without an accepted adapter and never activates duress', async () => {
    const runner = new FakeRunner();
    const result = await adapter(runner).setupLanguage(target, user, 'pl-PL', { lease: {} });
    expect(result.status).toBe('manual-pending');
    expect(runner.mutations).toHaveLength(0);
  });
  it('refuses all clients when the configured ADB server is lost', async () => {
    await expect(probeAdbServer({ host: '127.0.0.1', port: 1 })).rejects.toMatchObject({
      code: 'ADB_SERVER_UNAVAILABLE',
    });
    const runner = new FakeRunner();
    const android = new AndroidAdapter({ runner, adbServer: { host: '127.0.0.1', port: 1 } });
    await expect(android.guardTarget(target)).rejects.toThrow(/server is unavailable/);
    expect(runner.calls).toHaveLength(0);
  });
});
