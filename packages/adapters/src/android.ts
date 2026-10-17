import {
  integer,
  parseUsers,
  parseNamedUsers,
  parseBackupObservation,
  parsePrimaryLocale,
} from './android-observation.js';
import type {
  AndroidUserIdentity,
  DeviceObservation,
  PermissionPolicy,
  PolicyPack,
  ProfileObservation,
  ProfilePolicy,
  RecoveryObligation,
  SelectedTarget,
  SettingPolicy,
  VpnPolicy,
  SharedApkEffect,
  ReviewedApkEffect,
} from '@pxv/contracts';
import { canonicalJson, canonicalLocale, profileLocale, sameAndroidUser } from '@pxv/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactService, type ApkIdentity, type VerifiedArtifact } from './artifacts.js';
import {
  AdapterError,
  checked,
  packageId,
  shellQuote,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type OperationOptions,
} from './command.js';
import type { VerifiedImage } from './images.js';
import { flashImage } from './images.js';
import type { CapabilityResult, UiAutomation } from './ui.js';
import {
  adbClientEnvironment,
  configuredAdbServer,
  probeAdbServer,
  validateAdbServer,
  type AdbServerEndpoint,
} from './adb-server.js';

export interface AndroidOptions {
  runner: CommandRunner;
  adb?: string;
  fastboot?: string;
  artifacts?: ArtifactService;
  now?: () => Date;
  ui?: UiAutomation;
  adbServer?: AdbServerEndpoint;
}
export interface InstallOptions extends OperationOptions {
  reviewedDeviceWideEffect?: ReviewedApkEffect;
}
export interface CleanupOptions extends OperationOptions {
  operationId: string;
}
const HELPERS = new Set(['org.pxv.probe', 'org.pxv.setup', 'org.pxv.e2e.fixture']);
const signalOptions = (signal?: AbortSignal): CommandOptions => (signal ? { signal } : {});

function settingKey(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new AdapterError('Invalid Android setting key');
  return value;
}
function assertUser(user: AndroidUserIdentity): void {
  if (
    !Number.isSafeInteger(user.userId) ||
    user.userId < 0 ||
    !Number.isSafeInteger(user.serialNo) ||
    user.serialNo < 0 ||
    !user.name
  )
    throw new AdapterError('Invalid stable Android user identity');
}

