import {
  NetworkProbeService,
  CredentialDefaultsService,
  observeEmulatorProvenance,
  RecipeService,
  SeedvaultAdapter,
  restoreCollectionForeground,
} from '@pxv/adapters';
import { canonicalJson, osPolicyForTarget, validateArtifact, type SelectedTarget } from '@pxv/contracts';
import { containedPath, type ExecutionContext, type WorkflowPort } from '@pxv/engine';
import { relative } from 'node:path';
import type { ApplicationDependencies } from './dependencies.js';
function corePort(
  deps: ApplicationDependencies,
): Omit<WorkflowPort, 'inspectUser' | 'cleanup' | 'runRecipe' | 'runProbe'> {
  const { tools, android, project } = deps;
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
      await android.install(target, user, { ...artifact, path: artifact.path }, context);
    },
    applySetting: (target, user, setting, context) => android.applySetting(target, user, setting, context),
    applyPermission: (target, user, permission, context) =>
      android.applyPermission(target, user, permission, context),
    applyVpn: (target, user, vpn, context) => android.applyVpn(target, user, vpn, context),
    language: (target, user, language, context) => android.setupLanguage(target, user, language, context),
    async flash(target: SelectedTarget, policy, context: ExecutionContext) {
      if (process.env['PXV_DOCKER_MODE'] === 'host-adb') throw new Error('Fastboot requires direct USB mode');
      await Promise.all([tools.require('fastboot'), tools.require('ssh-keygen')]);
      const os = osPolicyForTarget(policy, target.device.codename);
      if (!os) throw new Error('Pinned OS policy missing');
      if (!context.osSnapshot) throw new Error('Reviewed OS snapshot missing');
      if (canonicalJson(os) !== canonicalJson(context.osSnapshot.policy))
        throw new Error('Reviewed OS snapshot policy differs from the selected target');
      await android.flash(target, context.osSnapshot, context);
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
      if (['oblivion-foreground', 'collection-foreground'].includes(obligation.kind))
        return restoreCollectionForeground(android, target, obligation, context);
      if (obligation.kind === 'seedvault-job' || obligation.kind === 'seedvault-foreground') {
        await new SeedvaultAdapter(android).cleanup(target, obligation, context);
        return;
      }
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
function credentialPort(
  deps: ApplicationDependencies,
): Pick<WorkflowPort, 'credentialDefaultsPreflight' | 'setCredentialDefault' | 'setDuressDefault'> {
  const defaults = () => new CredentialDefaultsService(deps.android, deps.project.root, deps.project.policy);
  return {
    credentialDefaultsPreflight: (target, signal) => defaults().preflight(target, signal),
    setCredentialDefault: (target, user, profile, context) =>
      defaults().setCredential(target, user, profile, context),
    setDuressDefault: (target, user, profile, context) =>
      defaults().setDuress(target, user, profile, context),
  };
}
export function createWorkflowPort(deps: ApplicationDependencies): WorkflowPort {
  return {
    capabilities: { uiAutomation: Boolean(deps.android.ui) },
    ...corePort(deps),
    ...recoveryPort(deps),
    ...recipePort(deps),
    ...credentialPort(deps),
  };
}
