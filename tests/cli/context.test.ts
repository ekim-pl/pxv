import { toPolicyDocument } from '@pxv/contracts';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FileSystemModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ObligationWriter,
  ArtifactPolicy,
  PolicyPack,
  SelectedTarget,
  RecipePolicy,
  NetworkProbePolicy,
} from '@pxv/contracts';
import type { RepositoryOptions } from '@pxv/adapters';
import { createProject, saveInventory } from '@pxv/engine';
import type { ExecutionContext, OsSnapshot } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import type { DeviceLease } from '@pxv/runtime';
import { application, productAt, redact, resourceRoot } from '../../packages/cli/src/context.js';
import { basePolicy } from '../engine/fixtures.js';
import { device, hashA, hashB, observation, product } from '../contracts/fixtures.js';
import { obligation } from '../contracts/fixtures.js';

const mocks = vi.hoisted(() => ({
  denyAccess: false,
  discover: vi.fn(),
  require: vi.fn(),
  artifactSnapshot: vi.fn(),
  artifactInspect: vi.fn(),
  imageSnapshot: vi.fn(),
  imageVerify: vi.fn(),
  repositoryOptions: [] as RepositoryOptions[],
  repositoryIndex: vi.fn(),
  candidate: vi.fn(),
  validateEvidence: vi.fn(),
  credentialConstruct: vi.fn(),
  credentialPreflight: vi.fn(),
  credentialSet: vi.fn(),
  duressSet: vi.fn(),
  android: {
    inspect: vi.fn(),
    createUser: vi.fn(),
    inspectSharedEffects: vi.fn(),
    install: vi.fn(),
    applySetting: vi.fn(),
    applyPermission: vi.fn(),
    applyVpn: vi.fn(),
    setupLanguage: vi.fn(),
    flash: vi.fn(),
    finalize: vi.fn(),
    shell: vi.fn(),
    guardTarget: vi.fn(),
    users: vi.fn(),
    cleanup: vi.fn(),
  },
  recipeRun: vi.fn(),
  probeRun: vi.fn(),
  recoverService: vi.fn(),
  emulator: vi.fn(),
  extensionInspect: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemModule>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (mocks.denyAccess) throw new Error('missing fixture');
      return actual.access(...args);
    },
  };
});
vi.mock('@pxv/adapters', () => ({
  HostTools: class {
    discover = mocks.discover;
    require = mocks.require;
  },
  ArtifactService: class {
    snapshot = mocks.artifactSnapshot;
    inspect = mocks.artifactInspect;
  },
  ImageService: class {
    snapshot = mocks.imageSnapshot;
    verify = mocks.imageVerify;
  },
  RepositoryService: class {
    constructor(options: RepositoryOptions) {
      mocks.repositoryOptions.push(options);
    }
    index = mocks.repositoryIndex;
    candidate = mocks.candidate;
    validateEvidence = mocks.validateEvidence;
  },
  AndroidAdapter: class {
    constructor() {
      Object.assign(this, mocks.android);
    }
  },
  CredentialDefaultsService: class {
    constructor(android: unknown, projectRoot: string, policy: PolicyPack) {
      mocks.credentialConstruct(android, projectRoot, policy);
    }
    preflight = mocks.credentialPreflight;
    setCredential = mocks.credentialSet;
    setDuress = mocks.duressSet;
  },
  RecipeService: class {
    run = mocks.recipeRun;
  },
  NetworkProbeService: class {
    run = mocks.probeRun;
    recoverService = mocks.recoverService;
  },
  observeEmulatorProvenance: mocks.emulator,
}));
vi.mock('@pxv/extensions', () => ({
  ExtensionManager: class {
    inspect = mocks.extensionInspect;
  },
}));