export class AndroidAdapter {
  readonly runner: CommandRunner;
  readonly adb: string;
  readonly fastboot: string;
  readonly artifacts: ArtifactService;
  readonly now: () => Date;
  readonly ui?: UiAutomation;
  readonly adbServer: AdbServerEndpoint;
  constructor(options: AndroidOptions) {
    this.adbServer = validateAdbServer(options.adbServer ?? configuredAdbServer());
    this.runner = options.runner;
    this.adb = options.adb ?? 'adb';
    this.fastboot = options.fastboot ?? 'fastboot';
    this.artifacts = options.artifacts ?? new ArtifactService({ runner: options.runner });
    this.now = options.now ?? (() => new Date());
    if (options.ui) this.ui = options.ui;
  }
  async runAdb(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    await probeAdbServer(this.adbServer, options.signal);
    return this.runner.run(
      [this.adb, '-H', this.adbServer.host, '-P', String(this.adbServer.port), ...args],
      { ...options, env: adbClientEnvironment(this.adbServer) },
    );
  }
  async shell(target: SelectedTarget, args: string[], options: CommandOptions = {}): Promise<string> {
    return checked(
      await this.runAdb(['-s', target.transport.serial, 'shell', ...args.map(shellQuote)], {
        timeoutMs: 30_000,
        ...options,
      }),
      'Android command',
    );
  }
  async guardTarget(target: SelectedTarget, signal?: AbortSignal): Promise<void> {
    assertEnrolledTransport(target);
    const devices = checked(
      await this.runAdb(['devices', '-l'], signalOptions(signal)),
      'ADB transport inspection',
    );
    const rows = devices
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row[0] === target.transport.serial);
    if (rows.length !== 1 || rows[0]?.[1] !== 'device')
      throw new AdapterError(
        'Selected Android transport is offline, unauthorized or ambiguous',
        'DEVICE_UNAVAILABLE',
      );
    await this.guardDeviceIdentity(target, signal);
  }
  private async guardDeviceIdentity(target: SelectedTarget, signal?: AbortSignal): Promise<void> {
    if (target.device.kind === 'pixel') {
      const serial = (await this.shell(target, ['getprop', 'ro.serialno'], signalOptions(signal))).trim();
      if (serial !== target.device.canonicalSerial)
        throw new AdapterError(
          'Physical device identity changed; reconnect the enrolled phone over USB',
          'IDENTITY_CHANGED',
        );
    } else assertEmulatorTransport(target);
    const model = (await this.shell(target, ['getprop', 'ro.product.model'], signalOptions(signal))).trim();
    const codename = (
      await this.shell(target, ['getprop', 'ro.product.device'], signalOptions(signal))
    ).trim();
    if (model !== target.device.model || codename !== target.device.codename)
      throw new AdapterError('Device model or codename changed', 'IDENTITY_CHANGED');
  }
  async users(target: SelectedTarget, signal?: AbortSignal): Promise<AndroidUserIdentity[]> {
    const output = await this.shell(target, ['cmd', 'user', 'list', '-v'], signalOptions(signal));
    if (output.includes('UserInfo{')) {
      const users = parseUsers(output);
      if (users.some((user) => ['null', '(null)', 'undefined'].includes(user.name)))
        throw new AdapterError(
          'Android user names are privacy placeholders; inspect named user identities before continuing',
        );
      return users;
    }
    const names = parseNamedUsers(output);
    const serials = parseUsers(await this.shell(target, ['dumpsys', 'user'], signalOptions(signal)));
    const namesAfter = parseNamedUsers(
      await this.shell(target, ['cmd', 'user', 'list', '-v'], signalOptions(signal)),
    );
    const serialsAfter = parseUsers(await this.shell(target, ['dumpsys', 'user'], signalOptions(signal)));
    const namesKey = (values: { userId: number; name: string }[]): string =>
      canonicalJson(values.slice().sort((a, b) => a.userId - b.userId));
    const serialsKey = (values: AndroidUserIdentity[]): string =>
      canonicalJson(
        values.map(({ userId, serialNo }) => ({ userId, serialNo })).sort((a, b) => a.userId - b.userId),
      );
    if (
      namesKey(names) !== namesKey(namesAfter) ||
      serialsKey(serials) !== serialsKey(serialsAfter) ||
      names.length !== serials.length
    )
      throw new AdapterError('Android users changed while binding names and stable serial identities');
    return names.map((named) => {
      const identity = serials.find((user) => user.userId === named.userId);
      if (!identity) throw new AdapterError('Android named user and serial identity sets disagree');
      return { ...named, serialNo: identity.serialNo };
    });
  }
  async guardUser(target: SelectedTarget, user: AndroidUserIdentity, signal?: AbortSignal): Promise<void> {
    assertUser(user);
    await this.guardTarget(target, signal);
    const observed = (await this.users(target, signal)).find((candidate) => candidate.userId === user.userId);
    if (!observed || !sameAndroidUser(user, observed))
      throw new AdapterError(
        'Android user was removed or recreated; preserve the recovery obligation',
        'USER_IDENTITY_CHANGED',
      );
  }
  async readSetting(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    setting: Pick<SettingPolicy, 'namespace' | 'key'>,
    signal?: AbortSignal,
  ): Promise<string> {
    settingKey(setting.key);
    if (!['system', 'secure', 'global'].includes(setting.namespace))
      throw new AdapterError('Invalid setting namespace');
    const result = await this.shell(
      target,
      ['settings', '--user', String(user.userId), 'get', setting.namespace, setting.key],
      signalOptions(signal),
    );
    return result.replace(/\r?\n$/, '');
  }
  async listPackages(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const output = await this.shell(
      target,
      ['pm', 'list', 'packages', '--user', String(user.userId)],
      signalOptions(signal),
    );
    const packages = new Set<string>();
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      if (!line.startsWith('package:')) throw new AdapterError('Android package listing is malformed');
      const id = line.slice(8).trim();
      packages.add(id === 'android' ? id : packageId(id));
    }
    return packages;
  }
  async installedIdentity(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    id: string,
    signal?: AbortSignal,
    inspected?: Map<string, Promise<ApkIdentity>>,
  ): Promise<{ packageId: string; versionCode: number; signerSha256: string }> {
    packageId(id);
    const output = await this.shell(
      target,
      ['pm', 'path', '--user', String(user.userId), id],
      signalOptions(signal),
    );
    const paths = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => (line.startsWith('package:') ? line.slice(8).trim() : ''));
    if (
      paths.length < 1 ||
      paths.some(
        (path) => !/^\/(?:data\/app|system|product|system_ext|vendor)\/[A-Za-z0-9_./~+=-]+\.apk$/.test(path),
      )
    )
      throw new AdapterError('Installed APK paths are missing or unsafe');
    const base =
      paths.find((path) => /\/base\.apk$/.test(path)) ?? (paths.length === 1 ? paths[0] : undefined);
    if (!base) throw new AdapterError('Installed base APK cannot be identified');
    let pending = inspected?.get(base);
    if (!pending) {
      pending = this.inspectInstalledPath(target, base, signal);
      inspected?.set(base, pending);
    }
    const identity = await pending;
    if (identity.packageId !== id) throw new AdapterError('Installed APK package changed during inspection');
    return identity;
  }
  private async inspectInstalledPath(
    target: SelectedTarget,
    base: string,
    signal?: AbortSignal,
  ): Promise<ApkIdentity> {
    const directory = await mkdtemp(join(tmpdir(), 'pxv-observe-apk-'));
    try {
      const path = join(directory, 'base.apk');
      checked(
        await this.runAdb(['-s', target.transport.serial, 'pull', base, path], {
          timeoutMs: 120_000,
          ...signalOptions(signal),
        }),
        'Installed APK read',
      );
      return await this.artifacts.identity(path, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async permission(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    policy: PermissionPolicy,
    signal?: AbortSignal,
  ): Promise<PermissionPolicy> {
    packageId(policy.packageId);
    if (!/^android\.permission\.[A-Z0-9_]+$/.test(policy.permission))
      throw new AdapterError('Invalid Android runtime permission');
    const dump = await this.shell(target, ['dumpsys', 'package', policy.packageId], signalOptions(signal));
    const blocks = [...dump.matchAll(/^\s*User (\d+):[\s\S]*?(?=^\s*User \d+:|$(?![\s\S]))/gm)];
    const block = blocks.find((row) => row[1] === String(user.userId))?.[0];
    if (!block) throw new AdapterError('Per-user runtime permissions could not be inspected');
    const escaped = policy.permission.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = [...block.matchAll(new RegExp(`\\b${escaped}:\\s*granted=(true|false)\\b`, 'g'))];
    if (rows.length > 1) throw new AdapterError('Runtime permission observation is ambiguous');
    return { ...policy, granted: rows[0]?.[1] === 'true' };
  }
  async vpn(target: SelectedTarget, user: AndroidUserIdentity, signal?: AbortSignal): Promise<VpnPolicy> {
    const id = await this.readSetting(
      target,
      user,
      { namespace: 'secure', key: 'always_on_vpn_app' },
      signal,
    );
    const lockdown = await this.readSetting(
      target,
      user,
      { namespace: 'secure', key: 'always_on_vpn_lockdown' },
      signal,
    );
    if (!['null', '0', '1'].includes(lockdown))
      throw new AdapterError('Android VPN lockdown observation is malformed');
    const actual = id === 'null' || id === '' ? null : packageId(id);
    return { packageId: actual, alwaysOn: actual !== null, lockdown: lockdown === '1' };
  }
  async inspect(
    target: SelectedTarget,
    policy: PolicyPack,
    signal?: AbortSignal,
  ): Promise<DeviceObservation> {
    await this.guardTarget(target, signal);
    const users = await this.users(target, signal);
    const { listings, helpers } = await this.inspectUserPackages(target, users, signal);
    const inspected = new Map<string, Promise<ApkIdentity>>();
    const profiles: ProfileObservation[] = [];
    for (const profile of policy.profiles) {
      const user = policyUser(users, profile);
      if (user) profiles.push(await this.inspectProfile(target, user, profile, listings, inspected, signal));
    }
    const os = await this.inspectOs(target, signal);
    const debuggingEnabled = await this.inspectDebugging(target, users, signal);
    await this.guardTarget(target, signal);
    if (JSON.stringify(users) !== JSON.stringify(await this.users(target, signal)))
      throw new AdapterError('Android users changed during observation');
    return {
      schemaVersion: 1,
      device: target.device,
      observedAt: this.now().toISOString(),
      os,
      profiles,
      helpers: helpers.sort(),
      debuggingEnabled,
    };
  }
  private async inspectUserPackages(
    target: SelectedTarget,
    users: AndroidUserIdentity[],
    signal?: AbortSignal,
  ): Promise<{ listings: Map<number, Set<string>>; helpers: string[] }> {
    const listings = new Map<number, Set<string>>();
    const helpers: string[] = [];
    for (const user of users) {
      const installed = await this.listPackages(target, user, signal);
      listings.set(user.userId, installed);
      for (const helper of HELPERS)
        if (installed.has(helper)) helpers.push(helper + '@user:' + user.userId + ':serial:' + user.serialNo);
    }
    return { listings, helpers };
  }
  private async inspectProfile(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    listings: Map<number, Set<string>>,
    inspected: Map<string, Promise<ApkIdentity>>,
    signal?: AbortSignal,
  ): Promise<ProfileObservation> {
    const installed = listings.get(user.userId);
    if (!installed) throw new AdapterError('Android user package observation is missing');
    const packages: ProfileObservation['packages'] = [];
    for (const wanted of profile.packages)
      if (installed.has(wanted.packageId))
        packages.push(await this.installedIdentity(target, user, wanted.packageId, signal, inspected));
    const settings: SettingPolicy[] = [];
    for (const setting of profile.settings)
      settings.push({ ...setting, value: await this.readSetting(target, user, setting, signal) });
    const permissions: PermissionPolicy[] = [];
    for (const permission of profile.permissions)
      permissions.push(
        installed.has(permission.packageId)
          ? await this.permission(target, user, permission, signal)
          : { ...permission, granted: false },
      );
    const observed: ProfileObservation = {
      profileId: profile.id,
      user,
      packages,
      settings,
      permissions,
      vpn: await this.vpn(target, user, signal),
    };
    await this.inspectProfileCapabilities(target, user, profile, observed, signal);
    return observed;
  }
  private async inspectProfileCapabilities(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    profile: ProfilePolicy,
    observed: ProfileObservation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (profile.backup) {
      const enabled = await this.shell(
        target,
        ['bmgr', '--user', String(user.userId), 'enabled'],
        signalOptions(signal),
      );
      const transports = await this.shell(
        target,
        ['bmgr', '--user', String(user.userId), 'list', 'transports'],
        signalOptions(signal),
      );
      observed.backup = parseBackupObservation(enabled, transports);
    }
    if (profileLocale(profile)) {
      const language = parsePrimaryLocale(
        await this.readSetting(target, user, { namespace: 'system', key: 'system_locales' }, signal),
      );
      if (language) observed.language = language;
    }
  }
  private async inspectOs(target: SelectedTarget, signal?: AbortSignal): Promise<DeviceObservation['os']> {
    const getprop = async (key: string): Promise<string> =>
      (await this.shell(target, ['getprop', key], signalOptions(signal))).trim();
    const release = await getprop('ro.build.version.incremental');
    if (!release) throw new AdapterError('Android OS release could not be inspected');
    const boot = await getprop('ro.boot.verifiedbootstate');
    const locked = await getprop('ro.boot.flash.locked');
    const vbmeta = await getprop('ro.boot.vbmeta.device_state');
    return {
      codename: target.device.codename,
      release,
      bootVerified: ['green', 'yellow'].includes(boot) && locked === '1' && vbmeta === 'locked',
    };
  }
  private async inspectDebugging(
    target: SelectedTarget,
    users: AndroidUserIdentity[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const owner = users.find((user) => user.userId === 0);
    if (!owner) throw new AdapterError('Owner is missing');
    const adb = await this.readSetting(target, owner, { namespace: 'global', key: 'adb_enabled' }, signal);
    const wifi = await this.readSetting(
      target,
      owner,
      { namespace: 'global', key: 'adb_wifi_enabled' },
      signal,
    );
    if (!['0', '1'].includes(adb) || !['0', '1', 'null'].includes(wifi))
      throw new AdapterError('Debugging state could not be inspected');
    return adb === '1' || wifi === '1';
  }
  async createUser(
    target: SelectedTarget,
    profile: Pick<ProfilePolicy, 'id' | 'name' | 'kind'>,
    options: OperationOptions,
  ): Promise<AndroidUserIdentity> {
    await this.guardTarget(target, options.signal);
    const users = await this.users(target, options.signal);
    if (profile.kind === 'owner') {
      const owner = users.find((user) => user.userId === 0);
      if (!owner) throw new AdapterError('Android owner is missing');
      return owner;
    }
    if (!profile.name || profile.name.length > 80 || /[:\r\n\0}]/.test(profile.name))
      throw new AdapterError('Invalid Android user name');
    if (users.some((user) => user.name === profile.name))
      throw new AdapterError(
        'An Android user already has the requested name; enroll its stable identity before use',
      );
    const output = await this.shell(target, ['pm', 'create-user', profile.name], {
      ...options,
      mutation: true,
      timeoutMs: 120_000,
    });
    const match = /^Success: created user id (\d+)\s*$/.exec(output.trim());
    const created = (await this.users(target, options.signal)).find(
      (user) => String(user.userId) === match?.[1] && user.name === profile.name,
    );
    if (!created || created.userId === 0 || users.some((user) => user.userId === created.userId))
      throw new AdapterError(
        'User creation outcome is uncertain; inspect the device before resuming',
        'MUTATION_UNCERTAIN',
      );
    return created;
  }
  async inspectSharedEffects(
    target: SelectedTarget,
    packageIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedApkEffect[]> {
    await this.guardTarget(target, signal);
    const users = await this.users(target, signal);
    const listings = new Map<number, Set<string>>();
    for (const user of users) listings.set(user.userId, await this.listPackages(target, user, signal));
    const effects: SharedApkEffect[] = [];
    const inspected = new Map<string, Promise<ApkIdentity>>();
    for (const id of [...new Set(packageIds)].sort()) {
      packageId(id);
      const installed: SharedApkEffect['users'] = [];
      for (const user of users)
        if (listings.get(user.userId)?.has(id)) {
          const identity = await this.installedIdentity(target, user, id, signal, inspected);
          installed.push({ user, versionCode: identity.versionCode, signerSha256: identity.signerSha256 });
        }
      effects.push({ packageId: id, users: installed.sort((a, b) => a.user.serialNo - b.user.serialNo) });
    }
    const after = await this.users(target, signal);
    if (JSON.stringify(users) !== JSON.stringify(after))
      throw new AdapterError('Android users changed while reviewing shared APK effects');
    return effects;
  }
  async install(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    artifact: VerifiedArtifact,
    options: InstallOptions,
  ): Promise<void> {
    await this.artifacts.withStaged(
      artifact,
      async (staged) => {
        await this.guardUser(target, user, options.signal);
        const sdk = integer(
          (
            await this.shell(target, ['getprop', 'ro.build.version.sdk'], signalOptions(options.signal))
          ).trim(),
          'Android SDK',
        );
        const abis = (
          await this.shell(target, ['getprop', 'ro.product.cpu.abilist'], signalOptions(options.signal))
        )
          .trim()
          .split(',')
          .filter(Boolean);
        await this.artifacts.checkCompatibility(staged.path, sdk, abis, options.signal);
        await this.guardSharedInstall(target, user, artifact, options);
        await this.guardUser(target, user, options.signal);
        const installed = checked(
          await this.runAdb(
            ['-s', target.transport.serial, 'install', '--user', String(user.userId), '-r', staged.path],
            { ...options, mutation: true, timeoutMs: 300_000 },
          ),
          'APK installation',
        );
        if (!/^Success\s*$/m.test(installed))
          throw new AdapterError('APK installation outcome is uncertain', 'MUTATION_UNCERTAIN');
        await this.guardUser(target, user, options.signal);
        const identity = await this.installedIdentity(target, user, artifact.packageId, options.signal);
        if (identity.versionCode !== artifact.versionCode || identity.signerSha256 !== artifact.signerSha256)
          throw new AdapterError('Installed APK does not match the reviewed artifact', 'MUTATION_UNCERTAIN');
      },
      options.signal,
    );
  }
  private async guardSharedInstall(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    artifact: VerifiedArtifact,
    options: InstallOptions,
  ): Promise<void> {
    const shared = (await this.inspectSharedEffects(target, [artifact.packageId], options.signal))[0];
    if (!shared) throw new AdapterError('Shared APK effects could not be inspected');
    if (shared.users.some((entry) => entry.signerSha256 !== artifact.signerSha256))
      throw new AdapterError(
        'Installed APK signer differs in an Android user; explicit migration is required',
      );
    if (shared.users.some((entry) => entry.versionCode > artifact.versionCode))
      throw new AdapterError('APK version downgrade is unsupported');
    const affected = shared.users.filter(
      (entry) => entry.user.userId !== user.userId && entry.versionCode !== artifact.versionCode,
    );
    if (affected.length) {
      const reviewed = options.reviewedDeviceWideEffect;
      if (
        !reviewed ||
        reviewed.packageId !== artifact.packageId ||
        reviewed.toVersionCode !== artifact.versionCode ||
        canonicalJson(reviewed.users.slice().sort((a, b) => a.user.serialNo - b.user.serialNo)) !==
          canonicalJson(shared.users)
      )
        throw new AdapterError(
          'Device-wide APK changes affect other Android users; review the exact live shared effects before installing',
          'SHARED_APK_REVIEW_REQUIRED',
        );
    }
  }
  async applySetting(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    setting: SettingPolicy,
    options: OperationOptions,
  ): Promise<void> {
    settingKey(setting.key);
    if (!['system', 'secure', 'global'].includes(setting.namespace) || setting.value.length > 4096)
      throw new AdapterError('Invalid Android setting');
    await this.guardUser(target, user, options.signal);
    await this.shell(
      target,
      ['settings', '--user', String(user.userId), 'put', setting.namespace, setting.key, setting.value],
      { ...options, mutation: true },
    );
    if ((await this.readSetting(target, user, setting, options.signal)) !== setting.value)
      throw new AdapterError('Android did not retain the requested setting');
  }
  async applyPermission(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    permission: PermissionPolicy,
    options: OperationOptions,
  ): Promise<void> {
    packageId(permission.packageId);
    if (!/^android\.permission\.[A-Z0-9_]+$/.test(permission.permission))
      throw new AdapterError('Invalid Android runtime permission');
    await this.guardUser(target, user, options.signal);
    await this.shell(
      target,
      [
        'pm',
        permission.granted ? 'grant' : 'revoke',
        '--user',
        String(user.userId),
        permission.packageId,
        permission.permission,
      ],
      { ...options, mutation: true },
    );
    if ((await this.permission(target, user, permission, options.signal)).granted !== permission.granted)
      throw new AdapterError('Android did not retain the runtime permission');
  }
  async applyVpn(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    vpn: VpnPolicy,
    options: OperationOptions,
  ): Promise<void> {
    if (vpn.packageId) packageId(vpn.packageId);
    if (vpn.alwaysOn !== (vpn.packageId !== null) || (vpn.lockdown && !vpn.alwaysOn))
      throw new AdapterError('Inconsistent VPN policy');
    // Configure the selected application privately before enabling its lockdown.
    if (vpn.packageId && !(await this.listPackages(target, user, options.signal)).has(vpn.packageId))
      throw new AdapterError('Install and configure the selected VPN before enabling it');
    await this.applySetting(
      target,
      user,
      { namespace: 'secure', key: 'always_on_vpn_app', value: vpn.packageId ?? '' },
      options,
    );
    await this.applySetting(
      target,
      user,
      { namespace: 'secure', key: 'always_on_vpn_lockdown', value: vpn.lockdown ? '1' : '0' },
      options,
    );
  }
  async cleanup(
    target: SelectedTarget,
    obligation: RecoveryObligation,
    options: CleanupOptions,
  ): Promise<void> {
    if (
      !['pending', 'blocked'].includes(obligation.status) ||
      obligation.ownerOperationId !== options.operationId ||
      obligation.deviceSerial !== target.device.canonicalSerial
    )
      throw new AdapterError('Cleanup obligation is outside this operation scope');
    const user = obligation.user;
    if (!user) throw new AdapterError('Cleanup requires a recorded stable Android user identity');
    await this.guardUser(target, user, options.signal);
    switch (obligation.kind) {
      case 'restore-setting':
        return this.restoreSetting(target, user, obligation.payload, options);
      case 'remove-helper':
        return this.removeHelper(target, user, obligation.payload, options);
      case 'remove-file':
        return this.removePrivateFile(target, user, obligation.payload, options);
      default:
        throw new AdapterError('Unknown cleanup capability; preserve the recovery obligation');
    }
  }
  private async restoreSetting(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    data: Record<string, unknown>,
    options: CleanupOptions,
  ): Promise<void> {
    const namespace = data['namespace'];
    const key = data['key'];
    const previous = data['previous'];
    if (
      (namespace !== 'system' && namespace !== 'secure' && namespace !== 'global') ||
      typeof key !== 'string' ||
      typeof previous !== 'string'
    )
      throw new AdapterError('Malformed setting recovery evidence');
    if (previous !== 'null')
      return this.applySetting(target, user, { namespace, key, value: previous }, options);
    settingKey(key);
    await this.guardUser(target, user, options.signal);
    await this.shell(target, ['settings', '--user', String(user.userId), 'delete', namespace, key], {
      ...options,
      mutation: true,
    });
  }
  private async removeHelper(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    data: Record<string, unknown>,
    options: CleanupOptions,
  ): Promise<void> {
    const id = data['packageId'];
    const version = data['versionCode'];
    const signer = data['signerSha256'];
    if (
      typeof id !== 'string' ||
      !HELPERS.has(id) ||
      typeof version !== 'number' ||
      typeof signer !== 'string'
    )
      throw new AdapterError('Malformed helper recovery evidence');
    if (!(await this.listPackages(target, user, options.signal)).has(id)) return;
    const identity = await this.installedIdentity(target, user, id, options.signal);
    if (identity.versionCode !== version || identity.signerSha256 !== signer)
      throw new AdapterError('Temporary helper identity changed; preserve recovery evidence');
    await this.guardUser(target, user, options.signal);
    const output = await this.shell(target, ['pm', 'uninstall', '--user', String(user.userId), id], {
      ...options,
      mutation: true,
    });
    if (output.trim() !== 'Success' || (await this.listPackages(target, user, options.signal)).has(id))
      throw new AdapterError('Temporary helper removal could not be verified');
  }
  private async removePrivateFile(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    data: Record<string, unknown>,
    options: CleanupOptions,
  ): Promise<void> {
    const path = data['path'];
    if (
      typeof path !== 'string' ||
      !new RegExp(
        '^/storage/emulated/' + user.userId + '/Download/pxv-import-[a-f0-9-]{36}[.][A-Za-z0-9]{1,10}$',
      ).test(path)
    )
      throw new AdapterError('Temporary file cleanup path is outside the recorded user scope');
    await this.guardUser(target, user, options.signal);
    await this.shell(target, ['rm', '-f', path], { ...options, mutation: true });
    await this.guardUser(target, user, options.signal);
    const check = await this.runAdb(
      ['-s', target.transport.serial, 'shell', ...['test', '!', '-e', path].map(shellQuote)],
      { lease: options.lease, check: false, timeoutMs: 30_000 },
    );
    if (check.code !== 0)
      throw new AdapterError(
        'Temporary private input removal could not be verified; preserve the cleanup obligation',
      );
  }
  async launch(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    id: string,
    options: OperationOptions,
  ): Promise<void> {
    packageId(id);
    await this.guardUser(target, user, options.signal);
    const output = await this.shell(
      target,
      [
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '--user',
        String(user.userId),
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.LAUNCHER',
        id,
      ],
      signalOptions(options.signal),
    );
    const candidates = output
      .trim()
      .split('\n')
      .filter(
        (component) => component.startsWith(id + '/') && /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(component),
      );
    if (candidates.length !== 1 || !candidates[0])
      throw new AdapterError('Expected application launcher could not be resolved');
    await this.guardUser(target, user, options.signal);
    await this.shell(target, ['am', 'start', '--user', String(user.userId), '-n', candidates[0]], {
      ...options,
      mutation: true,
    });
  }
  async setupLanguage(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    language: string,
    options: OperationOptions,
  ): Promise<CapabilityResult> {
    await this.guardUser(target, user, options.signal);
    const locale = canonicalLocale(language);
    if (!this.ui)
      return {
        status: 'manual-pending',
        capability: 'language',
        instructions: `Set ${locale} as the primary system locale in Android user ${user.userId} after entering the normal credential privately.`,
      };
    return this.ui.execute(this, target, user, { capability: 'language', language: locale }, options);
  }
  /** Request debugging shutdown; final toggle state still requires physical confirmation. */
  async finalize(target: SelectedTarget, options: OperationOptions): Promise<void> {
    await this.guardTarget(target, options.signal);
    const owner = (await this.users(target, options.signal)).find((user) => user.userId === 0);
    if (!owner) throw new AdapterError('Android owner is missing');
    await this.applySetting(
      target,
      owner,
      { namespace: 'global', key: 'adb_wifi_enabled', value: '0' },
      options,
    );
    await this.guardUser(target, owner, options.signal);
    const result = await this.runAdb(
      [
        '-s',
        target.transport.serial,
        'shell',
        ...['settings', 'put', 'global', 'adb_enabled', '0'].map(shellQuote),
      ],
      { ...options, mutation: true, timeoutMs: 30_000, check: false, expectedExitCodes: [0, 255] },
    );
    options.signal?.throwIfAborted();
    if (result.code === 0) return;
    if (!expectedShutdownClosure(result)) throw shutdownUncertain();
    const listing = await this.runAdb(['devices', '-l'], {
      ...signalOptions(options.signal),
      timeoutMs: 5000,
      check: false,
    });
    options.signal?.throwIfAborted();
    assertShutdownTransport(listing, target.transport.serial);
  }
  async flash(target: SelectedTarget, image: VerifiedImage, options: OperationOptions): Promise<void> {
    await flashImage(this.runner, this.fastboot, target, image, options);
  }
}

function assertEnrolledTransport(target: SelectedTarget): void {
  const { device, transport } = target;
  if (
    !device.transports.some((item) => item.kind === transport.kind && item.serial === transport.serial) ||
    !/^[A-Za-z0-9._:[\]%-]+$/.test(transport.serial)
  )
    throw new AdapterError('Transport is not enrolled for the selected device', 'IDENTITY_CHANGED');
  assertPhysicalTransport(target);
}
function assertPhysicalTransport({ device, transport }: SelectedTarget): void {
  if (
    device.kind === 'pixel' &&
    (device.canonicalSerial.includes(':') || device.canonicalSerial.includes('_adb-tls-'))
  )
    throw new AdapterError('Physical identity must be a canonical USB serial');
  if (transport.kind === 'usb' && transport.serial !== device.canonicalSerial)
    throw new AdapterError('USB transport does not match the physical identity', 'IDENTITY_CHANGED');
}
function assertEmulatorTransport({ device, transport }: SelectedTarget): void {
  if (
    transport.kind !== 'emulator' ||
    transport.serial !== device.canonicalSerial ||
    !/^emulator-\d+$/.test(device.canonicalSerial)
  )
    throw new AdapterError('Emulator transport identity changed', 'IDENTITY_CHANGED');
}
function policyUser(users: AndroidUserIdentity[], profile: ProfilePolicy): AndroidUserIdentity | undefined {
  const matches = users.filter((user) =>
    profile.kind === 'owner' ? user.userId === 0 : user.userId !== 0 && user.name === profile.name,
  );
  if (matches.length > 1) throw new AdapterError('Multiple Android users match a policy profile');
  return matches[0];
}

function shutdownUncertain(): AdapterError {
  return new AdapterError(
    'Debugging shutdown request is uncertain; inspect the phone and retained evidence before recovery',
    'MUTATION_UNCERTAIN',
  );
}
function expectedShutdownClosure(result: CommandResult): boolean {
  if (result.code !== 255 || result.stdout.trim()) return false;
  const diagnostic = result.stderr.trim();
  return (
    !diagnostic ||
    /^(?:adb: )?(?:error: )?(?:closed|connection (?:closed|reset by peer)|EOF)$/iu.test(diagnostic)
  );
}
function assertShutdownTransport(listing: CommandResult, serial: string): void {
  const lines = listing.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (listing.code !== 0 || listing.stderr.trim() || lines.shift() !== 'List of devices attached')
    throw shutdownUncertain();
  const rows = lines.map((line) =>
    /^([A-Za-z0-9._:[\]%-]+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|host|rescue|no permissions)(?:\s+.*)?$/u.exec(
      line,
    ),
  );
  if (rows.some((row) => !row)) throw shutdownUncertain();
  const selected = rows.filter((row) => row?.[1] === serial);
  if (selected.length > 1 || (selected.length === 1 && selected[0]?.[2] !== 'offline'))
    throw shutdownUncertain();
}
