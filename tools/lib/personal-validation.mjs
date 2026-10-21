import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, readJson, safePath } from './personal-files.mjs';

const resources = fileURLToPath(new URL('../../', import.meta.url));
/** Runtime uses the same built contracts as the pinned CLI. */
async function contracts() {
  return import(pathToFileURL(resolve(resources, 'packages/contracts/dist/index.js')).href);
}
/** Check the same resource descriptor supplied to every child CLI before any mutation.
 * @param {string} root */
export async function requirePersonalRecovery(root) {
  const { validateProduct } = await contracts();
  const product = validateProduct(await readJson(resolve(root, 'product.json')));
  if (product.features?.seedvault === false)
    throw new Error('Personal recovery requires a Seedvault-enabled product; no changes were made');
}
/** Reuse operational approval verification; an existing project is never relocked by backup automation.
 * @param {string} root @param {string} projectRoot */
export async function requireBackupApproval(root, projectRoot) {
  const { loadProjectSources, policyLockStatus } = await import('../../packages/engine/dist/index.js');
  const { validateProduct, validatePolicy, resolvePolicy } = await contracts();
  const { installedIdentity } = await import('./personal-master.mjs');
  const identity = await installedIdentity(root);
  const { document, ...sources } = await loadProjectSources(
    projectRoot,
    validateProduct(identity.product),
    root,
  );
  const policy = validatePolicy(document);
  const project = {
    ...sources,
    policy,
    resolved: resolvePolicy(policy, sources.config, sources.product, identity.engineDigest),
  };
  const status = await policyLockStatus(project);
  if (status !== 'current')
    throw new Error(
      'Policy lock is ' +
        status +
        '; run policy validate and explicitly renew policy lock before backup-only work',
    );
  return project.resolved.digest;
}
/** @param {string} path */
export async function qualifiedAdapter(path) {
  const { validateSeedvaultAdapter } = await contracts();
  const definition = validateSeedvaultAdapter(await readJson(path));
  definition.acceptance.path = resolve(dirname(resolve(path)), definition.acceptance.path);
  await safePath(definition.acceptance.path);
  const { verifySeedvaultAcceptance } = await import(
    pathToFileURL(resolve(resources, 'packages/adapters/dist/seedvault-recovery.js')).href
  );
  await verifySeedvaultAcceptance(definition);
  return definition;
}
/** @param {any} definition @param {any[]} profiles */
export async function validateAdapterEvidence(definition, profiles) {
  const { validateSeedvaultAdapter, digest } = await contracts();
  validateSeedvaultAdapter(definition);
  await safePath(definition.acceptance.path);
  const { verifySeedvaultAcceptance } = await import(
    pathToFileURL(resolve(resources, 'packages/adapters/dist/seedvault-recovery.js')).href
  );
  await verifySeedvaultAcceptance(definition);
  const expected = digest(definition);
  if (profiles.some((profile) => profile.adapterDigest !== expected))
    throw new Error('Backup evidence differs from the retained qualified adapter');
  return expected;
}
/** All public source identities must be valid before copying or erasing anything. @param {any} manifest @param {any} policy */
export async function validateMasterProfiles(manifest, policy) {
  const { validateSeedvaultEvidence, seedvaultSourceProfileSchema } = await contracts();
  if (!Array.isArray(manifest.seedvault?.profiles))
    throw new Error('Master has no per-profile Seedvault evidence');
  const profiles = manifest.seedvault.profiles.map((/** @type {unknown} */ value) =>
    validateSeedvaultEvidence(value),
  );
  const expected = policy.profiles.map((/** @type {any} */ profile) => profile.id).sort();
  if (
    canonical(profiles.map((/** @type {any} */ profile) => profile.profileId).sort()) !== canonical(expected)
  )
    throw new Error('Master evidence must cover every policy profile exactly once');
  for (const profile of profiles) {
    seedvaultSourceProfileSchema.parse(profile.source);
    if (
      profile.operation !== 'backup' ||
      profile.source.profileId !== profile.profileId ||
      profile.source.token !== profile.token
    )
      throw new Error('Master backup source identity differs from its completion evidence');
  }
}
/** @param {string} path @param {string[]} expected */
export async function readCoverage(path, expected) {
  const value = await readJson(path);
  return validateCoverageInventory(value, expected);
}
/** @param {any} value @param {string[]} expected */
export function validateCoverageInventory(value, expected) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.profiles))
    throw new Error('Coverage inventory requires schemaVersion:1 and profiles[]');
  if (
    canonical(value.profiles.map((/** @type {any} */ profile) => profile.profileId).sort()) !==
    canonical([...expected].sort())
  )
    throw new Error('Coverage inventory must list every policy profile exactly once');
  for (const profile of value.profiles) validateCoverageProfile(profile);
  return { ...value, allAppsRecoverable: false, source: 'private-operator-inventory' };
}
/** @param {any} profile */
function validateCoverageProfile(profile) {
  if (!Array.isArray(profile.apps) || typeof profile.files !== 'string' || !Array.isArray(profile.exclusions))
    throw new Error('Each coverage profile requires apps[], files description and exclusions[]');
  for (const app of profile.apps)
    if (
      typeof app.packageId !== 'string' ||
      !['seedvault', 'exported', 'excluded', 'unknown'].includes(app.status)
    )
      throw new Error('Coverage apps require packageId and seedvault|exported|excluded|unknown status');
  if (profile.exclusions.some((/** @type {unknown} */ item) => typeof item !== 'string'))
    throw new Error('Coverage exclusions must be private descriptive strings');
}
/** @param {any} report @param {any[]} sources */
export async function validateRestoreReport(report, sources) {
  const { validateSeedvaultEvidence } = await contracts();
  if (report.operation !== 'restore' || report.status !== 'completed' || !Array.isArray(report.profiles))
    throw new Error('Restoration is incomplete; retain the project and inspect its exact run');
  const expected = sources.map((source) => source.profileId).sort();
  if (
    canonical(report.profiles.map((/** @type {any} */ profile) => profile.profileId).sort()) !==
    canonical(expected)
  )
    throw new Error('Restore report must cover every selected source profile');
  for (const profile of report.profiles) {
    const evidence = validateSeedvaultEvidence(profile.evidence);
    const source = sources.find((item) => item.profileId === profile.profileId);
    if (
      profile.status !== 'completed' ||
      evidence.operation !== 'restore' ||
      canonical(evidence.source) !== canonical(source)
    )
      throw new Error('Restore report differs from the exact selected source');
  }
}
