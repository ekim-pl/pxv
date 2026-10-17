import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  absent,
  canonical,
  contained,
  copyPrivate,
  copyTree,
  distinctRoots,
  fileHash,
  incompleteGeneration,
  privateJson,
  publishGeneration,
  readJson,
  safePath,
  seedvaultDirectory,
  treeDirectories,
  treeFiles,
} from './personal-files.mjs';
import {
  qualifiedAdapter,
  validateAdapterEvidence,
  validateCoverageInventory,
  validateMasterProfiles,
} from './personal-validation.mjs';

/** @param {unknown} value */
export async function normalizedPolicy(value) {
  const { validatePolicy } = await import('../../packages/contracts/dist/index.js');
  return validatePolicy(value);
}
/** @param {any} policy @param {string} codename */
export async function selectedOsPolicy(policy, codename) {
  const { osPolicyForTarget } = await import('../../packages/contracts/dist/index.js');
  return osPolicyForTarget(policy, codename);
}

/** @param {string} root */
export async function installedIdentity(root) {
  const product = await readJson(join(root, 'product.json'));
  const { engineIntegrity } = await import(
    pathToFileURL(join(root, 'packages/engine/dist/integrity.js')).href
  );
  return { product, engineVersion: product.upstreamVersion, engineDigest: await engineIntegrity(root) };
}
/** @param {any} manifest @param {any} identity */
export function compatibleIdentity(manifest, identity) {
  if (
    canonical(manifest.product) !== canonical(identity.product) ||
    manifest.engineVersion !== identity.engineVersion ||
    manifest.engineDigest !== identity.engineDigest
  )
    throw new Error('Master requires the same reviewed PXV product and executable build');
}
/** @param {any} policy @returns {{path:string,sha256:string}[]} */
export function localArtifacts(policy) {
  const found = new Map();
  for (const profile of policy.profiles) {
    if (
      (profile.recipes ?? []).some((/** @type {any} */ recipe) =>
        recipe.steps.some((/** @type {any} */ step) =>
          ['stage-file', 'select-staged-file'].includes(step.action),
        ),
      )
    )
      throw new Error(
        'Private staged-file recipes require fresh device-specific inputs; these examples do not clone them',
      );
    for (const artifact of [
      ...profile.packages,
      ...(profile.networkProbe ? [profile.networkProbe.artifact] : []),
    ]) {
      if (!artifact.path) continue;
      contained('/project', artifact.path);
      if (
        /^(?:state|secrets|backups)(?:\/|$)|^(?:policy.json|policy.yaml|pxv.project.json|policy.lock.json|inventory.json)$/u.test(
          artifact.path,
        )
      )
        throw new Error('APK source collides with private project metadata: ' + artifact.path);
      if (found.has(artifact.path) && found.get(artifact.path) !== artifact.sha256)
        throw new Error('Conflicting APK digests for the same path');
      found.set(artifact.path, artifact.sha256);
    }
  }
  return [...found].map(([path, sha256]) => ({ path, sha256 }));
}
/** @param {any} policy @param {string} source @param {string} destination */
export async function copyArtifacts(policy, source, destination) {
  for (const artifact of localArtifacts(policy)) {
    const path = contained(source, artifact.path);
    if ((await fileHash(path)) !== artifact.sha256.toLowerCase())
      throw new Error('Reviewed APK digest differs: ' + artifact.path);
    const copied = await copyPrivate(path, contained(destination, artifact.path));
    if (copied.sha256 !== artifact.sha256.toLowerCase()) throw new Error('APK changed while copying');
  }
}
/** @param {string} project @param {string} deviceSerial */
export async function projectSnapshot(project, deviceSerial) {
  const config = await readJson(join(project, 'pxv.project.json'));
  if (config.extensions.length) throw new Error('These examples require an extension-free project');
  const source = await readJson(contained(project, config.policyFile));
  const policy = await normalizedPolicy(source);
  const lock = await readJson(join(project, 'policy.lock.json'));
  if (canonical(policy) !== canonical(lock.policy) || canonical(config) !== canonical(lock.project))
    throw new Error('Review and write a current policy lock before making a master');
  const inventory = await readJson(contained(project, config.inventoryFile));
  const devices = inventory.devices.filter(
    (/** @type {any} */ device) => device.kind === 'pixel' && device.canonicalSerial === deviceSerial,
  );
  if (devices.length !== 1) throw new Error('Backup report must identify one enrolled physical Pixel');
  const os = await selectedOsPolicy(policy, devices[0].codename);
  if (!os) throw new Error('A reviewed pinned GrapheneOS policy is required for the enrolled model');
  localArtifacts(policy);
  return { config, policy, lock, os };
}
/** @param {any} report @param {string[]} expected */
export function completedEvidence(report, expected) {
  if (report.operation !== 'backup' || report.status !== 'completed' || !Array.isArray(report.profiles))
    throw new Error('A durable completed Seedvault backup report is required');
  if (
    canonical(report.profiles.map((/** @type {any} */ p) => p.profileId).sort()) !==
    canonical([...expected].sort())
  )
    throw new Error('Seedvault report does not cover every requested profile');
  return report.profiles.map(profileEvidence);
}
/** @param {any} profile */
function profileEvidence(profile) {
  const evidence = profile.evidence;
  if (!evidence || !evidence.source) throw new Error('Missing per-profile backup evidence');
  const checks = [
    profile.status === 'completed',
    evidence.operation === 'backup',
    evidence.profileId === profile.profileId,
    evidence.apps === true,
    evidence.files === true,
    evidence.finalized === true,
    /^[a-f0-9]+$/u.test(evidence.token),
    evidence.source.profileId === profile.profileId,
    evidence.source.token === evidence.token,
    !!evidence.source.selector,
  ];
  if (checks.some((passed) => !passed))
    throw new Error('Incomplete app/file backup evidence for profile ' + profile.profileId);
  return evidence;
}
/** @param {{project:string,usb:string,destination:string,report:any,expected:string[],identity:any,coverage:any,adapter:any}} options */
export async function createMaster(options) {
  await distinctRoots([options.project, options.usb, options.destination]);
  const snapshot = await projectSnapshot(options.project, options.report.deviceSerial);
  compatibleIdentity(snapshot.lock, options.identity);
  const profiles = completedEvidence(options.report, options.expected);
  await validateMasterProfiles({ seedvault: { profiles } }, snapshot.policy);
  validateCoverageInventory(options.coverage, options.expected);
  await validateAdapterEvidence(options.adapter, profiles);
  const pending = await incompleteGeneration(options.destination);
  try {
    return await finishMaster(options, snapshot, profiles, pending);
  } catch (error) {
    throw new Error(
      'Master remains INCOMPLETE at ' +
        pending +
        ': ' +
        (error instanceof Error ? error.message : 'copy failed'),
      { cause: error },
    );
  }
}
/** @param {any} options @param {any} snapshot @param {any[]} profiles @param {string} pending */
async function finishMaster(options, snapshot, profiles, pending) {
  await copyTree(join(options.usb, seedvaultDirectory), join(pending, 'seedvault', seedvaultDirectory));
  await mkdir(join(pending, 'project'), { mode: 0o700 });
  const { toPolicyDocument } = await import('../../packages/contracts/dist/index.js');
  await privateJson(join(pending, 'project/policy.json'), toPolicyDocument(snapshot.policy));
  await copyArtifacts(snapshot.policy, options.project, join(pending, 'project'));
  await copyQualification(options.adapter, pending);
  const files = [];
  for (const path of (await treeFiles(pending)).filter((name) => name !== 'INCOMPLETE.json'))
    files.push({ path, sha256: await fileHash(contained(pending, path)) });
  const manifest = {
    format: 'pxv-personal-master',
    schemaVersion: 1,
    complete: false,
    copyIntegrityVerified: true,
    allProfileJobsCompleted: true,
    generationCorrespondence: 'unverified',
    restoration: 'untested',
    createdAt: new Date().toISOString(),
    ...options.identity,
    codename: snapshot.os.codename,
    sourceProjectId: snapshot.config.id,
    files,
    directories: await treeDirectories(pending),
    coverage: options.coverage,
    qualification: {
      adapter: 'qualification/adapter.json',
      acceptance: 'qualification/acceptance.json',
      originalAdapterDigest: profiles[0].adapterDigest,
    },
    seedvault: { runId: options.report.runId, deviceSerial: options.report.deviceSerial, profiles },
  };
  await privateJson(join(pending, 'master.json'), manifest);
  await rm(join(pending, 'INCOMPLETE.json'));
  await publishGeneration(pending, options.destination);
  return manifest;
}
/** @param {string} root */
export async function verifyMaster(root) {
  await safePath(root);
  const manifest = await readJson(join(root, 'master.json'));
  assertMasterHeader(manifest);
  await verifyRecordedTree(root, manifest);
  const policy = await normalizedPolicy(await readJson(join(root, 'project/policy.json')));
  for (const artifact of localArtifacts(policy))
    if ((await fileHash(contained(join(root, 'project'), artifact.path))) !== artifact.sha256.toLowerCase())
      throw new Error('Master APK differs from its reviewed policy: ' + artifact.path);
  if (!(await selectedOsPolicy(policy, manifest.codename))) throw new Error('Master OS identity differs');
  await validateMasterProfiles(manifest, policy);
  await verifyQualification(root, manifest);
  validateCoverageInventory(
    manifest.coverage,
    policy.profiles.map((/** @type {any} */ profile) => profile.id),
  );
  return { manifest, policy };
}
/** @param {string} root @param {any} manifest */
async function verifyRecordedTree(root, manifest) {
  const expected = new Set(['master.json']);
  for (const file of manifest.files) {
    if (expected.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256))
      throw new Error('Invalid master file manifest');
    expected.add(file.path);
    if ((await fileHash(contained(root, file.path))) !== file.sha256)
      throw new Error('Master digest mismatch: ' + file.path);
  }
  if (canonical(await treeFiles(root)) !== canonical([...expected].sort()))
    throw new Error('Master contains unmanifested files');
  if (canonical(await treeDirectories(root)) !== canonical(manifest.directories))
    throw new Error('Master contains changed or unmanifested directories');
}
/** @param {any} definition @param {string} pending */
async function copyQualification(definition, pending) {
  const directory = join(pending, 'qualification');
  await mkdir(directory, { mode: 0o700 });
  const copied = await copyPrivate(definition.acceptance.path, join(directory, 'acceptance.json'));
  if (copied.sha256 !== definition.acceptance.sha256)
    throw new Error('Acceptance proof changed while copying');
  const portable = structuredClone(definition);
  portable.acceptance.path = 'acceptance.json';
  await privateJson(join(directory, 'adapter.json'), portable);
}
/** @param {string} root @param {any} manifest */
async function verifyQualification(root, manifest) {
  if (
    manifest.qualification?.adapter !== 'qualification/adapter.json' ||
    manifest.qualification.acceptance !== 'qualification/acceptance.json'
  )
    throw new Error('Master lacks portable adapter qualification dependencies');
  await qualifiedAdapter(join(root, 'qualification/adapter.json'));
  if (
    manifest.seedvault.profiles.some(
      (/** @type {any} */ profile) => profile.adapterDigest !== manifest.qualification.originalAdapterDigest,
    )
  )
    throw new Error('Master qualification identity differs from the original backup evidence');
}
/** @param {any} manifest */
function assertMasterHeader(manifest) {
  const checks = [
    manifest.format === 'pxv-personal-master',
    manifest.schemaVersion === 1,
    manifest.complete === false,
    manifest.copyIntegrityVerified === true,
    manifest.allProfileJobsCompleted === true,
    manifest.generationCorrespondence === 'unverified',
    manifest.restoration === 'untested',
    Array.isArray(manifest.files),
    manifest.files?.length > 0,
    !!manifest.coverage,
  ];
  if (checks.some((passed) => !passed))
    throw new Error('Expected an intact retained personal backup copy and its honest verification status');
}
/** @param {string} master @param {string} usb */
export async function workingUsb(master, usb) {
  await distinctRoots([master, usb]);
  await verifyMaster(master);
  await absent(join(usb, seedvaultDirectory));
  await copyTree(join(master, 'seedvault', seedvaultDirectory), join(resolve(usb), seedvaultDirectory));
}
