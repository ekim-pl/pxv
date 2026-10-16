import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AndroidUserIdentity, RecipePolicy, RecoveryObligation, SelectedTarget } from '@pxv/contracts';
import {
  AndroidAdapter,
  RecipeService,
  matchUiNode,
  parseUiSnapshot,
  type CleanupOptions,
  type CommandOptions,
  type RecipeOptions,
} from '../../packages/adapters/src/index.js';
const user: AndroidUserIdentity = { userId: 10, serialNo: 42, name: 'work' };
const target: SelectedTarget = {
  device: {
    assetId: 'test',
    canonicalSerial: 'PIXEL',
    kind: 'pixel',
    model: 'Pixel 8a',
    codename: 'akita',
    transports: [{ kind: 'usb', serial: 'PIXEL' }],
    groups: [],
  },
  transport: { kind: 'usb', serial: 'PIXEL' },
};
const recipe: RecipePolicy = {
  schemaVersion: 1,
  id: 'setup',
  packageId: 'org.example.app',
  versionCode: 7,
  signerSha256: 'a'.repeat(64),
  buildFingerprint: 'accepted/build',
  steps: [
    { action: 'toggle', selector: { resourceId: 'org.example.app:id/enabled' }, value: true },
    { action: 'text', selector: { resourceId: 'org.example.app:id/hostname' }, value: 'dns.example' },
    { action: 'back' },
    { action: 'wait', selector: { text: 'dns.example' }, timeoutMs: 10 },
  ],
  postconditions: [
    { resourceId: 'org.example.app:id/enabled', checked: true },
    { resourceId: 'org.example.app:id/hostname', text: 'dns.example' },
  ],
};
class RecipeAndroid extends AndroidAdapter {
  checked = false;
  text = 'old';
  password = false;
  focused = true;
  consent = false;
  version = 7;
  launchCount = 0;
  duplicate = false;
  commands: string[][] = [];
  cleaned: RecoveryObligation[] = [];
  constructor() {
    super({
      runner: { run: () => Promise.reject(new Error('No live Android operations in recipe fixtures')) },
    });
  }
  override guardUser(_target: SelectedTarget, _user: AndroidUserIdentity, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  override installedIdentity(_target: SelectedTarget, _user: AndroidUserIdentity, packageId: string) {
    return Promise.resolve({ packageId, versionCode: this.version, signerSha256: 'a'.repeat(64) });
  }
  override launch() {
    this.launchCount++;
    return Promise.resolve();
  }
  override async runAdb(args: string[], options: CommandOptions = {}) {
    expect(options.mutation).toBe(true);
    const path = args.at(-2);
    if (!path) throw new Error('No private input');
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('private configuration');
    this.commands.push(['push', args.at(-1) ?? '']);
    return { code: 0, stdout: 'pushed', stderr: '' };
  }
  override cleanup(_target: SelectedTarget, obligation: RecoveryObligation, options: CleanupOptions) {
    expect(options.operationId).toBe(obligation.ownerOperationId);
    expect(obligation.user).toEqual(user);
    this.cleaned.push(obligation);
    return Promise.resolve();
  }
  override shell(_target: SelectedTarget, args: string[], options: CommandOptions = {}) {
    options.signal?.throwIfAborted();
    this.commands.push(args);
    if (args[0] === 'getprop') return Promise.resolve('accepted/build');
    if (args.slice(0, 2).join(' ') === 'am get-current-user') return Promise.resolve('10');
    if (args[0] === 'dumpsys')
      return Promise.resolve(
        `mCurrentFocus=Window{1 u10 ${this.focused ? 'org.example.app' : 'org.other.app'}/.Main}`,
      );
    if (args[0] === 'uiautomator') {
      const toggle = `<node package="org.example.app" enabled="true" resource-id="org.example.app:id/enabled" text="" checked="${String(this.checked)}" bounds="[0,0][100,100]" />`;
      return Promise.resolve(
        `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${toggle}${this.duplicate ? toggle : ''}<node package="org.example.app" enabled="true" resource-id="org.example.app:id/hostname" text="${this.text}" password="${String(this.password)}" class="android.widget.EditText" bounds="[0,100][100,200]" />${this.consent ? '<node package="com.android.vpndialogs" enabled="true" />' : ''}</hierarchy>UI hierarchy dumped to: /proc/self/fd/1`,
      );
    }
    if (args.slice(0, 2).join(' ') === 'input tap' && args[3] === '50') this.checked = !this.checked;
    if (args.slice(0, 2).join(' ') === 'input text') this.text = args[2] ?? '';
    if (args[2] === 'KEYCODE_DEL') this.text = this.text.slice(0, -1);
    return Promise.resolve('');
  }
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-recipe-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function options(records: RecoveryObligation[] = [], resolved: string[] = []): RecipeOptions {
  return {
    lease: {},
    operationId: 'root',
    obligations: {
      record: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      resolve: (id) => {
        resolved.push(id);
        return Promise.resolve();
      },
    },
  };
}
describe('version-pinned recipes and guarded UI actions', () => {
  it('applies bounded public app configuration and measures visible postconditions', async () => {
    const android = new RecipeAndroid();
    const result = await new RecipeService(android).run(target, user, recipe, options());
    expect(result).toMatchObject({ status: 'measured', verification: 'visible-ui-only', postconditions: 2 });
    expect(android.checked).toBe(true);
    expect(android.text).toBe('dns.example');
    expect(
      android.commands
        .filter((args) => args[0] === 'uiautomator')
        .every((args) => args[2] === '/proc/self/fd/1'),
    ).toBe(true);
  });
  it('requires exact app/build pins and never runs invalid schemas or wrong focus', async () => {
    const android = new RecipeAndroid();
    const service = new RecipeService(android);
    android.version = 8;
    expect((await service.run(target, user, recipe, options())).status).toBe('manual-pending');
    expect(android.launchCount).toBe(0);
    await expect(
      service.run(
        target,
        user,
        { ...recipe, steps: [{ action: 'text', selector: { text: 'password' }, value: 'secret' }] },
        options(),
      ),
    ).rejects.toThrow();
    expect(android.launchCount).toBe(0);
    android.version = 7;
    android.focused = false;
    expect((await service.run(target, user, recipe, options())).status).toBe('manual-pending');
    expect(android.commands.some((args) => args[0] === 'input')).toBe(false);
  });
  it('blocks ambiguous nodes, password fields and unresolved platform consent', async () => {
    const android = new RecipeAndroid();
    const service = new RecipeService(android);
    android.duplicate = true;
    await expect(service.run(target, user, recipe, options())).rejects.toThrow(/ambiguous/);
    android.duplicate = false;
    android.password = true;
    await expect(service.run(target, user, recipe, options())).rejects.toThrow(/non-password/);
    android.password = false;
    android.consent = true;
    expect((await service.run(target, user, recipe, options())).status).toBe('manual-pending');
  });
  it('keeps private imports out of results and limits cleanup to their owning child scope', async () => {
    const android = new RecipeAndroid();
    const path = join(directory, 'input.conf');
    const data = 'private configuration';
    await writeFile(path, data, { mode: 0o600 });
    const records: RecoveryObligation[] = [];
    const resolved: string[] = [];
    const result = await new RecipeService(android).run(
      target,
      user,
      {
        ...recipe,
        steps: [
          { action: 'stage-file', file: 'vpn' },
          { action: 'select-staged-file', file: 'vpn' },
        ],
      },
      {
        ...options(records, resolved),
        inputs: { vpn: { path, sha256: createHash('sha256').update(data).digest('hex') } },
      },
    );
    expect(result.status).toBe('manual-pending');
    expect(JSON.stringify(result)).not.toContain(data);
    expect(records).toHaveLength(1);
    expect(records[0]?.ownerOperationId).toMatch(/^root\/recipe\//);
    expect(records[0]?.payload['path']).toMatch(/^\/storage\/emulated\/10\/Download\/pxv-import-/);
    expect(JSON.stringify(records)).not.toContain(path);
    expect(resolved).toEqual([records[0]?.id]);
    expect(android.cleaned).toHaveLength(1);
  });
  it('rejects changed or non-private inputs before transferring and times out missing selectors without tapping', async () => {
    const android = new RecipeAndroid();
    const service = new RecipeService(android);
    const path = join(directory, 'input.conf');
    await writeFile(path, 'private configuration', { mode: 0o600 });
    await expect(
      service.run(
        target,
        user,
        { ...recipe, steps: [{ action: 'stage-file', file: 'vpn' }] },
        { ...options(), inputs: { vpn: { path, sha256: '0'.repeat(64) } } },
      ),
    ).rejects.toThrow(/changed after/);
    expect(android.commands.some((args) => args[0] === 'push')).toBe(false);
    const result = await service.run(
      target,
      user,
      { ...recipe, steps: [{ action: 'wait', selector: { text: 'missing' }, timeoutMs: 1 }] },
      options(),
    );
    expect(result.status).toBe('manual-pending');
  });
});
describe('bounded uiautomator XML parsing', () => {
  it('decodes standard XML entities and rejects unsafe or malformed documents', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="org.example.app" enabled="true" text="A &amp; B &#x21;" /></hierarchy>';
    const nodes = parseUiSnapshot(xml);
    expect(nodes[0]?.attributes['text']).toBe('A & B !');
    expect(matchUiNode(nodes, { text: 'A & B !' }, 'org.example.app')).toBeDefined();
    for (const bad of [
      '<!DOCTYPE hierarchy><hierarchy/>',
      '<hierarchy><node></hierarchy>',
      '<hierarchy><node x="1" x="2" /></hierarchy>',
      '<hierarchy><node text="&external;" /></hierarchy>',
      '<hierarchy><node text="&#0;" /></hierarchy>',
      '<hierarchy/><hierarchy/>',
      '<wrong/>',
      '<hierarchy>unexpected text</hierarchy>',
    ])
      expect(() => parseUiSnapshot(bad)).toThrow();
  });
});