describe('production dependency wiring and evidence boundaries', () => {
  let root = '';
  let resources = '';
  let projectRoot = '';
  let policy: PolicyPack;
  let saved: NodeJS.ProcessEnv;
  const apps: Awaited<ReturnType<typeof application>>[] = [];
  const target: SelectedTarget = {
    device: { ...device, inputs: { vpn_config: { path: 'secrets/vpn.conf', sha256: hashA } } },
    transport: { kind: 'usb', serial: 'PIXEL1' },
  };
  const user = { userId: 0, serialNo: 0, name: 'Administrator' };
  const writer: ObligationWriter = {
    operationId: 'run-1',
    ownerOperationId: 'run-1',
    child: () => writer,
    record: () => Promise.resolve(),
    resolve: () => Promise.resolve(),
  };
  const execution: ExecutionContext = {
    lease: {} as DeviceLease,
    operationId: 'run-1',
    obligations: writer,
  };
  const openApp = async (readOnly = false) => {
    const app = await application(projectRoot, resources, readOnly);
    apps.push(app);
    return app;
  };
  beforeEach(async () => {
    saved = { ...process.env };
    mocks.denyAccess = false;
    mocks.repositoryOptions.length = 0;
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'pxv-context-'));
    resources = join(root, 'resources');
    projectRoot = join(root, 'project');
    await mkdir(resources);
    await writeFile(join(resources, 'product.json'), JSON.stringify(product));
    policy = basePolicy();
    const artifact = policy.profiles[0]?.packages[0];
    if (!artifact) throw new Error('Fixture artifact missing');
    artifact.path = 'app.apk';
    const project = await createProject(projectRoot, product, toPolicyDocument(policy));
    await saveInventory(project, { schemaVersion: 1, devices: [target.device] });
    const store = await SqliteStore.open(join(projectRoot, 'state/pxv.sqlite3'));
    await store.close();
    await writeFile(join(projectRoot, 'app.apk'), 'fixture');
    await mkdir(join(projectRoot, 'secrets'));
    await writeFile(join(projectRoot, 'secrets/vpn.conf'), 'private fixture', { mode: 0o600 });
    mocks.discover.mockImplementation((name: string) => Promise.resolve(`/tools/${name}`));
    mocks.require.mockImplementation((name: string) => Promise.resolve(`/tools/${name}`));
    mocks.artifactSnapshot.mockImplementation((source: ArtifactPolicy, destination: string) =>
      Promise.resolve({ ...source, path: destination }),
    );
    mocks.artifactInspect.mockImplementation((path: string, source: ArtifactPolicy) =>
      Promise.resolve({ ...source, path }),
    );
    mocks.android.inspect.mockResolvedValue(structuredClone(observation));
    mocks.android.createUser.mockResolvedValue(user);
    mocks.android.inspectSharedEffects.mockResolvedValue([]);
    mocks.android.shell.mockImplementation((_target: SelectedTarget, args: string[]) =>
      Promise.resolve(args.includes('ro.build.version.sdk') ? '37' : 'arm64-v8a,armeabi-v7a'),
    );
    mocks.android.users.mockResolvedValue([user]);
    mocks.android.guardTarget.mockResolvedValue(undefined);
    mocks.extensionInspect.mockResolvedValue({});
    mocks.recipeRun.mockResolvedValue({
      status: 'measured',
      capability: 'app-setup',
      recipeDigest: hashA,
      postconditions: 1,
    });
    mocks.probeRun.mockResolvedValue({ scope: 'probe-app-uid-https-only', failures: [] });
    mocks.emulator.mockResolvedValue({ schemaVersion: 1 });
    mocks.validateEvidence.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    mocks.denyAccess = false;
    process.env = saved;
    for (const app of apps.splice(0)) await app.store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('locates explicit/environment/fallback product resources and refuses an unavailable installed build', async () => {
    expect(await resourceRoot(relative(process.cwd(), resources))).toBe(resources);
    const resourceAlias = join(root, 'resource-alias');
    await symlink(resources, resourceAlias);
    expect(await resourceRoot(resourceAlias)).toBe(resources);
    process.env['PXV_RESOURCE_ROOT'] = resources;
    expect(await resourceRoot()).toBe(resources);
    delete process.env['PXV_RESOURCE_ROOT'];
    expect(await resourceRoot()).toBe(resolve('.'));
    expect(await productAt(resources)).toEqual(product);
    mocks.denyAccess = true;
    await expect(resourceRoot()).rejects.toThrow('resources are missing');
  });

  it('does not create a missing database and validates installed extension locks before mutations', async () => {
    await rm(join(projectRoot, 'state/pxv.sqlite3'));
    await expect(application(projectRoot, resources)).rejects.toThrow();
    const store = await SqliteStore.open(join(projectRoot, 'state/pxv.sqlite3'));
    await store.close();
    const project = await import('node:fs/promises')
      .then((fs) => fs.readFile(join(projectRoot, 'pxv.project.json'), 'utf8'))
      .then((text) => JSON.parse(text) as Record<string, unknown>);
    await writeFile(
      join(projectRoot, 'pxv.project.json'),
      JSON.stringify({
        ...project,
        extensions: [
          {
            id: '@private/extension',
            version: '0.1.0',
            integrity: `sha512-${'A'.repeat(86)}==`,
            apiVersion: 1,
            entry: 'index.js',
            installPath: 'extension',
          },
        ],
      }),
    );
    await openApp();
    expect(mocks.extensionInspect).toHaveBeenCalledOnce();
    mocks.extensionInspect.mockClear();
    await openApp(true);
    expect(mocks.extensionInspect).not.toHaveBeenCalled();
  });

  it('refuses extension-dependent core execution while retaining reports and recovery-safe access', async () => {
    await writeFile(
      join(resources, 'product.json'),
      JSON.stringify({ ...product, features: { extensions: false, seedvault: false } }),
    );
    const configPath = join(projectRoot, 'pxv.project.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const extension = {
      id: '@private/retained',
      version: '0.1.0',
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
      apiVersion: 1,
      entry: 'index.js',
      installPath: 'a'.repeat(64),
    };
    await writeFile(configPath, JSON.stringify({ ...config, extensions: [extension] }));
    await expect(application(projectRoot, resources)).rejects.toThrow(
      'cannot execute projects with extensions',
    );
    const reportApp = await openApp(true);
    const recoveryApp = await application(projectRoot, resources, false, true);
    apps.push(recoveryApp);
    await recoveryApp.store.set('runs', 'retained-run', {
      id: 'retained-run',
      planId: 'retained-plan',
      status: 'running',
      createdAt: '2026-10-17T10:00:00Z',
      operator: 'Operator',
    });
    await recoveryApp.engine.cancel('retained-run');
    expect(await reportApp.store.get('cancellation', 'retained-run')).toEqual({ requested: true });
    expect(mocks.extensionInspect).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toContain('@private/retained');
  });

  it('wires every ordinary device action through validated adapter ports and prerequisite discovery', async () => {
    mocks.discover.mockResolvedValue(undefined);
    const app = await openApp();
    const profile = policy.profiles[0];
    const artifact = profile?.packages[0];
    const setting = profile?.settings[0];
    const permission = profile?.permissions[0];
    if (!profile || !artifact || !setting || !permission) throw new Error('Fixture profile missing');
    await app.engine.port.inspect(target, policy);
    expect(mocks.require).toHaveBeenCalledWith('adb');
    expect(mocks.require).toHaveBeenCalledWith('aapt');
    await app.engine.port.inspect(target, { ...policy, profiles: [{ ...profile, packages: [] }] });
    await app.engine.port.createUser(target, profile, execution);
    await app.engine.port.sharedEffects?.(target, ['org.example.vpn']);
    await app.engine.port.install(target, user, artifact, execution);
    expect(mocks.artifactInspect).not.toHaveBeenCalled();
    expect(mocks.android.install).toHaveBeenCalledWith(target, user, artifact, execution);
    const noPath = { ...artifact };
    delete noPath.path;
    await expect(app.engine.port.install(target, user, noPath, execution)).rejects.toThrow(
      'snapshot missing',
    );
    await app.engine.port.applySetting(target, user, setting, execution);
    await app.engine.port.applyPermission(target, user, permission, execution);
    await app.engine.port.applyVpn(target, user, profile.vpn, execution);
    await app.engine.port.language(target, user, 'pl-PL', execution);
    await app.engine.port.finalize(target, execution);
    expect(mocks.android.createUser).toHaveBeenCalled();
    expect(mocks.android.applySetting).toHaveBeenCalled();
    expect(mocks.android.applyPermission).toHaveBeenCalled();
    expect(mocks.android.applyVpn).toHaveBeenCalled();
    expect(mocks.android.setupLanguage).toHaveBeenCalled();
    expect(mocks.android.finalize).toHaveBeenCalled();
    expect(await app.engine.port.inspectUser?.(target, user)).toEqual(user);
    mocks.android.users.mockResolvedValue([]);
    await expect(app.engine.port.inspectUser?.(target, user)).rejects.toThrow('Original Android user');
    await app.engine.port.verifyEmulatorEvidence?.(target, {
      path: '/image',
      sha256: hashA,
      fingerprint: 'build',
      source: 'source',
    });
    expect(mocks.emulator).toHaveBeenCalled();
  });

  it('constructs private default adapters only when their ports run and forwards nonsecret policy references', async () => {
    const profile = policy.profiles[0]!;
    profile.defaultCredential = { type: 'pin', secretRef: 'owner-initial' };
    profile.defaultDuress = {
      ownerCredentialRef: 'owner-current',
      pinRef: 'duress-pin',
      passwordRef: 'duress-password',
    };
    await writeFile(join(projectRoot, 'policy.yaml'), JSON.stringify(toPolicyDocument(policy)));
    const app = await openApp();
    expect(mocks.credentialConstruct).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    const context = { ...execution, signal };
    await app.engine.port.credentialDefaultsPreflight?.(target, signal);
    expect(mocks.credentialPreflight).toHaveBeenCalledExactlyOnceWith(target, signal);
    await app.engine.port.setCredentialDefault?.(target, user, profile, context);
    expect(mocks.credentialSet).toHaveBeenCalledExactlyOnceWith(target, user, profile, context);
    await app.engine.port.setDuressDefault?.(target, user, profile, context);
    expect(mocks.duressSet).toHaveBeenCalledExactlyOnceWith(target, user, profile, context);
    expect(mocks.credentialConstruct).toHaveBeenCalled();
    for (const call of mocks.credentialConstruct.mock.calls)
      expect(call).toEqual([
        expect.objectContaining({ inspect: mocks.android.inspect }),
        projectRoot,
        app.engine.project.policy,
      ]);
  });

  it('resolves project APK paths and captures authenticated repository evidence using measured SDK/ABIs', async () => {
    const app = await openApp();
    const artifact = policy.profiles[0]?.packages[0];
    if (!artifact) throw new Error('Fixture artifact missing');
    const destination = join(projectRoot, 'snapshot.apk');
    await app.engine.artifacts.snapshot(artifact, destination, undefined, target);
    expect(mocks.artifactSnapshot).toHaveBeenCalledWith(
      { ...artifact, path: join(projectRoot, 'app.apk') },
      destination,
      undefined,
    );
    await app.engine.artifacts.validateBeforeExecution?.(artifact, target);
    const repository = {
      id: 'trusted',
      url: 'https://example.org/repo',
      signerSha256: hashA,
      maxAgeDays: 7,
      redirectHosts: [],
    };
    policy.repositories = [repository];
    await writeFile(join(projectRoot, 'policy.yaml'), JSON.stringify(toPolicyDocument(policy)));
    const configured = await openApp();
    const approved = { ...artifact, repositoryId: 'trusted', url: 'https://example.org/repo/app.apk' };
    delete approved.path;
    const evidence = {
      url: repository.url,
      signerSha256: hashA,
      timestamp: 1,
      entrySha256: hashA,
      indexSha256: hashB,
      format: 'v2',
      maxAgeDays: 7,
    };
    mocks.repositoryIndex.mockResolvedValue({ evidence, packages: {} });
    mocks.candidate.mockReturnValue(approved);
    await configured.engine.artifacts.snapshot({ ...approved }, destination, undefined, target);
    expect(mocks.candidate).toHaveBeenCalledWith({ evidence, packages: {} }, artifact.packageId, {
      sdk: 37,
      abis: ['arm64-v8a', 'armeabi-v7a'],
      versionCode: 12,
    });
    await configured.engine.artifacts.validateBeforeExecution?.({ ...approved, path: destination }, target);
    expect(mocks.validateEvidence).toHaveBeenCalledWith(repository, evidence);
    const nextDestination = `${destination}.next.apk`;
    const nextEvidence = { ...evidence, timestamp: 2, indexSha256: hashA };
    mocks.repositoryIndex.mockResolvedValue({ evidence: nextEvidence, packages: {} });
    await configured.engine.artifacts.snapshot(approved, nextDestination, undefined, target);
    await configured.engine.artifacts.validateBeforeExecution?.({ ...approved, path: destination }, target);
    expect(mocks.validateEvidence).toHaveBeenLastCalledWith(repository, evidence);
    await configured.engine.artifacts.validateBeforeExecution?.(
      { ...approved, path: nextDestination },
      target,
    );
    expect(mocks.validateEvidence).toHaveBeenLastCalledWith(repository, nextEvidence);
    await expect(configured.engine.artifacts.snapshot(approved, destination)).rejects.toThrow(
      'measured target',
    );
    await expect(
      configured.engine.artifacts.snapshot(
        { ...approved, repositoryId: 'missing' },
        destination,
        undefined,
        target,
      ),
    ).rejects.toThrow('Unknown authenticated');
    mocks.candidate.mockReturnValue({ ...approved, sha256: hashB });
    await expect(
      configured.engine.artifacts.snapshot(approved, destination, undefined, target),
    ).rejects.toThrow('differs');
    await expect(
      configured.engine.artifacts.validateBeforeExecution?.({ ...approved, path: '/missing' }, target),
    ).rejects.toThrow('evidence is missing');
    const freshness = mocks.repositoryOptions.at(-1)?.freshness;
    if (!freshness) throw new Error('Missing freshness port');
    expect(await freshness.read('repo')).toBeUndefined();
    await freshness.advance('repo', undefined, { signerSha256: hashA, timestamp: 1 });
    await expect(freshness.advance('repo', undefined, { signerSha256: hashA, timestamp: 2 })).rejects.toThrow(
      'Concurrent',
    );
  });

  it('requires pinned OS bytes and USB fastboot mode before flashing', async () => {
    const app = await openApp();
    const os = {
      codename: 'akita',
      release: '2026100600',
      url: 'https://example.org/os.zip',
      signatureUrl: 'https://example.org/os.zip.sig',
      publicKey: 'ssh-ed25519 AAAA',
      signerPrincipal: 'release@example.org',
      namespace: 'factory images',
    };
    const snapshot: OsSnapshot = {
      path: '/snapshot/os.zip',
      signaturePath: '/snapshot/os.zip.sig',
      sha256: hashA,
      signatureSha256: hashB,
      policy: os,
    };
    mocks.imageSnapshot.mockResolvedValue(snapshot);
    expect(await app.engine.artifacts.snapshotOs?.(os, '/snapshot')).toEqual(snapshot);
    process.env['PXV_DOCKER_MODE'] = 'host-adb';
    mocks.imageSnapshot.mockClear();
    mocks.require.mockClear();
    await expect(app.engine.artifacts.snapshotOs?.(os, '/snapshot')).rejects.toThrow('direct USB');
    expect(mocks.imageSnapshot).not.toHaveBeenCalled();
    expect(mocks.require).not.toHaveBeenCalled();
    await expect(
      app.engine.port.flash(target, { ...policy, osByCodename: { akita: os } }, execution),
    ).rejects.toThrow('direct USB');
    expect(mocks.imageVerify).not.toHaveBeenCalled();
    expect(mocks.android.flash).not.toHaveBeenCalled();
    process.env['PXV_DOCKER_MODE'] = 'direct';
    expect(await app.engine.artifacts.snapshotOs?.(os, '/snapshot')).toEqual(snapshot);
    delete process.env['PXV_DOCKER_MODE'];
    await expect(app.engine.port.flash(target, policy, execution)).rejects.toThrow('OS policy missing');
    await expect(
      app.engine.port.flash(target, { ...policy, osByCodename: { akita: os } }, execution),
    ).rejects.toThrow('OS snapshot missing');
    mocks.imageVerify.mockResolvedValue(snapshot);
    await app.engine.port.flash(
      target,
      { ...policy, osByCodename: { akita: os } },
      { ...execution, osSnapshot: snapshot },
    );
    expect(mocks.android.flash).toHaveBeenCalled();
    await expect(
      app.engine.port.flash(
        target,
        { ...policy, osByCodename: { akita: { ...os, release: '2026100700' } } },
        { ...execution, osSnapshot: snapshot },
      ),
    ).rejects.toThrow('snapshot policy differs');
    expect(mocks.imageVerify).not.toHaveBeenCalled();
  });

  it('passes private input references and durable ownership into recipes/probes without retaining plaintext', async () => {
    const app = await openApp();
    const configured: RecipePolicy = {
      schemaVersion: 1,
      id: 'setup',
      packageId: 'org.example.vpn',
      versionCode: 12,
      signerSha256: hashB,
      buildFingerprint: 'test/akita/build',
      steps: [{ action: 'back' }],
      postconditions: [{ text: 'Ready' }],
    };
    await app.engine.port.runRecipe?.(target, user, configured, execution);
    expect(mocks.recipeRun).toHaveBeenCalledWith(target, user, configured, {
      ...execution,
      inputs: { vpn_config: { path: join(projectRoot, 'secrets/vpn.conf'), sha256: hashA } },
    });
    await expect(
      app.engine.port.runRecipe?.(target, user, configured, { lease: execution.lease }),
    ).rejects.toThrow('Durable recipe');
    const probe: NetworkProbePolicy = {
      artifact: {
        packageId: 'org.pxv.probe',
        versionCode: 1,
        sha256: hashA,
        signerSha256: hashB,
        path: '/approved/helper.apk',
      },
      endpoint: 'https://example.org/check',
      expectedEgressCidrs: ['192.0.2.0/24'],
      requireVpn: false,
      failurePackages: [],
    };
    await app.engine.port.runProbe?.(target, user, probe, execution);
    expect(mocks.probeRun).toHaveBeenCalled();
    await expect(app.engine.port.runProbe?.(target, user, probe, { lease: execution.lease })).rejects.toThrow(
      'durable ownership',
    );
    const noPath = { ...probe.artifact };
    delete noPath.path;
    await expect(
      app.engine.port.runProbe?.(target, user, { ...probe, artifact: noPath }, execution),
    ).rejects.toThrow('Reviewed probe');
    await rm(join(projectRoot, 'secrets/vpn.conf'));
    await symlink('/tmp', join(projectRoot, 'secrets/vpn.conf'));
    await expect(app.engine.port.runRecipe?.(target, user, configured, execution)).rejects.toThrow(
      'symlinks',
    );
  });

  it('runs only typed recovery and the retained verified helper for a service restart', async () => {
    const app = await openApp();
    const context = { ...execution, operationId: 'root-run' };
    await app.engine.port.cleanup?.(target, obligation, context);
    expect(mocks.android.cleanup).toHaveBeenCalledWith(target, obligation, {
      ...context,
      operationId: obligation.ownerOperationId,
    });
    const helper = {
      packageId: 'org.pxv.probe',
      versionCode: 1,
      sha256: hashA,
      signerSha256: hashB,
      path: join(projectRoot, 'state/plans/old-plan/helper.apk'),
    };
    await mkdir(join(projectRoot, 'state/plans/old-plan'), { recursive: true });
    await writeFile(helper.path, 'helper');
    const service = { ...obligation, kind: 'restart-service', payload: { helperArtifact: helper } };
    await app.engine.port.cleanup?.(target, service, context);
    expect(mocks.recoverService).toHaveBeenCalledWith(target, service, helper, {
      ...context,
    });
    await expect(
      app.engine.port.cleanup?.(target, service, { lease: execution.lease, operationId: 'root-run' }),
    ).rejects.toThrow('Durable recovery');
    const withoutPath = { ...helper };
    delete (withoutPath as { path?: string }).path;
    await expect(
      app.engine.port.cleanup?.(
        target,
        {
          ...service,
          payload: { helperArtifact: { ...withoutPath, url: 'https://example.org/helper.apk' } },
        },
        context,
      ),
    ).rejects.toThrow('Original reviewed recovery helper');
    await expect(
      app.engine.port.cleanup?.(
        target,
        { ...service, payload: { helperArtifact: { ...helper, path: '/tmp/outside.apk' } } },
        context,
      ),
    ).rejects.toThrow('retained reviewed plan');
  });

  it('retains construction and disposal failures together', async () => {
    const close = vi.fn(() => Promise.reject(new Error('storage disposal failed')));
    const open = vi.spyOn(SqliteStore, 'open').mockResolvedValueOnce({ close } as unknown as SqliteStore);
    mocks.discover.mockRejectedValueOnce(new Error('dependency discovery failed'));
    try {
      await expect(application(projectRoot, resources)).rejects.toMatchObject({
        message: 'Application construction failed and storage disposal failed',
        errors: [
          expect.objectContaining({ message: 'dependency discovery failed' }),
          expect.objectContaining({ message: 'storage disposal failed' }),
        ],
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });

  it('closes the dedicated store when application dependency discovery fails', async () => {
    const opened = await SqliteStore.open(join(projectRoot, 'state/pxv.sqlite3'));
    const close = vi.spyOn(opened, 'close');
    const open = vi.spyOn(SqliteStore, 'open').mockResolvedValueOnce(opened);
    mocks.discover.mockRejectedValueOnce(new Error('dependency discovery failed'));
    try {
      await expect(application(projectRoot, resources)).rejects.toThrow('dependency discovery failed');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  it('redacts raw serials and private paths recursively without leaking private path fields', () => {
    expect(
      redact(
        {
          path: '/private',
          installPath: '/extension',
          canonicalSerial: 'PIXEL1',
          data: ['PIXEL1', null, 3, { serial: 'prefix PIXEL1 suffix' }],
        },
        ['PIXEL1'],
      ),
    ).toEqual({ data: ['<device-serial>', null, 3, { serial: 'prefix <device-serial> suffix' }] });
  });
});
