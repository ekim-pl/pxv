import { recordObligation } from '../engine/obligations.js';
import { afterAll, beforeAll, describe, expect, it, vi } from './../test-api.js';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceScope } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import {
  AndroidAdapter,
  ArtifactService,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  parseUsers,
  parseBackupObservation,
  parseNamedUsers,
  parsePrimaryLocale,
  probeAdbServer,
  type AdbServerEndpoint,
} from '../../packages/adapters/src/index.js';
import {
  evaluateObservation,
  effectiveProfileSettings,
  PIN_SCRAMBLING_KEY,
  observationDigest,
  type AndroidUserIdentity,
  type ExecutionPolicy,
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
const policy: ExecutionPolicy = {
  requiredAttestations: [],
  id: 'test',
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
  pinValues = new Map<number, string>();
  pinWrite: 'retain' | 'fail' | 'ignore' = 'retain';
  localeValues = new Map<number, string>();
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
      if (command.includes(PIN_SCRAMBLING_KEY)) {
        const userId = Number(command[command.indexOf('--user') + 1]);
        if (get >= 0) return result(`${this.pinValues.get(userId) ?? 'null'}\n`);
        if (put >= 0) {
          if (this.pinWrite === 'fail') return result('setting rejected', 1);
          if (this.pinWrite === 'retain') this.pinValues.set(userId, command[put + 3] ?? '');
        }
        return result('');
      }
      if (get >= 0 && command[get + 1] === 'system' && command[get + 2] === 'system_locales') {
        const value = this.localeValues.get(Number(command[command.indexOf('--user') + 1]));
        if (value !== undefined) return result(`${value}\n`);
      }
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
  artifacts.contentIdentity = async () => ({
    ...(await artifacts.identity('synthetic')),
    sha256: 'a'.repeat(64),
  });
  artifacts.withStaged = (artifact, action) => action(artifact);
  artifacts.checkCompatibility = () => Promise.resolve();
  return new AndroidAdapter({ runner, artifacts, adbServer: endpoint });
}
describe('per-profile primary PIN scrambling', () => {
  it('writes and observes independently for the owner and secondary Android user', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const configured = structuredClone(policy);
    configured.profiles[0]!.scramblePinLayout = true;
    configured.profiles[1]!.scramblePinLayout = false;
    const identities = [user, { userId: 0, serialNo: 0, name: 'Owner' }];
    for (const [index, profile] of configured.profiles.entries())
      await android.applySetting(target, identities[index]!, effectiveProfileSettings(profile)[0]!, {
        lease: {},
      });
    expect(runner.pinValues).toEqual(
      new Map([
        [10, '1'],
        [0, '0'],
      ]),
    );
    const measured = await android.inspect(target, configured);
    expect(measured.profiles.find((profile) => profile.profileId === 'work')?.settings).toContainEqual({
      namespace: 'secure',
      key: PIN_SCRAMBLING_KEY,
      value: '1',
    });
    expect(measured.profiles.find((profile) => profile.profileId === 'owner')?.settings).toContainEqual({
      namespace: 'secure',
      key: PIN_SCRAMBLING_KEY,
      value: '0',
    });
    expect(
      evaluateObservation(configured, measured)
        .checks.filter((check) => check.key.includes(PIN_SCRAMBLING_KEY))
        .every((check) => check.passed),
    ).toBe(true);
    const writes = runner.mutations
      .map((args) => args.map(decode))
      .filter((args) => args.includes(PIN_SCRAMBLING_KEY));
    expect(writes.map((args) => args.slice(args.indexOf('settings')))).toEqual([
      ['settings', '--user', '10', 'put', 'secure', PIN_SCRAMBLING_KEY, '1'],
      ['settings', '--user', '0', 'put', 'secure', PIN_SCRAMBLING_KEY, '0'],
    ]);
  });

  it.each(['fail', 'ignore'] as const)('rejects an unconfirmed setting write (%s)', async (mode) => {
    const runner = new FakeRunner();
    runner.pinWrite = mode;
    await expect(
      adapter(runner).applySetting(
        target,
        user,
        {
          namespace: 'secure',
          key: PIN_SCRAMBLING_KEY,
          value: '1',
        },
        { lease: {} },
      ),
    ).rejects.toThrow();
    expect(runner.pinValues.has(user.userId)).toBe(false);
  });

  it('refuses a reused Android user identity before writing the setting', async () => {
    const runner = new FakeRunner();
    runner.serialNo++;
    await expect(
      adapter(runner).applySetting(
        target,
        user,
        {
          namespace: 'secure',
          key: PIN_SCRAMBLING_KEY,
          value: '1',
        },
        { lease: {} },
      ),
    ).rejects.toThrow();
    expect(runner.mutations).toEqual([]);
  });
});

