import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  absent,
  canonical,
  contained,
  distinctRoots,
  fileHash,
  privateJson,
  readJson,
  safePath,
} from './personal-files.mjs';
import {
  compatibleIdentity,
  copyArtifacts,
  createMaster,
  installedIdentity,
  localArtifacts,
  normalizedPolicy,
  projectSnapshot,
  selectedOsPolicy,
  verifyMaster,
  workingUsb,
} from './personal-master.mjs';
import { checkpoint, invoke, jsonCommand, reviewedOperation, seedvaultOperation } from './personal-cli.mjs';
import {
  qualifiedAdapter,
  readCoverage,
  requirePersonalRecovery,
  requireBackupApproval,
  validateRestoreReport,
} from './personal-validation.mjs';

/** @typedef {Record<string,string|boolean|undefined>} Options */
/** @param {Options} options @param {string} name @param {string} [fallback] */
export function option(options, name, fallback) {
  const value = options[name] ?? fallback;
  if (typeof value !== 'string' || !value) throw new Error('--' + name + ' is required');
  return value;
}
/** @param {Options} options @param {string} root */
export async function preflight(options, root) {
  await requirePersonalRecovery(root);
  for (const name of ['project-root', 'usb-root']) await safePath(option(options, name));
  const usb = await lstat(option(options, 'usb-root'));
  if (!usb.isDirectory()) throw new Error('--usb-root must be the mounted USB drive directory');
  if (options['dry-run']) return;
  const pinned = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  if (process.versions.node !== pinned) throw new Error('Run this command with Node ' + pinned);
  await access(process.env['PXV_BIN'] ?? join(root, 'bin/pxv'), constants.X_OK);
  await readJson(option(options, 'seedvault-adapter'));
}
/** @param {string} project @param {string} asset */
async function enrolledDevice(project, asset) {
  const config = await readJson(join(project, 'pxv.project.json'));
  const inventory = await readJson(contained(project, config.inventoryFile));
  const matches = inventory.devices.filter((/** @type {any} */ device) => device.assetId === asset);
  if (matches.length !== 1 || matches[0].kind !== 'pixel')
    throw new Error('Select one enrolled physical Pixel asset');
  return matches[0];
}
/** @param {any} policy @param {string} source */
async function checkArtifacts(policy, source) {
  for (const artifact of localArtifacts(policy))
    if ((await fileHash(contained(source, artifact.path))) !== artifact.sha256.toLowerCase())
      throw new Error('Local APK does not match its reviewed digest: ' + artifact.path);
}
/** @param {any} session @param {string} policyFile @param {string} source @param {any} policy */
async function initialize(session, policyFile, source, policy) {
  await jsonCommand(session, ['project', 'init', '--path', session.project, '--policy', resolve(policyFile)]);
  await copyArtifacts(policy, source, session.project);
  await jsonCommand(session, ['policy', 'validate']);
  await jsonCommand(session, ['policy', 'lock', '--yes']);
}
/** @param {any} session @param {any} device @param {boolean} enroll */
async function install(session, device, enroll) {
  await checkpoint(
    session,
    'This installation ERASES the selected phone. Confirm its physical label, serial ' +
      device.canonicalSerial +
      ', model ' +
      device.model +
      ', and codename ' +
      device.codename +
      '.\nEnable OEM unlocking if needed, connect it directly by USB, and boot it into the bootloader. Attend physical unlock and relock prompts.',
    device.canonicalSerial,
  );
  if (enroll)
    await jsonCommand(session, [
      'inventory',
      'enroll',
      '--asset',
      session.asset,
      '--serial',
      device.canonicalSerial,
      '--model',
      device.model,
      '--codename',
      device.codename,
      '--kind',
      'pixel',
      '--transport',
      'usb',
      '--mode',
      'fastboot',
      '--yes',
    ]);
  await reviewedOperation(
    session,
    ['device', 'install-os', '--asset', session.asset, '--transport', 'usb'],
    'os',
  );
  await checkpoint(
    session,
    'Installation finished and the bootloader must be locked. Select Start, verify the expected GrapheneOS verified-boot key/build, and complete first boot without restoring yet.\nMatch the owner display name to the reviewed policy, enable USB debugging privately, and authorize this host.',
  );
  await jsonCommand(session, ['device', 'inspect', '--asset', session.asset, '--transport', 'usb']);
}
/** @param {any} session @param {Options} options */
async function verifyBackupCheckpoint(session, options) {
  if (
    options['backup-only'] &&
    (await requireBackupApproval(session.root, session.project)) !== session.backupApproval
  )
    throw new Error('Backup approval baseline changed during the physical checkpoint; restart the workflow');
}
/** @param {any} session @param {Options} options @param {any} device */
async function connectStorage(session, options, device) {
  await checkpoint(
    session,
    'Keep the phone connected by USB. Enable Wireless debugging on the trusted local network and obtain its advertised TLS address/port.\nKeep PINs and pairing codes out of files and logs. The optional pairing prompt belongs to PXV.',
  );
  await verifyBackupCheckpoint(session, options);
  const args = [
    'seedvault',
    'connect',
    '--asset',
    session.asset,
    '--serial',
    device.canonicalSerial,
    '--endpoint',
    option(options, 'endpoint'),
    '--yes',
  ];
  if (options['pair-endpoint']) args.push('--pair-endpoint', option(options, 'pair-endpoint'));
  const connected = await invoke(session, args);
  if (connected.code !== 0) throw new Error(connected.stderr || 'Verified wireless ADB connection failed');
  process.stdout.write(connected.stdout);
  await checkpoint(
    session,
    'Detach the USB drive from this computer and connect it to the phone. Keep wireless ADB connected. Unlock the owner profile and allow access to the drive.',
  );
  const inspection = await jsonCommand(session, [
    'seedvault',
    'inspect',
    '--asset',
    session.asset,
    '--transport',
    'wifi',
  ]);
  if (inspection.unsupportedUsers?.length || !inspection.profiles?.length)
    throw new Error('Every Android profile must be supported and explicitly included');
  if (inspection.deviceSerial !== device.canonicalSerial)
    throw new Error('Wireless inspection found a different physical phone');
  return inspection.profiles.map((/** @type {any} */ profile) => profile.profileId);
}
/** @param {any} session @param {Options} options */
async function returnToUsb(session, options) {
  await checkpoint(
    session,
    'All requested profile operations have finished. Safely eject the drive from the phone, reconnect the phone directly to this computer by USB, and disable Wireless debugging on the phone.\nConnect the USB drive to this computer and unlock/authorize the phone for USB inspection.' +
      (options['pair-endpoint']
        ? "\nForget/remove ONLY the paired host created for this session in the phone's Wireless debugging settings; retain unrelated paired hosts."
        : ''),
  );
  await jsonCommand(session, ['device', 'inspect', '--asset', session.asset, '--transport', 'usb']);
  await jsonCommand(session, [
    'seedvault',
    'disconnect',
    '--asset',
    session.asset,
    '--transport',
    'usb',
    '--endpoint',
    option(options, 'endpoint'),
    '--yes',
  ]);
}
/** @param {any} session @param {any} policy @param {boolean} refreshed */
async function finalizeSelf(session, policy, refreshed) {
  if (!refreshed)
    await reviewedOperation(
      session,
      ['device', 'provision', '--asset', session.asset, '--transport', 'usb'],
      'provision',
    );
  const report = await jsonCommand(session, [
    'device',
    'report',
    '--asset',
    session.asset,
    '--transport',
    'usb',
  ]);
  const checks = new Set([
    ...policy.requiredAttestations,
    'verified_boot',
    'normal_credentials',
    'app_setup',
    'duress',
    'recipient_acceptance',
    'operator_signoff',
    'routes',
    'network_failure_tests',
    'backup_recovery',
  ]);
  for (const check of report[0].missing) {
    if (!checks.has(check)) throw new Error('A measured readiness requirement remains: ' + check);
    await checkpoint(
      session,
      'Actually perform the required self-use check: ' +
        check +
        '.\nbackup_recovery requires an observed representative restore; a newly created backup alone does not satisfy it. Never activate destructive duress.',
    );
    await jsonCommand(session, [
      'device',
      'attest',
      '--asset',
      session.asset,
      '--check',
      check,
      '--operator',
      session.operator,
      '--yes',
    ]);
  }
  await jsonCommand(session, [
    'device',
    'finalize',
    '--asset',
    session.asset,
    '--operator',
    session.operator,
    '--locale',
    session.locale ?? 'en',
    '--yes',
  ]);
  await checkpoint(
    session,
    'Physically verify both USB and Wireless debugging are off. You are both the operator and recipient.',
  );
  await jsonCommand(session, [
    'handoff',
    'accept',
    '--asset',
    session.asset,
    '--recipient',
    session.operator,
    '--debugging-off',
    '--yes',
  ]);
}
/** @param {any} session @param {Options} options @param {any} policy @param {boolean} [refreshed] */
async function finishPhone(session, options, policy, refreshed = false) {
  if (options['finalize']) await finalizeSelf(session, policy, refreshed);
  else
    process.stdout.write(
      'After all PXV commands finish, physically turn off USB and Wireless debugging. Formal readiness/finalization was not claimed.\n',
    );
}
/** @param {any} session @param {Options} options */
export async function createPersonalMaster(session, options) {
  await requirePersonalRecovery(session.root);
  const usb = resolve(option(options, 'usb-root')),
    destination = resolve(option(options, 'backup-dir'));
  await distinctRoots([session.project, usb, destination]);
  await absent(destination);
  if (options['backup-only'])
    session.backupApproval = await requireBackupApproval(session.root, session.project);
  const initial = await createInputs(session, options);
  if (options['dry-run']) return printDryRun('create', session, options, initial.device);
  session.adapter = await qualifiedAdapter(option(options, 'seedvault-adapter'));
  const coverage = await readCoverage(
    option(options, 'coverage-file'),
    initial.policy.profiles.map((/** @type {any} */ profile) => profile.id),
  );
  if (!options['backup-only']) {
    await initialize(session, initial.policyFile, initial.source, initial.policy);
    await install(session, initial.device, true);
    await reviewedOperation(
      session,
      ['device', 'provision', '--asset', session.asset, '--transport', 'usb'],
      'provision',
    );
    await checkpoint(
      session,
      'Complete personal app/account/MFA setup in every profile, verify the intended layout, and retain required app-specific exports separately. Enter all secrets privately on the phone; review your coverage inventory before backing up.',
    );
  }
  const expected = await connectStorage(session, options, initial.device);
  const report = await seedvaultOperation(session, option(options, 'seedvault-adapter'), 'backup');
  await returnToUsb(session, options);
  if (!options['backup-only']) await finishPhone(session, options, initial.policy);
  const identity = await installedIdentity(session.root);
  await createMaster({
    project: session.project,
    usb,
    destination,
    report,
    expected,
    identity,
    coverage,
    adapter: session.adapter,
  });
  process.stdout.write(
    'Retained encrypted backup copy: ' +
      destination +
      '\nAll profile jobs completed and copied-file integrity verified. Generation correspondence is UNVERIFIED; restoration is UNTESTED; complete:false.\nKeep recovery words separately; retain older generations.\n',
  );
  if (options['backup-only'])
    process.stdout.write(
      'Physically turn off USB and Wireless debugging after this command. Backup-only did not claim renewed readiness.\n',
    );
}
/** @param {any} session @param {Options} options */
async function createInputs(session, options) {
  if (options['backup-only']) {
    const device = await enrolledDevice(session.project, session.asset);
    const { policy } = await projectSnapshot(session.project, device.canonicalSerial);
    if (options['codename'] && options['codename'] !== device.codename)
      throw new Error('--codename differs from reviewed OS policy');
    return { policy, device, source: '', policyFile: '' };
  }
  await absent(session.project);
  const policyFile = resolve(option(options, 'policy'));
  const source = resolve(option(options, 'source-root', dirname(policyFile)));
  await distinctRoots([source, session.project, option(options, 'usb-root'), option(options, 'backup-dir')]);
  const policy = await normalizedPolicy(await readJson(policyFile));
  const codenames = Object.keys(policy.osByCodename ?? {});
  if (!codenames.length) throw new Error('Provide a reviewed JSON policy with a pinned GrapheneOS release');
  const codename = option(options, 'codename', codenames.length === 1 ? codenames[0] : undefined);
  if (!(await selectedOsPolicy(policy, codename)))
    throw new Error('--codename differs from reviewed OS policy');
  await checkArtifacts(policy, source);
  const device = {
    canonicalSerial: option(options, 'serial'),
    model: option(options, 'model'),
    codename,
  };
  return { policy, device, source, policyFile };
}
/** @param {any} session @param {Options} options */
export async function recoverPersonalDevice(session, options) {
  await requirePersonalRecovery(session.root);
  const master = resolve(option(options, 'master')),
    usb = resolve(option(options, 'usb-root'));
  await distinctRoots([master, usb, session.project]);
  const { manifest, policy } = await verifyMaster(master);
  restoreSources(
    manifest,
    policy.profiles.map((/** @type {any} */ profile) => profile.id),
  );
  compatibleIdentity(manifest, await installedIdentity(session.root));
  const device = await recoveryDevice(session, options, manifest, policy);
  await absent(join(usb, '.SeedVaultAndroidBackup'));
  if (options['dry-run']) return printDryRun('recover', session, options, device);
  session.adapter = await qualifiedAdapter(option(options, 'seedvault-adapter'));
  if (options['same-device']) await noActiveRuns(session);
  await checkpoint(
    session,
    'This retained copy has verified file integrity, but its encrypted generation correspondence and restoration remain unverified.\nFor EACH source profile, confirm its recovery words, required app exports and account recovery material are available separately. Confirm you accept testing recovery from this copy. Never type the secrets here.',
    'READY',
  );
  await workingUsb(master, usb);
  if (options['same-device'])
    await jsonCommand(session, [
      'lifecycle',
      'maintenance',
      '--asset',
      session.asset,
      '--operator',
      session.operator,
      '--note',
      'Personal same-device recovery from retained master',
      '--yes',
    ]);
  else await initialize(session, join(master, 'project/policy.json'), join(master, 'project'), policy);
  await install(session, device, !options['same-device']);
  await reviewedOperation(
    session,
    ['device', 'create-users', '--asset', session.asset, '--transport', 'usb'],
    'provision',
  );
  const expected = await connectStorage(session, options, device);
  const sources = restoreSources(manifest, expected);
  const report = await seedvaultOperation(session, option(options, 'seedvault-adapter'), 'restore', sources);
  await validateRestoreReport(report, sources);
  await checkpoint(
    session,
    'In EACH restored profile, inspect representative private app data and files from this working copy, and review your coverage/exclusions inventory. App job completion alone cannot prove every app is recoverable.',
  );
  await recordRestoreCheck(session, master, report, sources, manifest.coverage);
  await returnToUsb(session, options);
  await reviewedOperation(
    session,
    ['device', 'provision', '--asset', session.asset, '--transport', 'usb'],
    'provision',
  );
  await finishPhone(session, options, policy, true);
  process.stdout.write(
    'Requested per-profile recovery and owner checks finished. The source copy was preserved; app exclusions still apply.\n',
  );
}
/** Refuse outstanding approvals rather than overwriting their evidence. @param {any} session */
async function noActiveRuns(session) {
  let cursor;
  const seen = new Set();
  do {
    const page = await jsonCommand(session, [
      'agent',
      'runs',
      '--limit',
      '1000',
      ...(cursor ? ['--cursor', cursor] : []),
    ]);
    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string'))
      throw new Error('Cannot prove the original project has no outstanding runs');
    for (const { value: run } of page.items) await assertInactiveRun(session, run);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Run history cursor did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
}
/** @param {any} session @param {any} run */
async function assertInactiveRun(session, run) {
  if (['queued', 'running'].includes(run.status) || (run.status === 'pending' && run.manualGate))
    throw new Error(
      'Original project has active run ' +
        run.id +
        '; explicitly cancel it and perform typed inspected recovery before erasing',
    );
  if (
    ['failed', 'needs-inspection', 'cancelled'].includes(run.status) &&
    !(await recoveredRun(session, run.id))
  )
    throw new Error('Inspect and recover original run ' + run.id + ' before erasing its Android users');
}
/** @param {any} session @param {string} id */
async function recoveredRun(session, id) {
  let cursor = 0;
  for (let page = 0; page < 64; page++) {
    const status = await jsonCommand(session, ['agent', 'status', '--run', id, '--after', String(cursor)]);
    if (status.events.some((/** @type {any} */ item) => item.event.type === 'recovered')) return true;
    if (status.events.length < 100) return false;
    const next = status.events.at(-1).sequence;
    if (next <= cursor) throw new Error('Run recovery event cursor did not advance');
    cursor = next;
  }
  return false;
}
/** @param {any} session @param {string} master @param {any} report @param {any[]} sources @param {any} coverage */
async function recordRestoreCheck(session, master, report, sources, coverage) {
  const file = join(session.project, 'state/personal-recovery', randomUUID() + '-restore-check.json');
  await privateJson(file, {
    format: 'pxv-personal-restore-check',
    masterManifestSha256: await fileHash(join(master, 'master.json')),
    runId: report.runId,
    sources,
    report,
    operator: session.operator,
    checkedAt: new Date().toISOString(),
    representativeDataChecked: true,
    allAppsRecoverable: false,
    coverage,
  });
  process.stdout.write('Private restore check recorded: ' + file + '\n');
}
/** @param {any} session @param {Options} options @param {any} manifest @param {any} policy */
async function recoveryDevice(session, options, manifest, policy) {
  const serial = option(options, 'serial'),
    model = option(options, 'model');
  if (options['codename'] && options['codename'] !== manifest.codename)
    throw new Error('--codename differs from selected master');
  if (!options['same-device']) {
    await absent(session.project);
    if (serial === manifest.seedvault.deviceSerial)
      throw new Error('Use --mode same-device with the retained original project for this phone');
    return { canonicalSerial: serial, model, codename: manifest.codename };
  }
  const device = await enrolledDevice(session.project, session.asset);
  assertOriginalDevice(device, serial, model, manifest);
  const snapshot = await projectSnapshot(session.project, device.canonicalSerial);
  if (snapshot.config.id !== manifest.sourceProjectId)
    throw new Error('Same-device recovery requires the original retained project identity and history');
  if (canonical(snapshot.policy) !== canonical(policy))
    throw new Error('Review and align the original project policy with this master before recovery');
  await checkArtifacts(policy, session.project);
  return device;
}
/** @param {any} device @param {string} serial @param {string} model @param {any} manifest */
function assertOriginalDevice(device, serial, model, manifest) {
  if (
    device.canonicalSerial !== serial ||
    serial !== manifest.seedvault.deviceSerial ||
    device.model !== model ||
    device.codename !== manifest.codename
  )
    throw new Error('Same-device recovery must retain the exact original enrollment');
}
/** @param {any} manifest @param {string[]} expected */
export function restoreSources(manifest, expected) {
  const profiles = manifest.seedvault?.profiles;
  if (
    !Array.isArray(profiles) ||
    canonical(profiles.map((profile) => profile.profileId).sort()) !== canonical([...expected].sort())
  )
    throw new Error('The master must cover every current target profile exactly once');
  return profiles.map((profile) => {
    if (
      !profile.source ||
      profile.source.profileId !== profile.profileId ||
      profile.source.token !== profile.token
    )
      throw new Error('Master lacks a reviewed per-profile Seedvault source selector');
    return profile.source;
  });
}
/** @param {string} mode @param {any} session @param {Options} options @param {any} device */
function printDryRun(mode, session, options, device) {
  const steps = options['backup-only']
    ? [
        'inspect existing profiles',
        'verified wireless connection',
        'backup every profile',
        'copy encrypted USB tree',
        'publish new private master',
      ]
    : [
        'verify all inputs',
        ...(mode === 'recover' ? ['copy master to a new working USB tree'] : []),
        'review exact OS plan',
        'erase/install/relock',
        'first boot and profile setup',
        'review per-profile Seedvault operation',
        'verify completion for every profile',
        ...(mode === 'recover'
          ? ['review fresh policy provisioning']
          : ['copy encrypted USB tree', 'publish new private master']),
      ];
  process.stdout.write(
    JSON.stringify(
      {
        dryRun: true,
        mode,
        project: session.project,
        asset: session.asset,
        device,
        steps,
        finalize: !!options['finalize'],
        mutationsPerformed: false,
      },
      null,
      2,
    ) + '\n',
  );
}
