import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactService,
  AndroidAdapter,
  ImageService,
  RepositoryService,
  HostTools,
  RecipeService,
  NetworkProbeService,
  observeEmulatorProvenance,
  type RepositoryEvidence,
} from '@pxv/adapters';
import { CommandRunner, hostControlRoot, SqliteStore } from '@pxv/runtime';
import {
  containedPath,
  loadProject,
  loadProduct,
  WorkflowEngine,
  type ArtifactPort,
  type ExecutionContext,
  type WorkflowPort,
} from '@pxv/engine';
import {
  digest,
  validateArtifact,
  type ArtifactPolicy,
  type ProductDescriptor,
  type SelectedTarget,
} from '@pxv/contracts';
import { ExtensionManager } from '@pxv/extensions';
import { homedir } from 'node:os';

export async function resourceRoot(explicit?: string): Promise<string> {
  if (explicit) return resolve(explicit);
  const candidates = [
    process.env['PXV_RESOURCE_ROOT'],
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    dirname(fileURLToPath(import.meta.url)),
  ];
  for (const path of candidates)
    if (
      path &&
      (await access(join(path, 'product.json')).then(
        () => true,
        () => false,
      ))
    )
      return path;
  throw new Error('Installed product resources are missing');
}

export async function productAt(root: string): Promise<ProductDescriptor> {
  return loadProduct(join(root, 'product.json'));
}

