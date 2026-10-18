import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:os';
import type * as TestModule2 from 'node:path';
import type * as TestModule3 from '../../packages/cli/src/host.js';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;

import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';

import type * as RuntimeModule from '@pxv/runtime';

const mocks = vi.hoisted(() => ({
  doctor: vi.fn(),
  bootstrap: vi.fn(),
  probe: vi.fn(),
  supervisor: vi.fn(),
}));
vi.mock('@pxv/adapters', () => ({
  HostTools: class {
    doctor = mocks.doctor;
    bootstrap = mocks.bootstrap;
  },
  configuredAdbServer: () => ({ host: '127.0.0.1', port: 5037 }),
  probeAdbServer: mocks.probe,
}));
vi.mock('@pxv/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeModule>()),
  supervisorPath: mocks.supervisor,
}));
// Module exports are called without a receiver.

const { mkdtemp, readdir, rm, writeFile } = await importModule<typeof TestModule0>(
  'node:fs/promises',
  import.meta.url,
);
// Module exports are called without a receiver.

const { tmpdir } = await importModule<typeof TestModule1>('node:os', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join } = await importModule<typeof TestModule2>('node:path', import.meta.url);
// Module exports are called without a receiver.

const { bootstrapTool, inspectHost } = await importModule<typeof TestModule3>(
  '../../packages/cli/src/host.js',
  import.meta.url,
);

describe('host diagnosis and explicit archive bootstrap controller', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pxv-host-controller-'));
    mocks.doctor.mockResolvedValue([{ tool: 'adb', available: true, compatible: true }]);
    mocks.bootstrap.mockResolvedValue('/private/tools/approved');
    mocks.probe.mockResolvedValue(undefined);
    const supervisor = join(root, 'supervisor');
    await writeFile(
      supervisor,
      'console.log(JSON.stringify({ protocol:1,addon:"3.3.3",nodeApi:8,platform:"linux_x64",pidfd:true,subreaper:true }));',
      { mode: 0o755 },
    );
    mocks.supervisor.mockResolvedValue(supervisor);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('reports both available and unavailable host services without bootstrapping implicitly', async () => {
    expect(await inspectHost()).toMatchObject({
      supported: true,
      adbServer: true,
      supervisor: true,
      tools: [{ tool: 'adb' }],
    });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    mocks.probe.mockRejectedValue(new Error('offline'));
    mocks.supervisor.mockRejectedValue(new Error('not built'));
    expect(await inspectHost()).toMatchObject({ adbServer: false, supervisor: false });
  });

  it('reports unsupported platforms rather than treating discovered tools as runtime compatibility', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!original) throw new Error('Platform descriptor missing');
    Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
    try {
      expect((await inspectHost()).supported).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it.each([
    ['missing ELF loader or interpreter', '#!/missing-pxv-interpreter\n'],
    ['incompatible libc', "#!/bin/sh\nprintf 'GLIBC_2.39 not found\\n' >&2\nexit 127\n"],
    ['wrong supervisor version', "#!/bin/sh\nprintf 'pxv-supervisor 0.2.0\\n'\n"],
    ['unrelated executable', "#!/bin/sh\nprintf 'other-tool 0.1.0\\n'\n"],
  ])(
    'reports an existing executable as unavailable for %s without initializing project or control state',
    async (_reason, contents) => {
      await writeFile(join(root, 'supervisor'), contents, { mode: 0o755 });
      expect((await inspectHost()).supervisor).toBe(false);
      expect(await readdir(root)).toEqual(['supervisor']);
      expect(mocks.bootstrap).not.toHaveBeenCalled();
    },
  );

  it('passes only a strict descriptor plus explicitly accepted license to the verified bootstrap service', async () => {
    const descriptor = {
      id: 'platform-tools',
      url: 'https://example.org/tools.zip',
      sha256: 'a'.repeat(64),
      executables: ['adb', 'fastboot'],
      licenseId: 'android-sdk',
    };
    const path = join(root, 'approved.json');
    await writeFile(path, JSON.stringify(descriptor));
    expect(await bootstrapTool(path, 'android-sdk', join(root, 'tools'))).toBe('/private/tools/approved');
    expect(mocks.bootstrap).toHaveBeenCalledWith(descriptor, join(root, 'tools'), {
      acceptedLicense: 'android-sdk',
    });
  });

  it.each([
    null,
    [],
    { id: 'missing-fields' },
    {
      id: 'tools',
      url: 'https://example.org',
      sha256: 'a'.repeat(64),
      executables: [1],
      licenseId: 'license',
    },
    {
      id: 'tools',
      url: 'https://example.org',
      sha256: 'a'.repeat(64),
      executables: [],
      licenseId: 'license',
      scripts: ['bad'],
    },
  ])('refuses malformed bootstrap descriptors before service invocation: %s', async (descriptor) => {
    const path = join(root, 'invalid.json');
    await writeFile(path, JSON.stringify(descriptor));
    await expect(bootstrapTool(path, 'license', root)).rejects.toThrow();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
});
