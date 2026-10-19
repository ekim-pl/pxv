import type * as Runtime from '@pxv/runtime';
import type * as Guides from '@pxv/guides';
import type * as Arguments from '../../packages/cli/src/arguments.js';
import type * as Insert from '../../packages/cli/src/registry-insert.js';
import type * as Selection from '../../packages/cli/src/selection.js';
import type * as Cli from '@pxv/cli';
import type { ProjectContext } from '@pxv/engine';
import { createProject, loadProject, saveInventory } from '@pxv/engine';
import { toPolicyDocument, validatePhoneRegistryDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, importModule, it, vi } from '../test-api.js';
import { device, policy, product } from '../contracts/fixtures.js';
globalThis.__pxvTestFile = import.meta.url;
vi.mock('@pxv/runtime', async (original) => {
  const actual = await original<typeof Runtime>();
  return { ...actual, readEncryptedRegistry: vi.fn(actual.readEncryptedRegistry) };
});
vi.mock('@pxv/guides', async (original) => {
  const actual = await original<typeof Guides>();
  return { ...actual, writeCredentialInsert: vi.fn<typeof actual.writeCredentialInsert>() };
});
const runtime = await importModule<typeof Runtime>('@pxv/runtime', import.meta.url);
const guides = await importModule<typeof Guides>('@pxv/guides', import.meta.url);
const { parseCli } = await importModule<typeof Arguments>(
  '../../packages/cli/src/arguments.js',
  import.meta.url,
);
const { selectedContext } = await importModule<typeof Selection>(
  '../../packages/cli/src/selection.js',
  import.meta.url,
);
const { exportRegistryInsert } = await importModule<typeof Insert>(
  '../../packages/cli/src/registry-insert.js',
  import.meta.url,
);
const { runCli } = await importModule<typeof Cli>('@pxv/cli', import.meta.url);

let root: string;
let resources: string;
let project: ProjectContext;
let passwordFile: string;
let vault: string;
let context: Arguments.ProjectCliContext;
let previousControl: string | undefined;
const password = 'synthetic-private-insert-passphrase';
const secret = 'SYNTHETIC-INSERT-PRIVATE-VALUE';
const output: string[] = [];
const io = {
  out: (value: string) => output.push(value),
  error: (value: string) => output.push(value),
  confirm: () => Promise.resolve(true),
};
const args = (...values: string[]) => [
  ...values,
  '--json',
  '--project-root',
  project.root,
  '--resource-root',
  resources,
  '--passphrase-file',
  passwordFile,
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-private-insert-'));
  previousControl = process.env['PXV_CONTROL_ROOT'];
  process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
  resources = join(root, 'resources');
  await mkdir(resources);
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), resources);
  await saveInventory(created, { schemaVersion: 1, devices: [device] });
  project = await loadProject(created.root, product, resources);
  const store = await runtime.SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
  await store.close();
  passwordFile = join(root, 'password');
  vault = join(project.root, 'secrets/phone-registry.pxv');
  await writeFile(passwordFile, password, { mode: 0o600 });
  const input = join(root, 'input.json');
  await writeFile(
    input,
    JSON.stringify({
      fields: {},
      profiles: [
        {
          profileId: 'admin',
          user: { userId: 0, serialNo: 0, name: 'Administrator' },
          fields: { password: { value: secret, state: 'current' } },
        },
      ],
    }),
    { mode: 0o600 },
  );
  await runCli(args('registry', 'init'), io);
  await runCli(
    args('registry', 'update', '--asset', device.assetId, '--file', input, '--record-revision', '0'),
    io,
  );
  context = selectedContext(
    await parseCli(
      args(
        'registry',
        'print-insert',
        '--asset',
        device.assetId,
        '--output',
        join(project.root, 'secrets/insert.pdf'),
        '--chromium',
        '/local/chromium',
      ),
      io,
    ),
    project,
  );
  output.length = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousControl === undefined) delete process.env['PXV_CONTROL_ROOT'];
  else process.env['PXV_CONTROL_ROOT'] = previousControl;
  await rm(root, { recursive: true, force: true });
});
function change(values: Record<string, unknown>): Arguments.ProjectCliContext {
  const merged = { ...context.values, ...values };
  return {
    ...context,
    values: merged,
    flag: (name) => merged[name] === true,
    value: (name, fallback) => (typeof merged[name] === 'string' ? merged[name] : (fallback ?? '')),
  };
}

