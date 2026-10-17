import { execFileSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AndroidUserIdentity, ExecutionPolicy, ProfilePolicy, SelectedTarget } from '@pxv/contracts';
import {
  AdapterError,
  AndroidAdapter,
  CredentialDefaultsService,
  type CommandOptions,
  type CommandResult,
} from '../../packages/adapters/src/index.js';

const target: SelectedTarget = {
  device: {
    assetId: 'phone-one',
    kind: 'pixel',
    canonicalSerial: 'PIXEL123',
    model: 'Pixel 8a',
    codename: 'akita',
    transports: [{ kind: 'usb', serial: 'PIXEL123' }],
    groups: [],
  },
  transport: { kind: 'usb', serial: 'PIXEL123' },
};
const owner: AndroidUserIdentity = { userId: 0, serialNo: 0, name: 'Owner' };
const work: AndroidUserIdentity = { userId: 10, serialNo: 42, name: 'work' };
const initialValues = {
  'owner-pin': '739184',
  'owner-current': 'current owner password',
  'work-password': 'work default pass',
  'duress-pin': '826495',
  'duress-password': 'emergency erase pass',
};
function profile(id: string, kind: 'owner' | 'secondary'): ProfilePolicy {
  return {
    id,
    name: id === 'owner' ? 'Owner' : id,
    kind,
    packages: [],
    settings: [],
    permissions: [],
    vpn: { packageId: null, alwaysOn: false, lockdown: false },
  };
}
function configuredPolicy(): ExecutionPolicy {
  return {
    id: 'credentials',
    name: 'Credentials',
    capabilities: [],
    repositories: [],
    requiredAttestations: [],
    profiles: [
      {
        ...profile('owner', 'owner'),
        defaultCredential: { type: 'pin', secretRef: 'owner-pin' },
        defaultDuress: {
          ownerCredentialRef: 'owner-current',
          pinRef: 'duress-pin',
          passwordRef: 'duress-password',
        },
      },
      {
        ...profile('work', 'secondary'),
        defaultCredential: { type: 'password', secretRef: 'work-password' },
      },
    ],
  };
}
class FakeAndroid extends AndroidAdapter {
  readonly calls: { args: string[]; options: CommandOptions }[] = [];
  readonly guardedUsers: AndroidUserIdentity[] = [];
  guards = 0;
  help =
    'lockSettings service commands:\n  set-pin [--user USER_ID] PIN\n  set-password [--user USER_ID] PASSWORD\n  set-duress-credentials --owner-credential CREDENTIAL --duress-pin PIN --duress-password PASSWORD\n';
  result: CommandResult = { code: 0, stdout: '', stderr: '' };
  failure?: Error;
  identityFailure = false;
  constructor() {
    super({ runner: { run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }) } });
  }
  override guardTarget(): Promise<void> {
    this.guards++;
    return Promise.resolve();
  }
  override guardUser(_target: SelectedTarget, user: AndroidUserIdentity): Promise<void> {
    this.guardedUsers.push(user);
    return this.identityFailure
      ? Promise.reject(new AdapterError('Android user identity changed'))
      : Promise.resolve();
  }
  override shell(_target: SelectedTarget, args: string[]): Promise<string> {
    this.calls.push({ args: ['shell', ...args], options: {} });
    return Promise.resolve(this.help);
  }
  override runAdb(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ args, options });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.result);
  }
  mutations() {
    return this.calls.filter((call) => call.options.mutation);
  }
}

