import { NetworkProbeService, observeEmulatorProvenance, RecipeService } from '@pxv/adapters';
import { validateArtifact, type SelectedTarget } from '@pxv/contracts';
import { containedPath, type ExecutionContext, type WorkflowPort } from '@pxv/engine';
import { relative } from 'node:path';
import type { ApplicationDependencies } from './dependencies.js';
function corePort(
  deps: ApplicationDependencies,
): Omit<WorkflowPort, 'inspectUser' | 'cleanup' | 'runRecipe' | 'runProbe'> {
  const { tools, android, artifacts, images, project } = deps;
  return {
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
  };
}
function recoveryPort(deps: ApplicationDependencies): Pick<WorkflowPort, 'inspectUser' | 'cleanup'> {
  const { android, artifacts, project } = deps;
  return {
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
          obligations: context.obligations,
        });
        return;
      }
      await android.cleanup(target, obligation, { ...context, operationId: obligation.ownerOperationId });
    },
  };
}
function recipePort(deps: ApplicationDependencies): Pick<WorkflowPort, 'runRecipe' | 'runProbe'> {
  const { android, artifacts, project } = deps;
  return {
    async runRecipe(target, user, recipe, context) {
      if (!context.obligations) throw new Error('Durable recipe ownership is required');
      const inputs: Record<string, { path: string; sha256: string }> = {};
      for (const [name, source] of Object.entries(target.device.inputs ?? {}))
        inputs[name] = { path: await containedPath(project.root, source.path), sha256: source.sha256 };
      const result = await new RecipeService(android).run(target, user, recipe, {
        ...context,
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
        { ...context, obligations: context.obligations },
        probe.failurePackages,
      );
    },
  };
}
export function createWorkflowPort(deps: ApplicationDependencies): WorkflowPort {
  return { ...corePort(deps), ...recoveryPort(deps), ...recipePort(deps) };
}
