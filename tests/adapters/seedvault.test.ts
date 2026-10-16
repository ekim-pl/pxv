import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digest,
  sameAndroidUser,
  type AndroidUserIdentity,
  type PolicyPack,
  type RecoveryObligation,
  type SeedvaultAdapterDefinition,
  type SeedvaultProfileIdentity,
  type SeedvaultProfileProgress,
  type SelectedTarget,
} from '@pxv/contracts';
import {
  AndroidAdapter,
  SeedvaultAdapter,
  type CommandOptions,
  type SeedvaultExecutionOptions,
} from '../../packages/adapters/src/index.js';
import {
  foregroundUser,
  seedvaultTokens,
  userUnlocked,
} from '../../packages/adapters/src/seedvault-inspection.js';
import { seedvaultJobsQuiescent } from '../../packages/adapters/src/seedvault-jobs.js';
import {
  seedvaultGuard,
  seedvaultNode,
  seedvaultSnapshot,
} from '../../packages/adapters/src/seedvault-ui.js';
import { obligationWriter } from './obligations.js';

const owner = { userId: 0, serialNo: 0, name: 'Owner' };
const secondary = { userId: 10, serialNo: 42, name: 'Work' };
const pkg = 'com.stevesoltys.seedvault';
const target: SelectedTarget = {
  device: {
    assetId: 'fixture',
    canonicalSerial: 'PIXEL',
    kind: 'pixel',
    model: 'Pixel 8a',
    codename: 'akita',
    groups: [],
    transports: [{ kind: 'wifi', serial: '192.0.2.1:1234' }],
  },
  transport: { kind: 'wifi', serial: '192.0.2.1:1234' },
};
const identity = {
  packageId: pkg as 'com.stevesoltys.seedvault',
  versionCode: 36050070,
  signerSha256: 'a'.repeat(64),
};
const profile: SeedvaultProfileIdentity = {
  profileId: 'work',
  user: secondary,
  package: identity,
  backup: { enabled: true, transportPackage: pkg },
  unlocked: true,
};
const select = (id: string) => ({ resourceId: pkg + ':id/' + id });
const completion = {
  apps: select('apps'),
  files: select('files'),
  finalized: select('finalized'),
  idle: select('idle'),
  generation: select('generation'),
  fileGeneration: select('file-generation'),
};
class FixtureAndroid extends AndroidAdapter {
  current = 0;
  unlocked = true;
  done = false;
  fileObserved = false;
  holdServiceAfterBackup = false;
  skipFilesRunning = false;
  generationLabel = 'Fixture generation';
  filesGenerationLabel = 'Fixture files generation';
  appsRestored = false;
  secret = false;
  secureWindow = false;
  serviceRunning = false;
  serviceText = '';
  jobsText = 'Registered 0 jobs:\n  (none)\nPending queue:\n  (none)';
  staleUser = false;
  version = identity.versionCode;
  activated = true;
  tokens = ['1'];
  commands: string[][] = [];
  mutations: string[][] = [];
  dumps = 0;
  overrides = new Map<string, string>();
  constructor() {
    super({ runner: { run: () => Promise.reject(new Error('No live commands in Seedvault fixture')) } });
  }
  override guardTarget() {
    return Promise.resolve();
  }
  override guardUser(_target: SelectedTarget, user: AndroidUserIdentity) {
    if (this.staleUser || ![owner, secondary].some((candidate) => sameAndroidUser(candidate, user)))
      return Promise.reject(new Error('Stable Android user changed'));
    return Promise.resolve();
  }
  override users() {
    return Promise.resolve([owner, secondary]);
  }
  override installedIdentity() {
    return Promise.resolve({ ...identity, versionCode: this.version });
  }
  override shell(_target: SelectedTarget, args: string[], options: CommandOptions = {}) {
    options.signal?.throwIfAborted();
    this.commands.push(args);
    if (options.mutation) this.mutations.push(args);
    return Promise.resolve(this.respond(args));
  }
  private respond(args: string[]): string {
    const override = this.overrides.get(args.join(' '));
    if (override !== undefined) return override;
    if (args[0] === 'getprop') return 'fixture/build';
    if (args[0] === 'cmd')
      return '2 users:\n0: id=0, name=Owner, type=android.os.usertype.full.SYSTEM, flags=FULL|SYSTEM\n1: id=10, name=Work, type=android.os.usertype.full.SECONDARY, flags=FULL';
    if (args[0] === 'bmgr') return this.backupOutput(args);
    if (args[0] === 'pm') return 'package:' + pkg + ' uid:' + (100000 * Number(args[4]) + 10017);
    if (args[0] === 'am') return this.activity(args);
    if (args.slice(0, 3).join(' ') === 'dumpsys window policy')
      return 'KeyguardServiceDelegate\n showing=false';
    if (args.slice(0, 3).join(' ') === 'dumpsys window windows')
      return `Window #0 Window{abc u${this.current} ${pkg}/${this.secret ? '.ui.recoverycode.RecoveryCodeActivity' : '.settings.SettingsActivity'}}:\n mAttrs={fl=${this.secureWindow ? '0x2000' : '0x100'}}\nmCurrentFocus=Window{abc u${this.current} ${pkg}/${this.secret ? '.ui.recoverycode.RecoveryCodeActivity' : '.settings.SettingsActivity'}}`;
    if (args[1] === 'jobscheduler') return this.jobsText;
    if (args[0] === 'dumpsys')
      return (
        'ACTIVITY MANAGER SERVICES\n' +
        (this.serviceRunning
          ? 'ServiceRecord{abc u10 com.stevesoltys.seedvault/.restore.RestoreService}'
          : this.serviceText || '  (nothing)')
      );
    if (args[0] === 'uiautomator') {
      this.dumps++;
      return this.xml();
    }
    if (args[0] === 'input') {
      if (this.commands.at(-2)?.[0] !== 'dumpsys') throw new Error('Tap was not guarded');
      if (args[2] === '45') this.appsRestored = true;
      if (args[2] === '25' || args[2] === '65') {
        this.done = true;
        this.tokens = ['1', '2'];
        this.serviceRunning = this.holdServiceAfterBackup;
        this.fileObserved = this.skipFilesRunning;
      }
      return '';
    }
    throw new Error('Unhandled fixture command ' + args.join(' '));
  }
  private activity(args: string[]): string {
    if (args[1] === 'get-current-user') return String(this.current);
    if (args[1] === 'get-started-user-state') return this.unlocked ? 'RUNNING_UNLOCKED' : 'RUNNING_LOCKED';
    if (args[1] === 'switch-user') {
      this.current = Number(args[2]);
      return '';
    }
    if (args[1] === 'start') return 'Starting: Intent';
    throw new Error('Unknown activity command');
  }
  private backupOutput(args: string[]): string {
    if (args[3] === 'activated')
      return 'Backup Manager currently ' + (this.activated ? 'activated' : 'deactivated');
    if (args[3] === 'enabled') return 'Backup Manager currently enabled';
    if (args[4] === 'transports') return '* ' + pkg + '/.transport.ConfigurableBackupTransport';
    return this.tokens.map((token) => token + ' : Fixture device').join('\n');
  }
  private xml(): string {
    const ids = this.done
      ? this.fileObserved
        ? ['apps', 'files', 'finalized', 'idle', 'generation', 'file-generation']
        : ['files-running']
      : this.appsRestored
        ? ['files-source', 'files-start']
        : ['start', 'source', 'app-start'];
    if (this.done) this.fileObserved = true;
    return (
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy>' +
      ids
        .map(
          (id) =>
            `<node package="${pkg}" resource-id="${pkg}:id/${id}" text="${id === 'generation' || id === 'source' ? this.generationLabel : id === 'file-generation' || id === 'files-source' ? this.filesGenerationLabel : id}" enabled="true" bounds="${this.bounds(id)}" />`,
        )
        .join('') +
      '</hierarchy>'
    );
  }
  private bounds(id: string): string {
    const left = ({ start: 20, 'app-start': 40, 'files-start': 60 } as Record<string, number>)[id] ?? 0;
    return `[${left},0][${left + 10},10]`;
  }
}
let directory: string;
let definition: SeedvaultAdapterDefinition;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'seedvault-fixture-'));
  const path = join(directory, 'acceptance.json');
  definition = {
    schemaVersion: 1,
    id: 'fixture-only',
    buildFingerprint: 'fixture/build',
    package: identity,
    acceptance: { path, sha256: '0'.repeat(64) },
    activities: ['.settings.SettingsActivity'],
    restoreSourceResourceId: select('source').resourceId,
    restoreFileSourceResourceId: select('files-source').resourceId,
    backup: {
      steps: [
        { action: 'start-backup', selector: select('start') },
        { action: 'observe-files-running', selector: select('files-running'), timeoutMs: 2 },
      ],
      completion,
    },
    restore: {
      steps: [
        { action: 'select-source' },
        { action: 'start-restore', selector: select('app-start') },
        { action: 'select-file-source' },
        { action: 'start-files-restore', selector: select('files-start') },
        { action: 'observe-files-running', selector: select('files-running'), timeoutMs: 2 },
      ],
      completion,
    },
  };
  await saveAcceptance(definition);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function context(): {
  options: SeedvaultExecutionOptions;
  recorded: RecoveryObligation[];
  resolved: string[];
  progress: SeedvaultProfileProgress[];
} {
  const recorded: RecoveryObligation[] = [],
    resolved: string[] = [],
    progress: SeedvaultProfileProgress[] = [];
  return {
    recorded,
    resolved,
    progress,
    options: {
      lease: {},
      obligations: obligationWriter(
        'operation',
        (value) => {
          recorded.push(structuredClone(value));
          return Promise.resolve();
        },
        (id) => {
          resolved.push(id);
          return Promise.resolve();
        },
      ),
      saveProgress: (value) => {
        progress.push(structuredClone(value));
        return Promise.resolve();
      },
    },
  };
}
async function saveAcceptance(
  adapter: SeedvaultAdapterDefinition,
  changes: Record<string, unknown> = {},
): Promise<void> {
  const { acceptance, ...recipe } = adapter;
  const coverage = {
    appsBackup: true,
    apksBackup: true,
    filesBackup: true,
    appsRestore: true,
    apksRestore: true,
    filesRestore: true,
    finalized: true,
    durableGeneration: true,
    evidenceSha256: 'c'.repeat(64),
  };
  const content = JSON.stringify({
    schemaVersion: 1,
    adapterId: adapter.id,
    buildFingerprint: adapter.buildFingerprint,
    package: adapter.package,
    recipeDigest: digest(recipe),
    testedAt: '2026-10-16T10:00:00Z',
    result: 'pass',
    profiles: [
      { profileId: 'owner', userSerialNo: 0, ...coverage },
      { profileId: 'work', userSerialNo: 42, ...coverage },
    ],
    ...changes,
  });
  await writeFile(acceptance.path, content, { mode: 0o600 });
  adapter.acceptance.sha256 = createHash('sha256').update(content).digest('hex');
}
describe('supervised Seedvault UI operations', () => {
  it('creates a new durable generation through normal UI, covering apps/files/finalization and restores foreground', async () => {
    const android = new FixtureAndroid(),
      state = context();
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw new Error(result.instructions);
    expect(result.evidence.token).toBe('2');
    expect(result.evidence.source.selector.text).toBe('Fixture generation');
    expect(state.recorded.map((value) => value.kind)).toEqual(['seedvault-job', 'seedvault-foreground']);
    expect(state.resolved).toHaveLength(2);
    expect(android.current).toBe(0);
    expect(android.commands.some((args) => args.includes('backupnow') || args.includes('root'))).toBe(false);
    expect(state.progress.some((value) => value.inFlight === 0)).toBe(true);
  });
  it('requires the requested restore token instead of selecting an available latest backup', async () => {
    const android = new FixtureAndroid(),
      state = context();
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      {
        operation: 'restore',
        adapter: definition,
        sources: [
          {
            profileId: 'work',
            token: 'f',
            selector: { ...select('source'), text: 'Fixture generation' },
            filesSelector: { ...select('files-source'), text: 'Fixture files generation' },
          },
        ],
      },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
    expect(state.resolved).toHaveLength(0);
  });
  it('never dumps recovery-code screens and leaves remote job ownership unresolved', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.secret = true;
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    expect(android.dumps).toBe(0);
    expect(state.resolved).toHaveLength(0);
  });
  it('does not dump a secure recovery-code fragment hosted inside SettingsActivity', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.secureWindow = true;
    expect(
      (
        await new SeedvaultAdapter(android).executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('manual-pending');
    expect(android.dumps).toBe(0);
  });
  it('does not accept a stale restore completion before the reviewed source and restore trigger', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.done = true;
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      {
        operation: 'restore',
        adapter: definition,
        sources: [
          {
            profileId: 'work',
            token: '1',
            selector: { ...select('source'), text: 'Fixture generation' },
            filesSelector: { ...select('files-source'), text: 'Fixture files generation' },
          },
        ],
      },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
    expect(state.resolved).toHaveLength(0);
  });
  it('restores the exact requested generation only after selecting and starting it', async () => {
    const android = new FixtureAndroid(),
      state = context();
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      {
        operation: 'restore',
        adapter: definition,
        sources: [
          {
            profileId: 'work',
            token: '1',
            selector: { ...select('source'), text: 'Fixture generation' },
            filesSelector: { ...select('files-source'), text: 'Fixture files generation' },
          },
        ],
      },
      state.options,
    );
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw new Error(result.instructions);
    expect(result.evidence.token).toBe('1');
    expect(android.mutations.filter((args) => args[0] === 'input')).toHaveLength(4);
  });
  it('does not mutate an unknown build/signer, missing accepted adapter or changed acceptance bytes', async () => {
    const android = new FixtureAndroid();
    android.version++;
    const service = new SeedvaultAdapter(android),
      state = context();
    expect(
      (
        await service.executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('manual-pending');
    expect(
      (await service.executeProfile(target, profile, { operation: 'backup' }, state.options)).status,
    ).toBe('manual-pending');
    expect(android.mutations).toHaveLength(0);
    await writeFile(definition.acceptance.path, 'changed');
    await expect(
      service.executeProfile(target, profile, { operation: 'backup', adapter: definition }, state.options),
    ).rejects.toThrow('acceptance');
  });
  it('refuses service cleanup while a remote job may still run and never kills it', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.serviceRunning = true;
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    expect(state.resolved).toHaveLength(0);
    expect(android.commands.some((args) => args.includes('force-stop') || args.includes('stopservice'))).toBe(
      false,
    );
    android.staleUser = true;
    await expect(
      new SeedvaultAdapter(android).cleanup(target, state.recorded[0]!, {
        lease: {},
        operationId: state.recorded[0]!.ownerOperationId,
      }),
    ).rejects.toThrow('Stable Android user');
  });
  it("allows an idle bound transport and another user's services without confusing their ownership", async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.serviceText =
      'ServiceRecord{idle u10 com.stevesoltys.seedvault/.transport.ConfigurableBackupTransportService}\nServiceRecord{other u0 com.stevesoltys.seedvault/.restore.RestoreService}';
    expect(
      (
        await new SeedvaultAdapter(android).executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('measured');
  });
  it('recovers secondary-user job quiescence before restoring the previous owner foreground', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.holdServiceAfterBackup = true;
    const service = new SeedvaultAdapter(android);
    expect(
      (
        await service.executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('manual-pending');
    expect(android.current).toBe(10);
    android.serviceRunning = false;
    for (const obligation of state.recorded)
      await service.cleanup(target, obligation, { lease: {}, operationId: obligation.ownerOperationId });
    expect(android.current).toBe(0);
  });
  it('retains remote-job ownership for queued WorkManager work even without an active service', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.jobsText =
      'Registered 1 jobs:\n JOB #u10a17/42: com.stevesoltys.seedvault/androidx.work.impl.background.systemjob.SystemJobService\nPending queue:\n (none)';
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    if (result.status === 'manual-pending') expect(result.instructions).toContain('queued or running');
    expect(state.resolved).toHaveLength(0);
    expect(android.commands.some((args) => args.includes('cancel') || args.includes('force-stop'))).toBe(
      false,
    );
  });
  it("does not confuse another Android user's queued backup with the selected user's job", async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.jobsText =
      'Registered 1 jobs:\n JOB #u0a17/42: com.stevesoltys.seedvault/androidx.work.impl.background.systemjob.SystemJobService\nPending queue:\n (none)';
    expect(
      (
        await new SeedvaultAdapter(android).executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('measured');
  });
  it('requires qualified two-profile restore evidence, not merely a matching file hash', async () => {
    const android = new FixtureAndroid(),
      state = context();
    await saveAcceptance(definition, { profiles: [] });
    await expect(
      new SeedvaultAdapter(android).executeProfile(
        target,
        profile,
        { operation: 'backup', adapter: definition },
        state.options,
      ),
    ).rejects.toThrow();
    await saveAcceptance(definition, { recipeDigest: 'f'.repeat(64) });
    await expect(
      new SeedvaultAdapter(android).executeProfile(
        target,
        profile,
        { operation: 'backup', adapter: definition },
        state.options,
      ),
    ).rejects.toThrow('exact recipe');
    await saveAcceptance(definition, { buildFingerprint: 'another/build' });
    await expect(
      new SeedvaultAdapter(android).executeProfile(
        target,
        profile,
        { operation: 'backup', adapter: definition },
        state.options,
      ),
    ).rejects.toThrow('exact recipe');
    expect(android.mutations).toHaveLength(0);
  });
  it('keeps private completion pending without a fresh per-visit files observation', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.secret = true;
    const first = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    if (first.status !== 'manual-pending' || !first.progress) throw new Error('Expected private checkpoint');
    android.secret = false;
    android.done = true;
    android.tokens = ['1', '2'];
    const resumed = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      { ...state.options, progress: first.progress },
    );
    expect(resumed.status).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
  });
  it('does not replay an ambiguous in-flight tap when resuming private completion', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.secret = true;
    const first = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    if (first.status !== 'manual-pending' || !first.progress)
      throw new Error('Expected private pending checkpoint');
    android.secret = false;
    android.done = true;
    android.tokens = ['1', '2'];
    const resumed = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      { ...state.options, progress: { ...first.progress, inFlight: 0 } },
    );
    expect(resumed.status).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
  });
});
describe('all persistent full Android users', () => {
  it.each(['', 'android.os.usertype.'])(
    'recognizes verbose persistent full users with type prefix %s',
    async (prefix) => {
      const android = new FixtureAndroid();
      android.overrides.set(
        'cmd user list -v',
        '2 users:\n\n0: id=0, name=Owner, type=' +
          prefix +
          'full.SYSTEM, flags=ADMIN|FULL|INITIALIZED|MAIN|PRIMARY|SYSTEM (running) (current) (visible)\n' +
          '1: id=10, name=Work, type=' +
          prefix +
          'full.SECONDARY, flags=FULL|INITIALIZED (running)',
      );
      const inspected = await new SeedvaultAdapter(android).inspect(target, fixturePolicy());
      expect(inspected.profiles.map((item) => item.user)).toEqual([owner, secondary]);
      expect(inspected.unsupportedUsers).toEqual([]);
    },
  );
  it('discovers reviewed users and exposes guest/work-profile exclusions', async () => {
    const guest = { userId: 11, serialNo: 43, name: 'Guest' };
    const android = new FixtureAndroid();
    vi.spyOn(android, 'users').mockResolvedValue([owner, secondary, guest]);
    android.overrides.set(
      'cmd user list -v',
      'UserInfo{0:Owner:13} serialNo=0\nUserInfo{10:Work:0} serialNo=42\nUserInfo{11:Guest:104} serialNo=43',
    );
    const inspected = await new SeedvaultAdapter(android).inspect(target, fixturePolicy());
    expect(inspected.profiles.map((item) => item.user)).toEqual([owner, secondary]);
    expect(inspected.unsupportedUsers).toEqual([guest]);
  });
  it('reconciles every full user against policy rather than silently omitting it', async () => {
    const android = new FixtureAndroid();
    const policy: PolicyPack = {
      schemaVersion: 1,
      id: 'test',
      name: 'fixture',
      version: '0.1.0',
      capabilities: [],
      repositories: [],
      requiredAttestations: [],
      profiles: [
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
    const inspection = await new SeedvaultAdapter(android).inspect(target, policy);
    expect(inspection.profiles.map((item) => item.profileId)).toEqual(['owner', 'unreviewed-user-10']);
  });
});

function fixturePolicy(): PolicyPack {
  return {
    schemaVersion: 1,
    id: 'fixture',
    name: 'Fixture',
    version: '0.1.0',
    capabilities: [],
    repositories: [],
    requiredAttestations: [],
    profiles: [owner, secondary].map((user) => ({
      id: user.userId === 0 ? 'owner' : 'work',
      name: user.name,
      kind: user.userId === 0 ? 'owner' : 'secondary',
      packages: [],
      settings: [],
      permissions: [],
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    })),
  };
}
describe('Seedvault diagnostic failures', () => {
  it.each(['id=0, name=Owner', 'UserInfo{0:Owner:not-flags} serialNo=0', 'unrecognized'])(
    'rejects unclassifiable user state: %s',
    async (output) => {
      const android = new FixtureAndroid();
      vi.spyOn(android, 'users').mockResolvedValue([owner]);
      android.overrides.set('cmd user list -v', output);
      await expect(new SeedvaultAdapter(android).inspect(target, fixturePolicy())).rejects.toThrow();
    },
  );
  it.each([
    'type=android.os.usertype.full.SECONDARY, flags=EPHEMERAL',
    'type=android.os.usertype.full.SECONDARY, flags=0x100',
    'type=android.os.usertype.profile.MANAGED, flags=PROFILE',
    'type=full.SECONDARY, flags=FULL|EPHEMERAL',
    'type=full.SECONDARY, flags=0x100',
    'type=full.SECONDARY, flags=FULL|GUEST',
    'type=full.SECONDARY, flags=FULL|PARTIAL',
    'type=full.SECONDARY, flags=FULL|REMOVING',
    'type=full.SECONDARY, flags=FULL (partial)',
    'type=full.SECONDARY, flags=FULL (removing)',
    'type=full.GUEST, flags=FULL',
    'type=profile.MANAGED, flags=PROFILE',
    'type=profile.PRIVATE, flags=PROFILE',
    'type=full.SECONDARY_EXTRA, flags=FULL',
    'type=unknown.full.SECONDARY, flags=FULL',
  ])(
    'classifies temporary, incomplete or unsupported user types without silently including them: %s',
    async (suffix) => {
      const android = new FixtureAndroid();
      android.overrides.set(
        'cmd user list -v',
        '0: id=0, name=Owner, type=android.os.usertype.full.SYSTEM, flags=FULL\n1: id=10, name=Work, ' +
          suffix,
      );
      expect((await new SeedvaultAdapter(android).inspect(target, fixturePolicy())).unsupportedUsers).toEqual(
        [secondary],
      );
    },
  );
  it('reports deactivated backup and stopped/locked users as diagnostics', async () => {
    const android = new FixtureAndroid();
    android.activated = false;
    android.unlocked = false;
    const inspected = await new SeedvaultAdapter(android).inspect(
      target,
      fixturePolicy(),
      new AbortController().signal,
    );
    expect(inspected.profiles.every((item) => !item.backup.enabled && !item.unlocked)).toBe(true);
    expect(android.commands.some((args) => args[3] === 'enabled')).toBe(false);
  });
  it('rejects unknown activation output and user changes during inspection', async () => {
    const android = new FixtureAndroid();
    android.overrides.set('bmgr --user 0 activated', 'unknown');
    await expect(new SeedvaultAdapter(android).inspect(target, fixturePolicy())).rejects.toThrow(
      'activation',
    );
    android.overrides.clear();
    vi.spyOn(android, 'users')
      .mockResolvedValueOnce([owner, secondary])
      .mockResolvedValueOnce([owner, { ...secondary, serialNo: 999 }]);
    await expect(new SeedvaultAdapter(android).inspect(target, fixturePolicy())).rejects.toThrow(
      'users changed',
    );
  });
  it('rejects unknown foreground IDs, unlock state, and malformed/duplicate backup tokens', async () => {
    const android = new FixtureAndroid();
    android.overrides.set('am get-current-user', 'current');
    await expect(foregroundUser(android, target)).rejects.toThrow('Foreground');
    android.overrides.set('am get-started-user-state 10', 'unknown');
    await expect(userUnlocked(android, target, secondary)).rejects.toThrow('unlock');
    android.overrides.set('am get-started-user-state 10', 'User is not started: 10');
    expect(await userUnlocked(android, target, secondary)).toBe(false);
    for (const text of ['Unable to request restore sets', '1 : first\n1 : duplicate']) {
      android.overrides.set('bmgr --user 10 list sets', text);
      await expect(seedvaultTokens(android, target, secondary)).rejects.toThrow('durable');
    }
    android.overrides.set('bmgr --user 10 list sets', 'No restore sets');
    expect(await seedvaultTokens(android, target, secondary, new AbortController().signal)).toEqual([]);
  });
});
describe('Seedvault UI and ownership failure paths', () => {
  it('does not combine a new app token with a stale files summary', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.skipFilesRunning = true;
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(android.tokens).toContain('2');
    expect(result.status).toBe('manual-pending');
    expect(state.resolved).toHaveLength(0);
  });
  it('resumes only after this visit observed fresh files running and later proved job quiescence', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.holdServiceAfterBackup = true;
    const service = new SeedvaultAdapter(android),
      request = { operation: 'backup' as const, adapter: definition };
    const first = await service.executeProfile(target, profile, request, state.options);
    if (first.status !== 'manual-pending' || !first.progress) throw new Error('Expected running job');
    expect(first.progress.step).toBe(2);
    android.serviceRunning = false;
    const resumed = await service.executeProfile(target, profile, request, {
      ...state.options,
      progress: first.progress,
    });
    expect(resumed.status).toBe('measured');
    expect(android.mutations.filter((args) => args[0] === 'input')).toHaveLength(1);
  });
  it('rejects changed recipe progress and invalid cursors instead of replaying reviewed work', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.secret = true;
    const service = new SeedvaultAdapter(android),
      request = { operation: 'backup' as const, adapter: definition };
    const first = await service.executeProfile(target, profile, request, state.options);
    if (first.status !== 'manual-pending' || !first.progress) throw new Error('Expected private checkpoint');
    android.secret = false;
    await expect(
      service.executeProfile(target, profile, request, {
        ...state.options,
        progress: { ...first.progress, adapterDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow('adapter changed');
    await expect(
      service.executeProfile(target, profile, request, {
        ...state.options,
        progress: { ...first.progress, step: 99 },
      }),
    ).rejects.toThrow('cursor');
  });
  it('rejects an unbound previous foreground user and pauses before running in a locked profile', async () => {
    const android = new FixtureAndroid(),
      state = context(),
      service = new SeedvaultAdapter(android);
    android.current = 99;
    await expect(
      service.executeProfile(target, profile, { operation: 'backup', adapter: definition }, state.options),
    ).rejects.toThrow('foreground user');
    android.current = 0;
    android.unlocked = false;
    expect(
      (
        await service.executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
  });
  it('requires a unique new durable generation and a visible generation label', async () => {
    for (const invalid of ['unchanged', 'missing-label']) {
      const android = new FixtureAndroid(),
        state = context();
      if (invalid === 'unchanged') android.overrides.set('bmgr --user 10 list sets', '1 : Existing set');
      else android.generationLabel = '';
      const result = await new SeedvaultAdapter(android).executeProfile(
        target,
        profile,
        { operation: 'backup', adapter: definition },
        state.options,
      );
      expect(result.status).toBe('manual-pending');
      if (result.status === 'manual-pending')
        expect(result.instructions).toContain(invalid === 'unchanged' ? 'durable' : 'generation label');
    }
  });
  it.each(['apps', 'files'])(
    'rejects a changed displayed %s restore generation after the current restore trigger',
    async (category) => {
      const android = new FixtureAndroid(),
        state = context();
      android.holdServiceAfterBackup = true;
      const service = new SeedvaultAdapter(android),
        request = {
          operation: 'restore' as const,
          adapter: definition,
          sources: [
            {
              profileId: 'work',
              token: '1',
              selector: { ...select('source'), text: 'Fixture generation' },
              filesSelector: { ...select('files-source'), text: 'Fixture files generation' },
            },
          ],
        };
      const first = await service.executeProfile(target, profile, request, state.options);
      if (first.status !== 'manual-pending' || !first.progress) throw new Error('Expected pending cleanup');
      if (category === 'apps') android.generationLabel = 'Another generation';
      else android.filesGenerationLabel = 'Another files generation';
      android.serviceRunning = false;
      const resumed = await service.executeProfile(target, profile, request, {
        ...state.options,
        progress: first.progress,
      });
      expect(resumed.status).toBe('manual-pending');
      if (resumed.status === 'manual-pending')
        expect(resumed.instructions).toContain(
          category === 'apps' ? 'reviewed source label' : 'reviewed files source label',
        );
    },
  );
  it('fails closed on corrupt UI during resumed completion instead of converting it to a successful/manual result', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.holdServiceAfterBackup = true;
    const service = new SeedvaultAdapter(android),
      request = { operation: 'backup' as const, adapter: definition };
    const first = await service.executeProfile(target, profile, request, state.options);
    if (first.status !== 'manual-pending' || !first.progress) throw new Error('Expected pending cleanup');
    android.overrides.set(
      'uiautomator dump /proc/self/fd/1',
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy><unsupported/></hierarchy>',
    );
    await expect(
      service.executeProfile(target, profile, request, { ...state.options, progress: first.progress }),
    ).rejects.toThrow('unsupported');
  });
  it('runs public wait steps without tapping them', async () => {
    definition.backup.steps.unshift({ action: 'wait', selector: select('start'), timeoutMs: 2 });
    definition.backup.steps.push({ action: 'wait', selector: select('idle') });
    await saveAcceptance(definition);
    const android = new FixtureAndroid(),
      state = context();
    expect(
      (
        await new SeedvaultAdapter(android).executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          state.options,
        )
      ).status,
    ).toBe('measured');
    expect(android.mutations.filter((args) => args[0] === 'input')).toHaveLength(1);
  });
  it('honors cancellation and explicit signals through inspection and normal execution', async () => {
    const android = new FixtureAndroid(),
      state = context(),
      signal = new AbortController().signal;
    expect(
      (
        await new SeedvaultAdapter(android).executeProfile(
          target,
          profile,
          { operation: 'backup', adapter: definition },
          { ...state.options, signal },
        )
      ).status,
    ).toBe('measured');
    await expect(
      new SeedvaultAdapter(android).executeProfile(
        target,
        profile,
        { operation: 'backup', adapter: definition },
        { ...state.options, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
  });
  it.each(['KeyguardServiceDelegate\n showing=true', 'unknown keyguard state'])(
    'leaves locked/unknown keyguard state manual: %s',
    async (output) => {
      const android = new FixtureAndroid();
      android.current = 10;
      android.overrides.set('dumpsys window policy', output);
      await expect(seedvaultGuard(android, target, secondary, definition)).rejects.toThrow('lock screen');
    },
  );
  it('requires foreground/unlocked ownership and a focused public activity', async () => {
    const android = new FixtureAndroid();
    await expect(seedvaultGuard(android, target, secondary, definition)).rejects.toThrow('Foreground');
    android.current = 10;
    android.unlocked = false;
    await expect(seedvaultGuard(android, target, secondary, definition)).rejects.toThrow('Foreground');
    android.unlocked = true;
    android.overrides.set('dumpsys window windows', 'mCurrentFocus=Window{abc u0 org.other.app/.Main}');
    await expect(seedvaultSnapshot(android, target, secondary, definition)).rejects.toThrow('Focus');
    expect(android.dumps).toBe(0);
  });
  it('does not inspect windows with missing attributes or symbolic secure flags', async () => {
    const android = new FixtureAndroid();
    android.current = 10;
    for (const detail of [
      '',
      'Window #0 Window{abc u10 ' + pkg + '/.settings.SettingsActivity}:\n mAttrs={fl=SECURE|FULLSCREEN}\n',
    ]) {
      android.overrides.set(
        'dumpsys window windows',
        detail + 'mCurrentFocus=Window{abc u10 ' + pkg + '/.settings.SettingsActivity}',
      );
      await expect(seedvaultSnapshot(android, target, secondary, definition)).rejects.toThrow('private');
    }
    expect(android.dumps).toBe(0);
  });
  it('rejects secret input in an otherwise accepted activity and waits only for bounded public selectors', async () => {
    const android = new FixtureAndroid();
    android.current = 10;
    android.overrides.set(
      'uiautomator dump /proc/self/fd/1',
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="' +
        pkg +
        '" resource-id="x" enabled="true" password="true" /></hierarchy>',
    );
    await expect(seedvaultSnapshot(android, target, secondary, definition)).rejects.toThrow('secret input');
    android.overrides.clear();
    await expect(
      seedvaultNode(
        android,
        target,
        secondary,
        definition,
        select('missing'),
        2,
        new AbortController().signal,
      ),
    ).rejects.toThrow('checkpoint');
  });
  it('never drops an obligation for unknown scheduler state, malformed job identity or queued numeric UID', async () => {
    for (const output of [
      'unknown',
      'Registered 1 jobs:\n unexpected\nPending queue:',
      'Registered 1 jobs:\n JOB malformed\nPending queue:',
      'Registered 1 jobs:\n JOB #1010017/7: pending\nPending queue:',
    ]) {
      const android = new FixtureAndroid();
      android.jobsText = output;
      await expect(seedvaultJobsQuiescent(android, target, secondary)).rejects.toThrow();
    }
  });
  it('retains ownership when package UID cannot be tied to this user', async () => {
    const android = new FixtureAndroid(),
      state = context();
    android.overrides.set('pm list packages --user 10 -U ' + pkg, 'package:' + pkg + ' uid:10017');
    const result = await new SeedvaultAdapter(android).executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    expect(result.status).toBe('manual-pending');
    expect(state.resolved).toHaveLength(0);
  });
  it('rejects cleanup outside its operation and preserves unknown payloads', async () => {
    const android = new FixtureAndroid(),
      state = context(),
      service = new SeedvaultAdapter(android);
    android.serviceRunning = true;
    await service.executeProfile(
      target,
      profile,
      { operation: 'backup', adapter: definition },
      state.options,
    );
    const job = state.recorded[0]!,
      foreground = state.recorded[1]!;
    await expect(service.cleanup(target, job, { lease: {}, operationId: 'other' })).rejects.toThrow('scope');
    const { user: _user, ...withoutUser } = job;
    expect(_user).toEqual(secondary);
    await expect(
      service.cleanup(target, withoutUser, { lease: {}, operationId: job.ownerOperationId }),
    ).rejects.toThrow('stable Android user');
    await expect(
      service.cleanup(
        target,
        { ...job, payload: { ...job.payload, operation: 'wipe' } },
        { lease: {}, operationId: job.ownerOperationId },
      ),
    ).rejects.toThrow('job obligation');
    await expect(
      service.cleanup(
        target,
        { ...foreground, kind: 'unknown' },
        { lease: {}, operationId: foreground.ownerOperationId },
      ),
    ).rejects.toThrow('Unknown');
    android.current = 0;
    await expect(
      service.cleanup(target, foreground, { lease: {}, operationId: foreground.ownerOperationId }),
    ).resolves.toBeUndefined();
  });
});