export async function application(
  root: string,
  resources: string,
  readOnly = false,
): Promise<{ engine: WorkflowEngine; store: SqliteStore; runner: CommandRunner; android: AndroidAdapter }> {
  const product = await productAt(resources);
  const project = await loadProject(root, product, resources);
  if (!readOnly) {
    const manager = new ExtensionManager({
      installRoot:
        process.env['PXV_EXTENSION_ROOT'] ??
        join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share'), 'pxv/extensions'),
    });
    for (const extension of project.config.extensions) await manager.inspect(extension);
  }
  const database = join(project.root, 'state/pxv.sqlite3');
  await access(database); // Only project init may create a database.
  const store = await SqliteStore.open(database, { readOnly });
  const runner = new CommandRunner();
  const tools = new HostTools({ runner });
  const pathFor = async (name: Parameters<HostTools['discover']>[0]): Promise<string> =>
    (await tools.discover(name)) ?? name;
  const artifacts = new ArtifactService({
    runner,
    aapt: await pathFor('aapt'),
    apksigner: await pathFor('apksigner'),
  });
  const images = new ImageService({ runner, sshKeygen: await pathFor('ssh-keygen') });
  const android = new AndroidAdapter({
    runner,
    artifacts,
    adb: await pathFor('adb'),
    fastboot: await pathFor('fastboot'),
  });
  const repositories = new RepositoryService({
    runner,
    java: await pathFor('java'),
    verifierPath: join(resources, 'resources/VerifyRepositoryIndex.java'),
    freshness: {
      read: (key) => store.get('repository-freshness', key),
      async advance(key, previous, next) {
        if (!(await store.compareAndSet('repository-freshness', key, previous, next)))
          throw new Error('Concurrent repository observation; prepare again');
      },
    },
  });
  const artifactPort: ArtifactPort = {
    async snapshot(artifact, destination, signal, target) {
      await Promise.all([tools.require('aapt'), tools.require('apksigner')]);
      let source = artifact;
      let evidence: RepositoryEvidence | undefined;
      if (artifact.path) source = { ...artifact, path: await containedPath(project.root, artifact.path) };
      if (artifact.repositoryId) {
        await tools.require('java');
        const repository = project.policy.repositories.find((value) => value.id === artifact.repositoryId);
        if (!repository) throw new Error('Unknown authenticated repository');
        if (!target) throw new Error('Repository selection requires measured target SDK and ABIs');
        const index = await repositories.index(repository, signal ? { signal } : {});
        const sdk = Number(
          (await android.shell(target, ['getprop', 'ro.build.version.sdk'], signal ? { signal } : {})).trim(),
        );
        const abis = (
          await android.shell(target, ['getprop', 'ro.product.cpu.abilist'], signal ? { signal } : {})
        )
          .trim()
          .split(',')
          .filter(Boolean);
        const approved = repositories.candidate(index, artifact.packageId, {
          sdk,
          abis,
          versionCode: artifact.versionCode,
        });
        if (approved.sha256 !== artifact.sha256 || approved.signerSha256 !== artifact.signerSha256)
          throw new Error('Reviewed APK differs from the authenticated repository candidate');
        source = approved;
        evidence = index.evidence;
      }
      const verified = await artifacts.snapshot(source, destination, signal);
      if (evidence) await store.set('artifact-provenance', digest(destination), evidence);
      return {
        ...verified,
        path: verified.path,
        ...(source.repositoryId ? { repositoryId: source.repositoryId } : {}),
      };
    },
    async snapshotOs(policy, directory, signal) {
      if (process.env['PXV_DOCKER_MODE'] === 'host-adb') throw new Error('Fastboot requires direct USB mode');
      await tools.require('ssh-keygen');
      return images.snapshot(policy, directory, signal);
    },
    async validateBeforeExecution(artifact) {
      if (!artifact.repositoryId) return;
      const repository = project.policy.repositories.find((value) => value.id === artifact.repositoryId);
      const evidence = artifact.path
        ? await store.get<RepositoryEvidence>('artifact-provenance', digest(artifact.path))
        : undefined;
      if (!repository || !evidence) throw new Error('Reviewed repository evidence is missing');
      await repositories.validateEvidence(repository, evidence);
    },
  };
  const port: WorkflowPort = {
    async inspect(target, policy, signal) {
      await tools.require('adb');
      if (policy.profiles.some((profile) => profile.packages.length > 0))
        await Promise.all([tools.require('aapt'), tools.require('apksigner')]);
      return android.inspect(target, policy, signal);
    },
    createUser: (target, profile, context) => android.createUser(target, profile, context),
    sharedEffects: (target, packages, signal) => android.inspectSharedEffects(target, packages, signal),
    async install(target, user, artifact, context) {
      if (!artifact.path) throw new Error('Reviewed immutable APK snapshot missing');
      await android.install(
        target,
        user,
        await artifacts.inspect(artifact.path, artifact, context.signal),
        context,
      );
    },
    applySetting: (target, user, setting, context) => android.applySetting(target, user, setting, context),
    applyPermission: (target, user, permission, context) =>
      android.applyPermission(target, user, permission, context),
    applyVpn: (target, user, vpn, context) => android.applyVpn(target, user, vpn, context),
    language: (target, user, language, context) => android.setupLanguage(target, user, language, context),
    async flash(target: SelectedTarget, policy, context: ExecutionContext) {
      if (process.env['PXV_DOCKER_MODE'] === 'host-adb') throw new Error('Fastboot requires direct USB mode');
      await Promise.all([tools.require('fastboot'), tools.require('ssh-keygen')]);
      if (!policy.os) throw new Error('Pinned OS policy missing');
      if (!context.osSnapshot) throw new Error('Reviewed OS snapshot missing');
      const image = await images.verify(
        context.osSnapshot.path,
        context.osSnapshot.signaturePath,
        policy.os,
        context.signal,
      );
      if (
        image.sha256 !== context.osSnapshot.sha256 ||
        image.signatureSha256 !== context.osSnapshot.signatureSha256
      )
        throw new Error('Reviewed OS bytes changed');
      await android.flash(target, image, context);
    },
    finalize: (target, context) => android.finalize(target, context),
    verifyEmulatorEvidence: (target, evidence, signal) =>
      observeEmulatorProvenance(android, target, evidence, project.policy.capabilities, signal),
    async inspectUser(target, user, signal) {
      await android.guardTarget(target, signal);
      const current = (await android.users(target, signal)).find((value) => value.userId === user.userId);
      if (!current) throw new Error('Original Android user is absent; recovery requires inspection');
      return current;
    },
    async cleanup(target, obligation, context) {
      if (obligation.kind === 'restart-service') {
        if (!context.obligations) throw new Error('Durable recovery ownership is required');
        const artifact = validateArtifact(obligation.payload['helperArtifact']);
        if (!artifact.path) throw new Error('Original reviewed recovery helper is missing');
        const local = relative(project.root, artifact.path);
        if (!local.startsWith('state/plans/'))
          throw new Error('Recovery helper must belong to the retained reviewed plan');
        const path = await containedPath(project.root, local);
        const helper = await artifacts.inspect(path, artifact, context.signal);
        await new NetworkProbeService(android).recoverService(target, obligation, helper, {
          ...context,
          operationId: obligation.operationId,
          obligations: context.obligations,
        });
        return;
      }
      await android.cleanup(target, obligation, { ...context, operationId: obligation.ownerOperationId });
    },
    async runRecipe(target, user, recipe, context) {
      if (!context.operationId || !context.obligations)
        throw new Error('Durable recipe ownership is required');
      const inputs: Record<string, { path: string; sha256: string }> = {};
      for (const [name, source] of Object.entries(target.device.inputs ?? {}))
        inputs[name] = { path: await containedPath(project.root, source.path), sha256: source.sha256 };
      const result = await new RecipeService(android).run(target, user, recipe, {
        ...context,
        operationId: context.operationId,
        obligations: context.obligations,
        inputs,
      });
      return result;
    },
    async runProbe(target, user, probe, context) {
      if (!context.operationId || !context.obligations || !probe.artifact.path)
        throw new Error('Reviewed probe helper and durable ownership required');
      const helper = await artifacts.inspect(probe.artifact.path, probe.artifact, context.signal);
      return new NetworkProbeService(android).run(
        target,
        user,
        helper,
        probe,
        { ...context, operationId: context.operationId, obligations: context.obligations },
        probe.failurePackages,
      );
    },
  };
  return {
    engine: new WorkflowEngine({
      project,
      store,
      port,
      artifacts: artifactPort,
      controlRoot: hostControlRoot(),
    }),
    store,
    runner,
    android,
  };
}

export function redact(value: unknown, serials: string[]): unknown {
  if (typeof value === 'string')
    return serials.reduce((result, serial) => result.replaceAll(serial, '<device-serial>'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, serials));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['path', 'installPath', 'canonicalSerial'].includes(key))
        .map(([key, item]) => [key, redact(item, serials)]),
    );
  return value;
}

export function publicArtifacts(artifacts: ArtifactPolicy[]): unknown {
  return artifacts.map(({ packageId, versionCode, sha256, signerSha256 }) => ({
    packageId,
    versionCode,
    sha256,
    signerSha256,
  }));
}