describe('observation-scoped shared APK inspection', () => {
  it('keeps metadata inspection for optional split packages but rejects managed splits without mutation', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const shell = android.shell.bind(android);
    android.shell = (selected, args, options) =>
      args[0] === 'pm' && args[1] === 'path'
        ? Promise.resolve('package:/data/app/test/base.apk\npackage:/data/app/test/split_config.apk\n')
        : shell(selected, args, options);
    expect((await android.installedIdentity(target, user, 'org.example.app')).versionCode).toBe(1);
    await expect(android.inspect(target, policy)).rejects.toThrow('split APK');
    await expect(android.inspectSharedEffects(target, ['org.example.app'])).rejects.toThrow('maintenance');
    expect(runner.mutations).toHaveLength(0);
  });
  it('rejects changing package paths while measuring content', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const shell = android.shell.bind(android);
    let reads = 0;
    android.shell = (selected, args, options) =>
      args[0] === 'pm' && args[1] === 'path'
        ? Promise.resolve(`package:/data/app/test${reads++}/base.apk\n`)
        : shell(selected, args, options);
    await expect(android.inspectSharedEffects(target, ['org.example.app'])).rejects.toThrow('paths changed');
    expect(runner.mutations).toHaveLength(0);
  });
  function sharedPolicy(): ExecutionPolicy {
    const configured = structuredClone(policy);
    const secondary = configured.profiles[0];
    const owner = configured.profiles[1];
    if (!secondary || !owner) throw new Error('Missing profile fixtures');
    owner.packages = structuredClone(secondary.packages);
    owner.permissions = structuredClone(secondary.permissions);
    return configured;
  }
  it('inspects one shared APK path once while keeping each user identity and permissions', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const configured = sharedPolicy();
    const observed = await android.inspect(target, configured);
    expect(runner.calls.filter(({ args }) => args.includes('pull'))).toHaveLength(1);
    expect(observed.profiles.map((profile) => profile.user)).toEqual([
      user,
      { userId: 0, serialNo: 0, name: 'Owner' },
    ]);
    expect(observed.profiles.map((profile) => profile.packages.length)).toEqual([1, 1]);
    expect(observed.profiles.map((profile) => profile.permissions[0]?.granted)).toEqual([true, false]);
    runner.version = 2;
    const next = await android.inspect(target, configured);
    expect(runner.calls.filter(({ args }) => args.includes('pull'))).toHaveLength(2);
    expect(next.profiles.map((profile) => profile.packages[0]?.versionCode)).toEqual([2, 2]);
    const effects = await android.inspectSharedEffects(target, ['org.example.app']);
    expect(runner.calls.filter(({ args }) => args.includes('pull'))).toHaveLength(3);
    expect(effects[0]?.users.map((entry) => entry.user.serialNo)).toEqual([0, 42]);
  });
  it('preserves per-user package absence even when another profile uses an inspected shared APK', async () => {
    const runner = new FakeRunner();
    const run = runner.run.bind(runner);
    runner.run = (args, options) => {
      const command = args.slice(args.indexOf('shell') + 1).map(decode);
      if (command.join(' ') === 'pm list packages --user 0')
        return Promise.resolve({ code: 0, stdout: 'package:android\n', stderr: '' });
      return run(args, options);
    };
    const observed = await adapter(runner).inspect(target, sharedPolicy());
    expect(observed.profiles.map((profile) => profile.packages.length)).toEqual([1, 0]);
    expect(observed.profiles[1]?.permissions[0]?.granted).toBe(false);
    expect(runner.calls.filter(({ args }) => args.includes('pull'))).toHaveLength(1);
  });
  it('does not share package identity across distinct actual APK paths', async () => {
    const runner = new FakeRunner();
    const run = runner.run.bind(runner);
    runner.run = (args, options) => {
      const command = args.slice(args.indexOf('shell') + 1).map(decode);
      if (command.slice(0, 2).join(' ') === 'pm path' && command[3] === '0')
        return Promise.resolve({ code: 0, stdout: 'package:/data/app/owner/base.apk\n', stderr: '' });
      return run(args, options);
    };
    const observed = await adapter(runner).inspect(target, sharedPolicy());
    expect(observed.profiles.map((profile) => profile.packages.length)).toEqual([1, 1]);
    expect(runner.calls.filter(({ args }) => args.includes('pull'))).toHaveLength(2);
  });
});
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
      android.verifyVpnConfiguration(
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
    const configured: ExecutionPolicy = {
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
  it.each(['enabled', 'disabled'])(
    'recognizes the selected Seedvault transport name while backup is %s',
    (state) => {
      expect(
        parseBackupObservation(
          'Backup Manager currently ' + state,
          'com.android.localtransport/.LocalTransport\n  * com.stevesoltys.seedvault.transport.ConfigurableBackupTransport',
        ),
      ).toEqual({ enabled: state === 'enabled', transportPackage: 'com.stevesoltys.seedvault' });
    },
  );
  it('does not select a registered Seedvault name without the selection marker', () => {
    expect(
      parseBackupObservation(
        'Backup Manager currently enabled',
        'com.stevesoltys.seedvault.transport.ConfigurableBackupTransport',
      ),
    ).toEqual({ enabled: true, transportPackage: null });
    expect(
      parseBackupObservation(
        'Backup Manager currently enabled',
        '* com.android.localtransport/.LocalTransport\ncom.stevesoltys.seedvault.transport.ConfigurableBackupTransport',
      ),
    ).toEqual({ enabled: true, transportPackage: 'com.android.localtransport' });
  });
  it.each([
    '* org.example.transport.ConfigurableBackupTransport',
    '* com.stevesoltys.seedvault.transport.UnknownTransport',
    '* com.stevesoltys.seedvault.transport.ConfigurableBackupTransportService',
    'org.example.transport.ConfigurableBackupTransport\n* com.stevesoltys.seedvault.transport.ConfigurableBackupTransport',
  ])('rejects unknown opaque backup transport names: %s', (transports) => {
    expect(() => parseBackupObservation('Backup Manager currently enabled', transports)).toThrow(
      /transports/,
    );
  });
  it('rejects multiple selected transports across named and component formats', () => {
    expect(() =>
      parseBackupObservation(
        'Backup Manager currently enabled',
        '* com.android.localtransport/.LocalTransport\n* com.stevesoltys.seedvault.transport.ConfigurableBackupTransport',
      ),
    ).toThrow(/ambiguous/);
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
    const reviewed = { ...effect, toVersionCode: 2, toSha256: artifact.sha256 };
    runner.extraSerialNo = 100;
    await expect(
      android.install(target, user, artifact, { lease: {}, reviewedDeviceWideEffect: reviewed }),
    ).rejects.toMatchObject({ code: 'SHARED_APK_REVIEW_REQUIRED' });
    expect(runner.mutations).toHaveLength(0);
    runner.extraSerialNo = 99;
    await android.install(target, user, artifact, { lease: {}, reviewedDeviceWideEffect: reviewed });
    expect(runner.mutations).toHaveLength(1);
  });
  it('requires all-user review for same-version content replacement and verifies installed content', async () => {
    const runner = new FakeRunner();
    runner.version = 2;
    const android = adapter(runner);
    const artifact = {
      path: '/reviewed.apk',
      packageId: 'org.example.app',
      versionCode: 2,
      signerSha256: 'b'.repeat(64),
      sha256: 'c'.repeat(64),
    };
    const effect = (await android.inspectSharedEffects(target, [artifact.packageId]))[0]!;
    await expect(android.install(target, user, artifact, { lease: {} })).rejects.toMatchObject({
      code: 'SHARED_APK_REVIEW_REQUIRED',
    });
    expect(runner.mutations).toHaveLength(0);
    await expect(
      android.install(target, user, artifact, {
        lease: {},
        reviewedDeviceWideEffect: { ...effect, toVersionCode: 2, toSha256: artifact.sha256 },
      }),
    ).rejects.toThrow('does not match');
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
    await android.applySetting(
      target,
      user,
      { namespace: 'system', key: 'screen_off_timeout', value: '30000' },
      { lease: {} },
    );
    expect(runner.values.get('system:screen_off_timeout')).toBe('30000');
    for (const permission of profile.permissions)
      await android.applyPermission(target, user, permission, { lease: {} });
    expect(runner.granted).toBe(true);
    runner.values.set('secure:always_on_vpn_app', 'org.example.app');
    runner.values.set('secure:always_on_vpn_lockdown', '1');
    const priorCommands = runner.calls.length;
    await android.verifyVpnConfiguration(
      target,
      user,
      { packageId: 'org.example.app', alwaysOn: true, lockdown: true },
      { lease: {} },
    );
    expect(runner.calls.slice(priorCommands).some((call) => call.args.includes("'put'"))).toBe(false);
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
      android.verifyVpnConfiguration(
        target,
        user,
        { packageId: null, alwaysOn: false, lockdown: true },
        { lease: {} },
      ),
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
  it.each([
    [{ userId: 0, serialNo: 0, name: 'Owner' }, 'de-de', 'de-DE'],
    [user, 'sr-latn-rs', 'sr-Latn-RS'],
  ] as const)('keeps locale setup scoped to Android user %j', async (identity, locale, canonical) => {
    const runner = new FakeRunner();
    await expect(adapter(runner).setupLanguage(target, identity, locale, { lease: {} })).resolves.toEqual({
      status: 'manual-pending',
      capability: 'language',
      instructions: `Set ${canonical} as the primary system locale in Android user ${identity.userId} after entering the normal credential privately.`,
    });
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

describe('fail-closed observation and mutation boundaries', () => {
  it.each([
    ['de-DE', 'de-DE'],
    ['DE-de,pl-PL', 'de-DE'],
    ['sr-latn-rs,en-US', 'sr-Latn-RS'],
    ['iw-IL,en-US', 'he-IL'],
    ['en-US,pl-PL', 'en-US'],
    ['', undefined],
    ['null', undefined],
    ['unknown', undefined],
    [',de-DE', undefined],
    ['invalid_locale,de-DE', undefined],
    ['und,de-DE', undefined],
    ['de-DE,', undefined],
    ['de-DE,,pl-PL', undefined],
    ['de-DE,null', undefined],
    ['de-DE,unknown', undefined],
    ['de-DE,invalid_locale', undefined],
  ])('observes only a valid primary locale from %j', (serialized, expected) => {
    expect(parsePrimaryLocale(serialized)).toBe(expected);
  });
  it('reads distinct default locales from owner and secondary users without cross-user fallback', async () => {
    const runner = new FakeRunner();
    runner.localeValues.set(0, 'DE-de,pl-PL');
    runner.localeValues.set(10, 'sr-latn-rs,en-US');
    const configured: ExecutionPolicy = {
      ...policy,
      profiles: policy.profiles.map((profile) => ({
        ...profile,
        defaultLocale: profile.kind === 'owner' ? 'de-DE' : 'sr-Latn-RS',
      })),
    };
    const android = adapter(runner);
    let observed = await android.inspect(target, configured);
    expect(observed.profiles.map((profile) => [profile.user.userId, profile.language])).toEqual([
      [10, 'sr-Latn-RS'],
      [0, 'de-DE'],
    ]);
    runner.localeValues.set(10, 'null');
    observed = await android.inspect(target, configured);
    expect(observed.profiles[0]).not.toHaveProperty('language');
    expect(observed.profiles[1]?.language).toBe('de-DE');
    expect(runner.mutations).toHaveLength(0);
    const localeReads = runner.calls
      .filter((call) => call.args.at(-1) === "'system_locales'")
      .map((call) => call.args.slice(call.args.indexOf('shell') + 1).map(decode));
    expect(localeReads).toEqual([
      ['settings', '--user', '10', 'get', 'system', 'system_locales'],
      ['settings', '--user', '0', 'get', 'system', 'system_locales'],
      ['settings', '--user', '10', 'get', 'system', 'system_locales'],
      ['settings', '--user', '0', 'get', 'system', 'system_locales'],
    ]);
  });
  it('rejects malformed user identities and incomplete named lists before commands', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    for (const identity of [
      { ...user, userId: -1 },
      { ...user, serialNo: -1 },
      { ...user, name: '' },
    ])
      await expect(android.guardUser(target, identity)).rejects.toThrow(/Invalid stable/);
    for (const value of [
      '',
      '2 users:\n0: id=0, name=Owner, type=full.SYSTEM',
      '1 users:\n0: id=10, name=Work, type=full.SECONDARY',
      '2 users:\n0: id=0, name=Owner, type=full.SYSTEM\n1: id=0, name=Owner, type=full.SYSTEM',
    ])
      expect(() => parseNamedUsers(value)).toThrow();
    expect(() => parseUsers('UserInfo{9007199254740992:Owner:c13} serialNo=0')).toThrow(/Invalid/);
    expect(() => parseUsers('UserInfo{0:Owner:c13} serialNo=0\nUserInfo{0:Owner:c13} serialNo=1')).toThrow(
      /ambiguous/,
    );
    expect(runner.calls).toHaveLength(0);
  });
  it('keeps missing profiles, absent packages and language observations distinct', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const configured: ExecutionPolicy = {
      ...policy,
      profiles: policy.profiles.map((profile) => ({
        ...profile,
        language: 'pl-PL',
        settings: [{ namespace: 'system', key: 'system_locales', value: 'pl-PL' }],
        packages: [
          ...profile.packages,
          {
            packageId: 'org.absent.app',
            versionCode: 1,
            sha256: 'a'.repeat(64),
            signerSha256: 'b'.repeat(64),
          },
        ],
        permissions: [
          ...profile.permissions,
          { packageId: 'org.absent.app', permission: 'android.permission.CAMERA', granted: true },
        ],
      })),
    };
    runner.values.set('system:system_locales', 'pl-PL');
    let observed = await android.inspect(target, configured, new AbortController().signal);
    expect(observed.profiles[0]?.language).toBe('pl-PL');
    expect(observed.profiles[0]?.permissions.at(-1)?.granted).toBe(false);
    runner.values.set('system:system_locales', 'en-US');
    observed = await android.inspect(target, configured);
    expect(observed.profiles[0]?.language).toBe('en-US');
    runner.values.set('system:system_locales', 'unknown');
    observed = await android.inspect(target, {
      ...configured,
      profiles: [{ ...configured.profiles[0]!, name: 'missing' }],
    });
    expect(observed.profiles).toEqual([]);
    runner.values.set('global:adb_enabled', '0');
    runner.values.set('global:adb_wifi_enabled', '1');
    expect((await android.inspect(target, policy)).debuggingEnabled).toBe(true);
    runner.values.set('global:adb_wifi_enabled', 'invalid');
    await expect(android.inspect(target, policy)).rejects.toThrow(/Debugging state/);
  });
  it('rejects unmeasurable APK paths and ambiguous runtime permissions', async () => {
    const android = adapter(new FakeRunner());
    for (const output of [
      '',
      'not-a-package',
      'package:/tmp/untrusted.apk',
      'package:/data/app/a/split-a.apk\npackage:/data/app/a/split-b.apk',
    ]) {
      android.shell = () => Promise.resolve(output);
      await expect(android.installedIdentity(target, user, 'org.example.app')).rejects.toThrow(/APK/);
    }
    const permission = {
      packageId: 'org.example.app',
      permission: 'android.permission.CAMERA',
      granted: true,
    };
    android.shell = () => Promise.resolve('User 0: installed=true\n');
    await expect(android.permission(target, user, permission)).rejects.toThrow(/Per-user/);
    android.shell = () =>
      Promise.resolve(
        'User 10: installed=true\n android.permission.CAMERA: granted=true\n android.permission.CAMERA: granted=false\n',
      );
    await expect(android.permission(target, user, permission)).rejects.toThrow(/ambiguous/);
    await expect(android.permission(target, user, { ...permission, permission: 'unsafe' })).rejects.toThrow(
      /runtime permission/,
    );
  });
  it('retains malformed cleanup evidence and rejects missing owner identity', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'x',
      operationId: 'root',
      ownerOperationId: 'root',
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'restore-setting',
      resource: 'x',
      payload: {},
      status: 'pending',
    };
    for (const payload of [
      { namespace: 'unsafe', key: 'x', previous: '0' },
      { namespace: 'global', key: 2, previous: '0' },
      { namespace: 'global', key: 'x', previous: null },
    ])
      await expect(
        android.cleanup(target, { ...obligation, payload }, { lease: {}, operationId: 'root' }),
      ).rejects.toThrow(/Malformed/);
    await expect(
      android.cleanup(
        target,
        {
          ...obligation,
          kind: 'remove-helper',
          payload: { packageId: 'org.other.app', versionCode: 1, signerSha256: 'b'.repeat(64) },
        },
        { lease: {}, operationId: 'root' },
      ),
    ).rejects.toThrow(/Malformed helper/);
    const { user: _removed, ...missing } = obligation;
    void _removed;
    await expect(android.cleanup(target, missing, { lease: {}, operationId: 'root' })).rejects.toThrow(
      /recorded stable/,
    );
    expect(runner.mutations).toHaveLength(0);
  });
  it('refuses signer changes, downgrades and unsuccessful post-mutation measurements', async () => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const artifact = {
      path: '/reviewed.apk',
      packageId: 'org.example.app',
      versionCode: 2,
      sha256: 'a'.repeat(64),
      signerSha256: 'b'.repeat(64),
    };
    android.inspectSharedEffects = () =>
      Promise.resolve([
        { packageId: artifact.packageId, users: [{ user, versionCode: 1, signerSha256: 'c'.repeat(64) }] },
      ]);
    await expect(android.install(target, user, artifact, { lease: {} })).rejects.toThrow(/signer differs/);
    android.inspectSharedEffects = () =>
      Promise.resolve([
        {
          packageId: artifact.packageId,
          users: [{ user, versionCode: 3, signerSha256: artifact.signerSha256 }],
        },
      ]);
    await expect(android.install(target, user, artifact, { lease: {} })).rejects.toThrow(/downgrade/);
    android.readSetting = () => Promise.resolve('wrong');
    await expect(
      android.applySetting(
        target,
        user,
        { namespace: 'global', key: 'safe', value: 'wanted' },
        { lease: {} },
      ),
    ).rejects.toThrow(/retain/);
    android.permission = () =>
      Promise.resolve({
        packageId: artifact.packageId,
        permission: 'android.permission.CAMERA',
        granted: false,
      });
    await expect(
      android.applyPermission(
        target,
        user,
        { packageId: artifact.packageId, permission: 'android.permission.CAMERA', granted: true },
        { lease: {} },
      ),
    ).rejects.toThrow(/retain/);
    await expect(
      android.verifyVpnConfiguration(
        target,
        user,
        { packageId: null, alwaysOn: false, lockdown: false },
        { lease: {} },
      ),
    ).rejects.toThrow(/VPN lockdown observation|witnessed/);
  });
});

it('explicitly retries a blocked durable obligation through the real Android cleanup boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pxv-adapter-recovery-'));
  const store = await SqliteStore.open(join(directory, 'state.sqlite'));
  try {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const scope = new ResourceScope(store, target.device.canonicalSerial, 'recovery-run');
    const record = await recordObligation(
      scope,
      'restore-setting',
      'awake',
      { namespace: 'global', key: 'stay_on_while_plugged_in', previous: '0' },
      user,
    );
    const run = runner.run.bind(runner);
    let unavailable = true;
    runner.run = (args, options) =>
      options?.mutation && unavailable
        ? Promise.reject(new Error('Device disconnected during cleanup'))
        : run(args, options);
    const inspect = async (expected: AndroidUserIdentity): Promise<AndroidUserIdentity> => {
      const observed = (await android.users(target)).find((value) => value.userId === expected.userId);
      if (!observed) throw new Error('Missing live user');
      return observed;
    };
    const cleanup = (entry: RecoveryObligation) =>
      android.cleanup(target, entry, { lease: {}, operationId: entry.ownerOperationId });
    await expect(scope.cleanup(inspect, cleanup)).rejects.toThrow('Device disconnected during cleanup');
    expect((await scope.list())[0]).toMatchObject({ id: record.id, status: 'blocked', user });
    unavailable = false;
    await scope.cleanup(inspect, cleanup);
    const resolved = (await scope.list())[0];
    expect(resolved).toMatchObject({ id: record.id, status: 'resolved' });
    expect(runner.values.get('global:stay_on_while_plugged_in')).toBe('0');
    if (!resolved) throw new Error('Missing recovery record');
    await expect(cleanup(resolved)).rejects.toThrow(/scope/);
    const mutations = runner.mutations.length;
    await scope.cleanup(inspect, cleanup);
    expect(runner.mutations).toHaveLength(mutations);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['always_on_vpn_app', 'always_on_vpn_lockdown'])(
  'rejects generic secure VPN setting %s before any device command',
  async (key) => {
    const runner = new FakeRunner();
    const android = adapter(runner);
    const shell = vi.spyOn(android, 'shell');
    await expect(
      android.applySetting(target, user, { namespace: 'secure', key, value: '0' }, { lease: {} }),
    ).rejects.toThrow('vpn block');
    expect(shell).not.toHaveBeenCalled();
  },
);