describe('private credential defaults', () => {
  let outer: string;
  let root: string;
  let path: string;
  let policy: ExecutionPolicy;
  let android: FakeAndroid;
  let service: CredentialDefaultsService;
  const lease = {};
  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'pxv-credentials-'));
    root = join(outer, 'project');
    path = join(root, 'secrets', 'credentials', `${target.device.assetId}.json`);
    await mkdir(join(root, 'secrets', 'credentials'), { recursive: true, mode: 0o700 });
    await writeValues(initialValues);
    policy = configuredPolicy();
    android = new FakeAndroid();
    service = new CredentialDefaultsService(android, root, policy);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outer, { recursive: true, force: true });
  });

  async function writeValues(values: Record<string, string>) {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, values }), { mode: 0o600 });
  }
  function configured(id: string): ProfilePolicy {
    const selected = policy.profiles.find((candidate) => candidate.id === id);
    if (!selected) throw new Error('Missing test profile');
    return selected;
  }
  async function inputRejected() {
    const error: unknown = await service.preflight(target).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({
      code: 'CREDENTIAL_DEFAULT_INPUT',
      message: 'Credential defaults require a valid private device input file',
    });
    for (const value of Object.values(initialValues)) expect(inspect(error)).not.toContain(value);
    expect(android.mutations()).toEqual([]);
  }

  it('validates private inputs and installed commands without mutations or retaining values', async () => {
    await service.preflight(target);
    expect(android.guards).toBe(1);
    expect(android.calls).toEqual([{ args: ['shell', 'locksettings', 'help'], options: {} }]);
    expect(inspect(service)).not.toContain(initialValues['owner-current']);
  });
  it('needs no private file or Android inspection when no defaults are configured', async () => {
    policy.profiles = [profile('owner', 'owner')];
    await unlink(path);
    await service.preflight(target);
    expect(android.calls).toEqual([]);
  });
  it.each([0o644, 0o640, 0o660, 0o700, 0o400])('rejects private file mode %s', async (mode) => {
    await chmod(path, mode);
    await inputRejected();
  });
  it('rejects input not owned by the current effective user', async () => {
    const uid = process.geteuid?.() ?? -1;
    vi.spyOn(process, 'geteuid')
      .mockReturnValueOnce(uid)
      .mockReturnValueOnce(uid)
      .mockReturnValueOnce(uid)
      .mockReturnValue(uid + 1);
    await inputRejected();
  });
  it.each([
    ['root', 0o770],
    ['root', 0o707],
    ['secrets', 0o770],
    ['secrets', 0o707],
    ['credentials', 0o770],
    ['credentials', 0o707],
  ] as const)('rejects a writable %s directory with mode %s', async (component, mode) => {
    const directory =
      component === 'root'
        ? root
        : component === 'secrets'
          ? join(root, 'secrets')
          : join(root, 'secrets', 'credentials');
    await chmod(directory, mode);
    await inputRejected();
  });
  it.each([0, 1, 2])(
    'rejects directory %s when it is not owned by the effective user',
    async (directoryIndex) => {
      const uid = process.geteuid?.() ?? -1;
      let inspected = 0;
      vi.spyOn(process, 'geteuid').mockImplementation(() => (inspected++ === directoryIndex ? uid + 1 : uid));
      await inputRejected();
    },
  );
  it('allows non-writable directories readable and executable by other users', async () => {
    for (const directory of [root, join(root, 'secrets'), join(root, 'secrets', 'credentials')])
      await chmod(directory, 0o755);
    await service.preflight(target);
  });
  it.each(['', '{"schemaVersion":1,"values":', 'x'.repeat(64 * 1024 + 1)])(
    'rejects empty, malformed and oversized input without leaking content',
    async (data) => {
      await writeFile(path, data);
      await inputRejected();
    },
  );
  it.each([
    { schemaVersion: 2, values: initialValues },
    { schemaVersion: 1, values: initialValues, unexpected: 'private material' },
    { schemaVersion: 1, values: [] },
    { schemaVersion: 1, values: { ...initialValues, unused: 1234 } },
    { schemaVersion: 1, values: { ...initialValues, '../escape': 'private material' } },
  ])('rejects malformed private input structure', async (data) => {
    await writeFile(path, JSON.stringify(data));
    await inputRejected();
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1,"values":{}}',
    '{"schemaVersion":1,"values":{},"values":{}}',
    '{"schemaVersion":1,"values":{"owner-pin":"739184","owner-pin":"private replacement"}}',
    'schemaVersion: 1\nvalues: {}\n',
  ])(
    'rejects duplicate JSON keys and non-JSON syntax without exposing parser diagnostics',
    async (source) => {
      await writeFile(path, source);
      await inputRejected();
    },
  );
  it('rejects a directory and a symlink as the private input', async () => {
    await unlink(path);
    await mkdir(path);
    await inputRejected();
    await rm(path, { recursive: true });
    const other = join(outer, 'other.json');
    await writeFile(other, JSON.stringify({ schemaVersion: 1, values: initialValues }), { mode: 0o600 });
    await symlink(other, path);
    await inputRejected();
  });
  it.each(['secrets', 'credentials'])('rejects symlink traversal through %s', async (component) => {
    const parent = component === 'secrets' ? root : join(root, 'secrets');
    const original = join(parent, component);
    const moved = join(parent, `${component}-moved`);
    await rename(original, moved);
    await symlink(moved, original);
    await inputRejected();
  });
  it('rejects an asset identifier that escapes the deterministic private path', async () => {
    const invalid = { ...target, device: { ...target.device, assetId: '../other' } };
    await expect(service.preflight(invalid)).rejects.toMatchObject({ code: 'CREDENTIAL_DEFAULT_INPUT' });
  });
  it.each([
    { ...initialValues, 'owner-pin': '123' },
    { ...initialValues, 'owner-pin': '12a4' },
    { ...initialValues, 'work-password': 'x'.repeat(129) },
    { ...initialValues, 'work-password': 'a\nsecret' },
    { ...initialValues, 'work-password': 'a\u007fsecret' },
    { ...initialValues, 'work-password': 'zażółć' },
    { ...initialValues, 'owner-current': '' },
    { ...initialValues, 'duress-pin': 'abcd' },
  ])('rejects invalid credential values before dispatch', async (values) => {
    await writeValues(values);
    await inputRejected();
  });
  it('rejects a missing referenced private value', async () => {
    const values: Record<string, string> = { ...initialValues };
    delete values['owner-pin'];
    await writeValues(values);
    await inputRejected();
  });
  it.each([
    { ...initialValues, 'duress-pin': initialValues['owner-pin'] },
    { ...initialValues, 'duress-password': initialValues['work-password'] },
    { ...initialValues, 'duress-password': initialValues['owner-current'] },
    { ...initialValues, 'work-password': initialValues['duress-pin'] },
  ])('rejects duress values matching any normal default or the current owner credential', async (values) => {
    await writeValues(values);
    await inputRejected();
  });
  it('rejects duress attached to a secondary profile even for unparsed policy objects', async () => {
    const duress = configured('owner').defaultDuress;
    if (!duress) throw new Error('Missing test duress');
    configured('work').defaultDuress = duress;
    await inputRejected();
  });
  it('sets initial normal defaults through private stdin, with no old credential or verification', async () => {
    await service.setCredential(target, work, configured('work'), { lease });
    const mutation = android.mutations()[0];
    expect(mutation?.args).toEqual(['-s', 'PIXEL123', 'shell', 'sh', '-s']);
    expect(mutation?.options).toMatchObject({ lease, mutation: true, check: false, timeoutMs: 30_000 });
    expect(mutation?.options.input).toContain("'set-password' '--user' '10' '--' 'work default pass'");
    expect(mutation?.options.input).toMatch(/>\/dev\/null 2>&1\n$/u);
    expect(mutation?.options.input).not.toMatch(/--old|verify/);
    expect(JSON.stringify(android.calls.map((call) => call.args))).not.toContain(
      initialValues['work-password'],
    );
    expect(android.guardedUsers).toEqual([work]);
  });
  it('loads current private values at execution and accepts a password replacing an owner PIN', async () => {
    await service.preflight(target);
    await writeValues({ ...initialValues, 'owner-current': 'replacement current pass' });
    await service.setDuress(target, owner, configured('owner'), { lease });
    const input = android.mutations()[0]?.options.input;
    expect(input).toContain("'--owner-credential' 'replacement current pass'");
    expect(input).toContain("'--duress-pin' '826495' '--duress-password' 'emergency erase pass'");
    expect(input).not.toMatch(/--user|verify/);
    expect(android.guardedUsers).toEqual([owner]);
  });
  it('quotes shell metacharacters and leading dashes without executing password contents', async () => {
    const marker = join(outer, 'injected');
    const password = `-p'a\";$(touch ${marker})\\end`;
    await writeValues({ ...initialValues, 'work-password': password });
    await service.setCredential(target, work, configured('work'), { lease });
    const captured = join(outer, 'arguments');
    await writeFile(
      join(outer, 'locksettings'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CREDENTIAL_TEST_CAPTURE"\nprintf "echoed secret\\n"\nprintf "echoed error\\n" >&2\n',
      { mode: 0o700 },
    );
    const input = android.mutations()[0]?.options.input;
    if (input === undefined) throw new Error('Missing private stdin');
    const stdout = execFileSync('sh', ['-s'], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${outer}:${process.env['PATH'] ?? ''}`,
        CREDENTIAL_TEST_CAPTURE: captured,
      },
    });
    expect(stdout).toBe('');
    expect(await readFile(captured, 'utf8')).toBe(`set-password\n--user\n10\n--\n${password}\n`);
    await expect(access(marker)).rejects.toThrow();
  });
  it('propagates the lease and cancellation signal only to the guarded mutation', async () => {
    const controller = new AbortController();
    await service.setCredential(target, owner, configured('owner'), { lease, signal: controller.signal });
    expect(android.mutations()[0]?.options.signal).toBe(controller.signal);
  });
  it.each(['set-pin', 'set-password', 'set-duress-credentials'])(
    'rejects an unsupported installed command %s before mutation',
    async (unsupported) => {
      android.help = android.help
        .split('\n')
        .filter((line) => !line.trimStart().startsWith(unsupported))
        .join('\n');
      await expect(service.preflight(target)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(android.mutations()).toEqual([]);
    },
  );
  it('fails if the command is unavailable at execution after a successful preflight', async () => {
    await service.preflight(target);
    android.help = 'no supported credential commands';
    await expect(service.setCredential(target, work, configured('work'), { lease })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(android.mutations()).toEqual([]);
  });
  it('refuses an owner mismatch, a secondary duress request, an unknown profile or changed Android identity', async () => {
    await expect(service.setCredential(target, work, configured('owner'), { lease })).rejects.toThrow();
    await expect(service.setCredential(target, owner, configured('work'), { lease })).rejects.toThrow();
    await expect(service.setDuress(target, work, configured('work'), { lease })).rejects.toThrow();
    await expect(
      service.setCredential(target, work, profile('missing', 'secondary'), { lease }),
    ).rejects.toThrow();
    android.identityFailure = true;
    await expect(service.setCredential(target, work, configured('work'), { lease })).rejects.toThrow(
      'identity changed',
    );
    expect(android.mutations()).toEqual([]);
  });
  it('rejects an Android user belonging to a different secondary profile before any device call', async () => {
    const otherUser = { userId: 11, serialNo: 43, name: 'private' };
    await expect(service.setCredential(target, otherUser, configured('work'), { lease })).rejects.toThrow(
      'configured Android user identity',
    );
    expect(android.calls).toEqual([]);
    expect(android.guardedUsers).toEqual([]);
  });
  it.each([false, true])(
    'discards raw command failure data and performs no retry (throw=%s)',
    async (throws) => {
      const secret = initialValues['owner-current'];
      android.result = { code: 1, stdout: `Pin set to '${secret}'`, stderr: secret };
      if (throws) android.failure = Object.assign(new Error(secret), { result: android.result });
      const error: unknown = await service
        .setDuress(target, owner, configured('owner'), { lease })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'CREDENTIAL_DEFAULT_UNCERTAIN' });
      expect(inspect(error)).not.toContain(secret);
      expect(android.mutations()).toHaveLength(1);
    },
  );
  it('discards unexpected successful command output', async () => {
    android.result = {
      code: 0,
      stdout: initialValues['work-password'],
      stderr: initialValues['work-password'],
    };
    expect(await service.setCredential(target, work, configured('work'), { lease })).toBeUndefined();
  });
  it('does not dispatch when cancelled before private input preparation', async () => {
    const signal = AbortSignal.abort();
    await expect(
      service.setCredential(target, work, configured('work'), { lease, signal }),
    ).rejects.toThrow();
    expect(android.mutations()).toEqual([]);
  });
});