async function assertReleased(selected = context, message?: string) {
  const close = vi.spyOn(runtime.SqliteStore.prototype, 'close');
  const read = vi.spyOn(runtime, 'readEncryptedRegistry');
  const before = await readFile(vault);
  if (message) await expect(exportRegistryInsert(selected)).rejects.toThrow(message);
  else {
    await exportRegistryInsert(selected);
    selected.flushOutput();
  }
  expect(close).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  const retained = read.mock.calls[0]![2];
  expect(Buffer.isBuffer(retained)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
  expect(await readFile(vault)).toEqual(before);
  expect(output.join()).not.toContain(secret);
  expect(output.join()).not.toContain(password);
}

for (const [values, message] of [
  [{ all: true }, 'one exact'],
  [{ group: 'pilot' }, 'one exact'],
  [{ asset: 'missing' }, 'not enrolled'],
  [{ locale: 'de' }, 'Invalid locale'],
  [{ output: 'insert.txt' }, 'PDF file'],
] as const) {
  it(`rejects ${JSON.stringify(values)} and releases private resources`, async () => {
    await assertReleased(change(values), message);
    expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
  });
}
for (const destination of ['project', 'resources']) {
  it(`rejects a public ${destination} destination`, async () => {
    await assertReleased(
      change({ output: join(destination === 'project' ? project.root : resources, 'insert.pdf') }),
      'under project secrets',
    );
    expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
  });
}
for (const mode of ['docker', 'execution']) {
  it(`rejects ${mode} before opening storage or reading a password`, async () => {
    await rm(passwordFile);
    const open = vi.spyOn(runtime.SqliteStore, 'open');
    const read = vi.spyOn(runtime, 'readEncryptedRegistry');
    const selected =
      mode === 'docker' ? { ...context, dockerMode: 'direct' } : change({ execution: 'docker' });
    await expect(exportRegistryInsert(selected)).rejects.toThrow('local host');
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
  });
}
for (const failure of ['missing-record', 'cross-project']) {
  it(`rejects ${failure} plaintext after authentication`, async () => {
    const authenticated = await runtime.readEncryptedRegistry(
      vault,
      project.config.id,
      Buffer.from(password),
      validatePhoneRegistryDocument,
    );
    vi.spyOn(runtime, 'readEncryptedRegistry').mockResolvedValueOnce({
      ...authenticated,
      value: {
        ...authenticated.value,
        ...(failure === 'missing-record' ? { devices: [] } : { projectId: 'another-project' }),
      },
    });
    vi.clearAllMocks();
    await assertReleased(context, failure === 'missing-record' ? 'no registry record' : 'project identity');
    expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
  });
}
it('closes the read-only store and zeros its password after decryption failure', async () => {
  await writeFile(vault, 'invalid encrypted envelope', { mode: 0o600 });
  await assertReleased(context, 'registry');
  expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
});
it('checks the durable anchor before rendering', async () => {
  const store = await runtime.SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
  try {
    await store.delete('registry-anchor', project.config.id);
  } finally {
    await store.close();
  }
  await assertReleased(context, 'retained state');
  expect(guides.writeCredentialInsert).not.toHaveBeenCalled();
});
it('releases resources after renderer failure without public output', async () => {
  vi.spyOn(guides, 'writeCredentialInsert').mockRejectedValueOnce(new Error('renderer unavailable'));
  await assertReleased(context, 'renderer unavailable');
  expect(output).toEqual([]);
});
for (const locale of ['en', 'pl']) {
  it(`renders ${locale} privately and releases resources on success`, async () => {
    await assertReleased(change({ locale }));
    expect(guides.writeCredentialInsert).toHaveBeenCalledOnce();
    expect(
      vi.mocked(guides.writeCredentialInsert).mock.calls[0]![0].profiles[0]?.fields.password?.value,
    ).toBe(secret);
    expect(vi.mocked(guides.writeCredentialInsert).mock.calls[0]![2]).toMatchObject({
      locale,
      chromiumExecutable: '/local/chromium',
    });
    expect(JSON.parse(output[0]!)).toMatchObject({ exported: true, assetId: device.assetId });
  });
}
