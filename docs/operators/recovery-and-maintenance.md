# Backups, interrupted operations, and maintenance

Start here when a run requires inspection, a phone needs repair, or you are designing backup and restore coverage. Keep the exact asset, original operation ID, project, and host control directory. Consult [acceptance](acceptance.md) before claiming that recovery has been demonstrated.

## Inspect damaged assisted-recipe checkpoints

Missing or altered recipe checkpoints stop resume and review refresh before UI
replay. Preserve the original records, inspect the physical app state and run
events, and complete typed recovery for any retained obligations before preparing
new reviewed work. Do not recreate proof fields, delete records or repeat an
import to bypass inspection. A combined operation/disposal error reports both
failures; inspect the original operation failure as well as storage health.

Use this runbook for physical testing, live acceptance and recovery. For code development without a phone, use [developing and testing pxv](../developers/testing.md). Read the [verification boundaries](acceptance.md) before interpreting results. This document describes procedures; it does not record a completed test or qualify a device.

Here, **master device** is a recorded role: a protected reference phone, a primary phone containing real owner data, or both. Keep the role explicit because a reference can seed reviewed fleet configuration while a primary backup is private to its owner. A phone with both roles receives the primary-data protections; its full backup is not a fleet seed.

| Role                          | Purpose                                                          | Recovery approach                                                                                              |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Protected reference/master    | Retain an accepted OS, policy and app baseline for comparison    | Preserve the reference; rehearse a rebuild on a separate canary before changing it                             |
| Primary/master with real data | Carry the recipient's accounts, files and daily work             | Preserve the original and its data; verify owner-controlled recovery on an approved replacement where possible |
| Disposable canary             | Test a candidate with synthetic data and dedicated test accounts | May be reset or reinstalled only within the authorization for that exact phone and test                        |

The reusable reference is the reviewed policy, assets, configurations and exact software identities. A phone-data backup is reusable as a reference seed only when its source scope has been checked and contains approved sanitized or synthetic template data. Do not clone a master's project database, approvals, credentials or device identities into a canary. Provision each target through fresh enrollment and review. Restoring selected user data is a separate, explicitly agreed operation.

## What each kind of recovery does

| Task                           | Supported path                                                                            | What success establishes                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Interrupted pxv operation      | Inspect retained evidence, then `device recover` against the original operation           | Owned cleanup was checked and the applicable recovery reservation was released                     |
| Phone OS rebuild               | Reviewed `device install-os`, with authorized erasure and attended physical checks        | The reviewed OS installation completed; user data still needs its own recovery                     |
| Phone data restore             | The selected OS backup service and each app's supported export/import or account recovery | Only the data and behavior actually restored and checked                                           |
| Operator project/host recovery | Preserve current evidence and inspect a consistent private backup with a maintainer       | Historical state is available for reconciliation; old approvals do not establish current readiness |

In an explicitly Seedvault-enabled product, the typed `seedvault inspect|backup|restore` workflow and [personal recovery tooling](#personal-recovery-tool) supervise qualified exact-build Seedvault UI operations across profiles. Community disables new Seedvault operations, and no production adapter is currently qualified. Read [adapter acceptance and recovery limits](#qualified-adapter-format). PXV has no general phone cloning or project-state import command. A policy's `backup` requirement measures whether backup is enabled and which transport is selected. The `backup_recovery` check records a witnessed representative restore. Neither observation proves that every app, profile or future backup is recoverable. Android apps may use separate backup APIs and exclusions; see [Android Auto Backup](https://developer.android.com/identity/data/autobackup) and verify the exact app and transport before making a coverage claim.

For an identified master, use the existing CLI on one enrolled asset at a time. Keep the project, request, adapter evidence, backup destination and report in the access-controlled set for that role:

```sh
pxv seedvault inspect --project-root "$P" --asset "$ASSET" --transport usb
pxv seedvault backup --project-root "$P" --asset "$ASSET" --transport usb \
  --seedvault-adapter "$ADAPTER" --dry-run
# Review the exact profiles, app/build identity, adapter and destination on the phone.
pxv seedvault backup --project-root "$P" --asset "$ASSET" --transport usb \
  --seedvault-adapter "$ADAPTER"
pxv agent status --project-root "$P" --run "$RUN" --after 0
pxv seedvault report --project-root "$P" --run "$RUN"
```

`--dry-run` prepares a plan and does not execute it. The approved backup command prepares and displays a fresh plan, then requires explicit confirmation; `--yes` is only for an already reviewed execution process. Record its plan, operator approval, resulting run and per-profile report together. Restore also requires explicit source selectors in `REQUEST.json`; approve it only for the recorded owner and target. Do not reuse the primary owner's request, source token or output permissions for another person. If one handset has both roles, treat its full Seedvault set as primary-private. Build the sanitized reusable reference on a separate device or from separately verified synthetic template data, then store it with distinct access and retention rules.

## Prepare a canary visit

1. Identify the phone physically and record its role, asset alias, private serial/model/codename, custodian and allowed changes. Obtain explicit erasure authorization before a reset, factory installation or bootloader change. Disconnect unrelated phones where practical. Authorization for a canary never extends to a master phone.
2. Retain the candidate's source and artifact hashes, product identity, policy lock, exact extension versions/integrities, host tools and intended OS/app identities. Run the relevant [code and distribution checks](../developers/testing.md) first. An older physical acceptance record remains evidence for its recorded candidate.
3. Prepare a dedicated project outside the checkout and synthetic files, contacts, app records and test accounts. Give each profile distinct markers so an incorrect restore or cross-user leak is visible. Keep test credentials private. Do not import a primary phone's real backup into a shared development canary.
4. Use the normal per-operator host control root across native, preview, fork and Docker execution. A separate canary project provides data isolation; a different control root must not bypass an existing device reservation. Only one workstation may control the phone at a time.
5. Arrange physical attendance for unlocking, authorization prompts, normal credentials, language checks and final debugging shutdown. Keep Wireless debugging off unless the particular test explicitly requires it. Never test destructive duress activation.

The examples use an installed `pxv` command. A source checkout can use `pnpm pxv` after `pnpm build`; use the actual unique launcher for an immutable preview. Set placeholders deliberately:

```sh
P='/absolute/private/path/to/canary-project'
POLICY='/absolute/path/to/reviewed-canary-policy.json'
ASSET='canary-01'
SERIAL='REPLACE_WITH_OBSERVED_CANARY_SERIAL'
OPERATOR='Test operator'
```

For a new project only, initialize and enroll the observed Pixel 8a. Choose the actual model/codename for another supported target. A starter pack needs deployment-specific review; it is not automatically a qualified policy.

```sh
pxv host doctor
pxv host adb-start --yes
pxv project init --path "$P" --policy "$POLICY"
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial "$SERIAL" --model 'Pixel 8a' --codename akita --yes
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P" --yes
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
pxv guide project --project-root "$P" --kind pixel --locale en
pxv device plan --project-root "$P" --asset "$ASSET" --transport usb
```

Stop on any identity mismatch, unknown reservation, missing artifact or unexpected device state. Select one exact asset, not a fleet. `device inspect` reads live observations; `device report` reports stored readiness and is not a new inspection. Use the selected policy's generated checks rather than assuming a fixed number of profiles.

## Run the canary workflow

1. Review target identity, measured state, authenticated OS/APK artifacts, required settings and APK effects across all Android users. Retain the exact reviewed plan. Use the [operator guide](../../guides/source/markdown/operator-en.md) or the supported equivalent MCP route; a CLI-only run does not test MCP.
2. If this visit includes an authorized OS installation, use the reviewed installer below. Attend the unlock/relock and first-boot checkpoints. Factory flashing and bootloader unlock/relock erase data. Check verified boot and leave OEM unlocking off after installation, following the [official GrapheneOS procedure](https://grapheneos.org/install/cli). Fastboot needs direct USB; host-ADB Docker mode cannot flash.

```sh
# Destructive: run only for the identified phone with explicit erasure approval.
pxv device install-os --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
```

3. Provision the reviewed profiles and applications. Reconnect/authorize USB debugging privately when needed. Read each manual checkpoint; finish ordinary app setup, then normal credentials, language and optional duress configuration in the required order. Attest only the check actually completed, then resume that pending run. Do not enter credentials in commands or notes.
4. Reboot and unlock each intended profile. Check distinct synthetic markers, private storage, app behavior and required permissions/settings. Check English and Polish on the exact supported builds. Confirm a profile's content is not visible to the other profiles.
5. Check expected routes and failure/reconnection in representative apps. A scoped network probe covers its helper UID and reviewed endpoints; it cannot certify all app traffic. Inspect helper removal, private temporary-file cleanup and parent resource lifetime.
6. Perform the backup/restore drill below. Exercise permission-drift rejection and interruption/recovery only in the explicitly designed disposable test. Do not interrupt flashing to manufacture a failure case. Record pass, fail or pending for each promised capability.
7. Obtain fresh required attestations, finalize and physically check USB and Wireless debugging are off. Confirm OEM unlocking remains off after installation. Record recipient acceptance and custody separately. Export EN/PL handoff documents when applicable. Follow the [operator guide](../../guides/source/markdown/operator-en.md); a successful request to disable debugging does not prove the physical toggle state.

A pending manual check is not a failure to hide, and a completed provisioning run is not completed custody. A canary result does not qualify another policy, OS/app build, phone or recipient's data. GrapheneOS emulator provenance and physical-device acceptance remain separate requirements.

## Retain live acceptance separately

Record the actual candidate/product/policy and artifact identities, host tools,
transport, OS fingerprint, app versions/signers, measured stable users and the
result of each promised capability. A CLI walkthrough does not test MCP, and an
OCI tool/lease smoke test does not test live Docker USB or host-ADB provisioning.
Retain those as separate outcomes when they are advertised.

GrapheneOS emulator provenance must bind the actual image source/path/hash,
fingerprint and required capabilities through the supported evidence schema. A
stock Google APIs image or a free-text note cannot supply it. Keep emulator and
physical results distinct. Exact-build English/Polish recipient walkthroughs,
actual-app VPN/failure behavior and representative restores remain necessary for
the corresponding claims. Use the private record template at the end of this
runbook and preserve failed/pending results, not only successes.

## Prepare and verify phone backups

Agree the maximum acceptable data loss and recovery time with the owner. Back up before planned changes, after important data changes and on a reviewed schedule. Keep an encrypted copy outside the phone and a second independently accessible copy where the agreed threat model requires it. The person restoring must be able to access the repository when the original phone and its MFA are unavailable. Keep recovery keys in the owner's separate approved storage; record only who holds them and that access was verified.

Build a coverage inventory for **each profile and data category**, not just for the phone:

| Record           | Required detail                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Source identity  | Private asset/profile identity, OS build, app package/version/signer and backup implementation/version                         |
| Data covered     | Files, app records, contacts or other explicit categories; size/count or synthetic content hashes where useful                 |
| Method           | OS backup transport, app-supported encrypted export or independently recoverable account data                                  |
| Destination      | Private repository alias, backup timestamp/version and verified independent copy                                               |
| Dependencies     | Required app version, credentials, owner-held recovery material, network/service access and restore order                      |
| Exclusions       | Unsupported apps/profiles/data, hardware-bound credentials, MFA, passkeys, eSIM and any item needing a separate recovery route |
| Restore evidence | Target alias/build, actual steps, compared content and behavior, result and retained evidence reference                        |

GrapheneOS includes Seedvault, which must be explicitly enabled. Check the selected build's actual backup UI and each profile's availability rather than assuming owner backup covers secondary users. See the [GrapheneOS backup description](https://grapheneos.org/faq#non-hardware-identifiers).

Seedvault honors apps' backup exclusions; newly installed but unopened or force-stopped apps can be excluded. Its repository includes the hidden `.SeedVaultAndroidBackup` directory. Preserve the complete chosen repository, including hidden content, and verify that the intended independent copy contains it. Consult the [Seedvault FAQ](https://github.com/seedvault-app/seedvault/wiki/FAQ) for the tested version's behavior.

A successful backup indicator can coexist with an unusable restore. Hardware-backed app keys can be unavailable after restoration, and some settings or permissions need reconfiguration. Use each sensitive app's supported recovery/export path and verify its data opens; do not assume restored login state or hardware credentials are usable. These limitations are described in [Seedvault's known issues](https://github.com/seedvault-app/seedvault/wiki/Known-Issues).

Do not unlock a master's bootloader, root it or delete an app/profile to extract or test a backup. If no supported recovery method exists, record that gap and preserve the original. An encrypted partition image or copied project database is not a demonstrated phone-data restore.

## Perform a representative restore drill

Start with synthetic data on the canary. Rehearse the **same method and versions** proposed for the protected phone; a different app's successful restore does not establish coverage.

1. Create distinguishable data in every in-scope profile: known file bytes plus representative app records and settings. Record expected results without credentials. Open the apps and verify their source data before backing up.
2. Run the configured backup or app export using its supported UI. Check timestamps, exclusions, repository availability and completeness. Copy/replicate through the approved method and verify independent access. Keep a retained generation so a subsequent empty backup cannot replace the only useful copy.
3. Restore on an approved clean disposable target/profile, or rebuild this canary only after preserving pxv evidence and resolving its outstanding obligations. A fresh empty phone/profile is a new measured baseline: make a new review; never resume a pre-reset run against it.
4. Follow the tested OS/app restore order. Check the exact Seedvault build's supported restore UI instead of assuming restoration is restricted to initial setup. Do not initialize a new backup destination or key over the retained source while preparing restoration. See the [Seedvault restore instructions](https://github.com/seedvault-app/seedvault/wiki/FAQ#how-to-restore-after-passing-through-setup-wizard).
5. Enter recovery material privately. Restore each required category, check the expected profile, compare file bytes/counts and open the app's actual records. Check attachments, offline content and app functions that depend on recovered data. An installed app icon or a success notification is insufficient.
6. Re-check user isolation, required permissions/settings, VPN/routing, reboot persistence and helper removal. Coordinate service/account changes: a restored session may affect another device. List missing data or unavailable recovery dependencies explicitly.
7. Record elapsed time, backup age/data loss, tested categories and gaps. Compare them with the agreed recovery objective. Retain sanitized results and private evidence separately. Repeat after meaningful OS/app/backup-method changes.

If the current policy requires `backup_recovery` and its representative restore has actually been observed, record it against the current device and plan:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check backup_recovery --operator "$OPERATOR" --yes
```

This attestation does not import another phone's acceptance. Complete the current policy's other checks and fresh finalization/handoff. Never copy the receipt into a master project or claim full coverage from the representative subset.

## Recover each device role

### Disposable canary

Inspect an interrupted operation and resolve owned cleanup before resetting or reusing the phone. Preserve the failed test's evidence. If the test authorizes a rebuild, confirm the exact serial and reinstall only the reviewed authenticated image. After a reset, enroll a replacement under its actual new physical identity; if reusing the same phone, retain its existing history and create fresh plans/observations for the changed user identities. Do not rewrite old obligations to match newly created users.

Recreate the synthetic fixture from the reviewed policy and repeat the failed scenario. A clean reinstall can restore a usable test fixture, but it does not prove the original interruption cleaned up correctly. Keep that scenario failed or pending until its own evidence resolves it.

### Protected reference/master

Record the accepted reference's OS/app/policy identities and preserve its project evidence and supported backups before a planned visit. Identify which configuration and resources are the intended seed. Review the backup scope before marking any phone data reusable; remove private or real-owner content from the seed source or use a separate synthetic reference device. Reproduce the intended change and a rebuild from the baseline policy on a canary first. Compare profiles, measured settings, app identities and recipient-visible behavior; do not use the master's old approvals to approve the canary.

If the reference itself needs recovery, start with evidence inspection and non-destructive diagnosis. A rebuild requires separate authorization for that phone and any data it holds. Retain the old baseline as history and make a new accepted reference record after recovery. Do not assume an older OS image can be installed: rollback protection constrains downgrades; use the current [GrapheneOS installation guidance](https://grapheneos.org/install/cli#verifying-installation).

### Primary/master containing real data

1. Preserve the original phone and private backup generations. Label the set with the owner's identity and restrict it to the owner and named recovery operators. Agree the affected data, owner availability, private recovery material, account/MFA dependencies and acceptable loss before changing it. If suspected compromised, lost or stolen, coordinate the owner's account/session response and loss record before reconnecting or restoring; backup recovery alone does not contain an incident.
2. Prefer an approved replacement for recovery where feasible. Create its own project/enrollment using its observed physical identity, provision the approved software and restore through the owner's supported methods. Use the exact restore request and source set for that owner only. Keep the original untouched until the owner has verified the recovered data, essential functions and recovery access.
3. Restore real data only in the approved private environment with the owner. A disposable lab canary must not become a general repository of primary-phone backups. A synthetic drill validates the method; actual recovery still needs the owner's private content checks.
4. If the only option is erasing the original, obtain explicit authorization for that device after explaining the known restore gaps. Verify an independently accessible backup and required keys first. If recovery cannot be demonstrated, preserve the phone and escalate rather than interpreting OS reinstall as data recovery.
5. After restoration, make fresh policy observations, attestations and handoff evidence. Reconfirm credentials privately and review old sessions/ADB authorizations through their supported controls. Keep USB/Wireless debugging off at final custody. Retire or erase the previous device only through the agreed owner-authorized process; a pxv retirement record does not perform a wipe.

If the phone is physically unusable, do not promise extraction of encrypted data or recovery of unknown credentials. Follow the device/OS and application providers' supported recovery paths. Missing recovery material and missing backups must remain explicit limitations.

## Recover an interrupted pxv operation

Use the original project, engine/extension bytes and shared host control directory. Keep the original operation ID and native receipts. Closing a terminal is not proof that a detached worker stopped. A cancellation request is not proof that cleanup finished or a device mutation was undone.

Recovery must select the original transport kind **and enrolled endpoint**, because reservations bind both device and transport identities. These canary examples began on USB. For another visit, use its retained `wifi` or `emulator` selector and unchanged endpoint instead. If that endpoint is unavailable, preserve the fence and obtain a reviewed recovery procedure; switching to USB is not a way to release a Wi-Fi reservation.

```sh
RECOVERY_TRANSPORT='usb' # Original transport for this canary visit.
pxv agent runs --project-root "$P"
pxv agent status --project-root "$P" --run "$RUN" --after 0
pxv device recover --project-root "$P" --asset "$ASSET" --transport "$RECOVERY_TRANSPORT"
```

Set `RUN` from the actual retained run record. The last command, without `--inspected`, lists reservations and instructions and intentionally returns exit code **4**; it performs no typed cleanup. The host reservation listing may include other projects. A finalization or native failure can have an operation ID outside the agent run list: use its retained error/receipt, not a guessed latest run.

| Observed condition                                    | Next action                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending explicit manual checkpoint                    | Complete that named task, attest it truthfully and resume the same approved run while its review remains valid                                                               |
| Review expired during an otherwise valid manual pause | `agent refresh --run RUN_ID`, inspect its new plan and exact decoded `reviewSummary`, then approve with `agent execute`; refresh is preparation, not approval                |
| Failed/interrupted worker or uncertain cleanup        | Preserve evidence; inspect device and native ownership; perform inspected recovery before making a new plan                                                                  |
| Policy, inventory, configuration or engine changed    | Reload the intended project, validate/lock it and obtain a new review; expiry refresh does not approve changed configuration                                                 |
| Android user removed/recreated with the same ID/name  | Preserve the unresolved obligation; the replacement user's serial is different and must not receive the old cleanup                                                          |
| Live native owner or escaped descendant               | Stop only the identified owned work through supported cancellation; inspect receipts and reservations; a host reboot may be required to prove process cleanup                |
| OS does not boot or installation was interrupted      | Preserve installation logs, stop automated replay and inspect the actual bootloader/OS state with the official installation guidance before any separately authorized repair |

When cancellation is appropriate, request it for the identified run:

```sh
pxv agent cancel --project-root "$P" --run "$RUN"
```

After physically inspecting the phone and retained ownership evidence and completing any required manual cleanup, use the **original affected operation ID**:

```sh
ORIGINAL_OPERATION_ID='REPLACE_WITH_RETAINED_OPERATION_ID'
pxv device recover --project-root "$P" --asset "$ASSET" --transport "$RECOVERY_TRANSPORT" \
  --run "$ORIGINAL_OPERATION_ID" --inspected --yes
```

The `--inspected` assertion is an operator confirmation, not a bypass. Recovery attempts typed cleanup for that operation, validates stable user identities and keeps unresolved obligations fenced. Children cannot resolve parent or sibling resources; already resolved obligations are not replayed. If recovery fails, retain its new evidence and retry through the same original recovery lineage after addressing the cause.

Never remove a database, lock, reservation or receipt, change control roots, invent an inventory identity or restore an older database to make a blocked device appear available. A host reboot does not automatically resolve device obligations. Recovery does not replay provisioning, undo accounts/APK effects or restore phone data. After successful cleanup of a failed/interrupted run, inspect again and prepare a fresh review for the remaining work.

## Recover incomplete finalization

`finalization-inspection` means PXV retained a `debugging-shutdown` intent but did not commit the handoff. Shutdown may already have disabled debugging. The intent, previous observations and audit evidence remain available; neither a successful physical shutdown nor typed cleanup creates a missing handoff receipt.

This blocks preparation, submission, refresh, execution/resume, attestation and new
extension, Seedvault and collector work, even after executable/policy/configuration
changes or lock renewal. Reports retain the blocker alongside unavailable readiness
for an older baseline. Inspection, history, cancellation, typed recovery, disconnect
and offline records remain accessible. New provisioning cannot overwrite the intent.

1. Inspect the phone's actual USB/Wireless debugging state and retained error, shutdown intent, audit records and native reservations. Do not repeat finalization or claim custody.
2. Complete any required inspected typed recovery using the original affected operation ID and transport, as above. Preserve reservations and receipts until cleanup is proven.
3. Arrange a deliberate maintenance visit with the recipient. Temporarily authorize debugging through the agreed physical procedure if needed, and record `lifecycle maintenance` with the actual asset, operator and non-secret note. This archives and invalidates the incomplete operational evidence.
4. Validate and explicitly renew the policy lock if its baseline changed. Prepare, review and execute a new provisioning plan, complete current checks and fresh acceptance, then finalize and confirm physical shutdown and custody separately.

Do not edit SQLite, restore older records or clear the intent/control directory to bypass inspection. A storage/worker/JSON decoding error needs investigation of the operator store; it is not a request to repeat phone provisioning. A successful existing handoff continues to use its original validated snapshot, including full prepared-plan integrity, for custody after later baseline changes.

## Review policy app changes during maintenance

Preserve the accepted policy, project evidence and agreed phone-data backups before
a planned change. Choose the command by the intended operation:

- `policy resolve-apps` fills missing pins and verifies all supplied pins against
  declared direct/local APKs or authenticated repositories.
- `policy update-apps` upgrades eligible apps from repositories already trusted by
  the policy, preserving the existing APK signer and preventing downgrades.

After identifying the enrolled maintenance target and starting its owned ADB
service, preview and review the repository update:

```sh
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
```

Discovery refreshes repositories and verifies downloads; it does not update the
phone. Use explicit `--sdk`/`--abi` for the intended Android release when no phone
is connected. Review every `skipped` result. Publisher/local apps without a trusted
repository mapping require their own release review. If a mutable direct URL now
serves different bytes, resolution fails against the existing pins; retain the
accepted baseline and review the new release and signer before preparing a revised
draft. Do not discard a pin merely to make a verification error disappear.

Both commands preserve catalog IDs and references, leave the current lock untouched,
and protect concurrent file edits. Inspect the reported `policyLockRequired`,
review recipe/build bindings, qualify the change on a canary, then prepare a fresh
plan for each affected phone. Repeat required app, VPN, backup and acceptance
checks after actual deployment; the host discovery report is not device evidence.
See [source resolution and app updates](policy-reference.md#choose-the-policy-command).

## Back up operator projects and host evidence

Phone backups and pxv project backups protect different data. A policy file alone cannot recover a project journal, and a project backup contains no general copy of the phone's app data.

Use an approved encrypted backup destination outside the checkout and build outputs. Keep credentials and recipient recovery values out of public archives, reports and handoff documents. The private backup inventory should cover:

| Material                   | Location/handling                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete project           | `pxv.project.json`, policy/configuration, inventory, lock, `state/pxv.sqlite3`, existing WAL/SHM sidecars and immutable `state/plans/` artifacts; preserve the whole private project tree                                    |
| Referenced private inputs  | Approved recipe/import files, artifacts and keys stored outside the project; record original paths and permissions separately                                                                                                |
| Helper signing identity    | Existing project helper builds under `android/`, including any `.keystore` and `signing-password` files; retain privately when needed to reproduce the accepted signer                                                       |
| Host control evidence      | `PXV_CONTROL_ROOT`, otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/pxv-host-control`; includes shared reservations and native completion evidence                                                                          |
| Installed extensions       | `PXV_EXTENSION_ROOT`, otherwise `${XDG_DATA_HOME:-$HOME/.local/share}/pxv/extensions`; retain the exact installed compiled bytes and integrity pins for offline recovery                                                     |
| Runtime and trust material | Accepted engine candidate, source/lock/toolchain identity, authenticated artifacts and their signer/trust metadata                                                                                                           |
| Operator authentication    | Host ADB keys from the configured key location, or Docker's `<control-root>/adb-home/.android`; retain only through approved encrypted secret storage. Keep registry credentials in the operator's separate credential store |

For a consistent **cold backup**:

1. Finish or safely stop the relevant visits. Identify all CLI/MCP processes, detached workers and containers writing these projects/control files, including other projects sharing the host control root. Inspect unresolved ownership instead of force-killing arbitrary processes.
2. Arrange a quiescent maintenance window and close all database clients/writers cleanly. Keep them stopped throughout the copy. If writers cannot be quiesced, do not describe an ordinary directory copy as a consistent backup; obtain a reviewed snapshot procedure.
3. Copy the complete private project and agreed external material, preserving hidden files, access controls and the files present in each consistent set. Keep any remaining database WAL/SHM sidecars with their database. SQLite documents that the [WAL is persistent database state](https://sqlite.org/wal.html#the_wal_file); copying only a live `.sqlite3` file can lose committed transactions. Do not manually delete sidecars to simplify a backup.
4. Record backup time, source paths, candidate identity, hashes and unresolved operations privately. Verify the encrypted destination can be unlocked independently and its contents can be read; store recovery access separately. Retain an older generation and a separately accessible copy according to the recovery objective.
5. Exercise restoration of a **synthetic project backup** in an offline staging location. Inspect integrity, journal/snapshot availability and expected history without launching device-changing commands. Preserve the backup copy unchanged and record the result before relying on the method for real project data.

No pxv command currently creates or restores this backup. Artifact/private-input paths can be absolute, so arbitrary project relocation is not a supported state migration. Document the original layout and retain the compatible engine for inspection.

### Lost or corrupt operator state

Preserve the damaged project and current host control/native evidence before attempting repair. Stage a verified cold backup in a private location for offline, maintainer-assisted inspection. Reconcile its age and missing history with the current phone, native receipts and current reservations. Do not execute old pending runs or approvals from the backup.

Never overwrite current shared control state with a historical snapshot: historical locks/process identities are not current ownership evidence. Creating a new empty control directory is also not proof that earlier work ended. A backup restore at the original path requires a controlled compatibility/reconciliation procedure; this release has no automatic state importer. If obligation history is missing, stop mutations and resolve that uncertainty explicitly.

A replacement phone needs its own physical identity and fresh enrollment, review and acceptance. Keep the old device's unresolved records attached to the old identity. Do not rename a replacement to clear the old device's fence. Rebuild from reviewed configuration only after the prior device's situation has been accounted for; fresh project creation must not bypass recovery of the same phone.

## Retain a useful test/recovery record

Keep the detailed record privately and publish only a sanitized summary. Use a separate result per capability:

```text
Visit ID and date:
Device role: protected reference / primary with real data / disposable canary
Private asset/serial/profile identity reference:
Custodian, operator and scope of authorization (including erasure, if any):
Engine candidate/source/artifact hashes; product/policy lock; extension integrities:
Host/transport, OS build/fingerprint and app versions/signers:
Backup generation/method/destination alias; recovery-material custodian verified:
Data categories and restore target; expected vs observed content/behavior:
Reboot, isolation, permissions, routing/failure and helper-cleanup results:
Recovery operation IDs, unresolved obligations and native evidence references:
EN/PL walkthrough, debugging shutdown and recipient/custody result:
Result per capability: pass / fail / pending / out of scope, with reason
Backup age, measured data loss and recovery duration vs agreed objectives:
Private evidence location/digest; remaining gaps and next approved action:
```

Exclude passwords, recovery words, MFA seeds, raw account identifiers and private document contents. Hashes or a backup-enabled observation are not substitutes for the recorded restore comparison. Preserve historical acceptance records unchanged and attach new evidence to the newly tested candidate.

External backup and installation links are reference material. Verify UI labels, app behavior and restore compatibility on the exact builds selected for each visit; the links do not qualify those builds.

Host SDK/JDK and ADB selection follows [host dependencies](host-setup.md#environment-selection). Export the same reviewed `PXV_HOST_ADB_HOST`/`PXV_HOST_ADB_PORT`, `PXV_ADB_SERVER_SOCKET` and `PXV_ADB_VENDOR_KEYS` settings used for the owned service before inspecting recovery state. pxv does not load `.env` automatically; native ADB variable names do not select a recovery endpoint. An invalid explicit tool override or selected helper SDK/JDK home fails without selecting a lower-priority home; host executable search sources are documented separately.

## Optional Seedvault automation

This is an optional experimental recovery module. Community disables new recovery
operations through `features.seedvault: false`; a reviewed recovery-enabled product
can opt in. Historical reports, connection listing/disconnection and inspected cleanup
remain available. Ordinary provisioning does not construct the recovery services.
The personal tool checks the effective resource-root product before creating projects, copying backups or invoking device commands, including dry-runs. Disabled products refuse early; help remains available.

The [personal recovery tool](#personal-recovery-tool) coordinates one person's phone and all persistent full Android users. Run it from the matching source checkout. It uses reviewed PXV installation/provisioning, temporary TLS wireless ADB while a USB drive occupies the phone's port, and supervised Seedvault UI operations. It supports rebuilding the original phone with its existing project or enrolling a replacement in a fresh project.

**No production Seedvault UI adapter is qualified or shipped.** The runtime requires external exact-build qualification before it can measure an automated backup or restore. Offline fixtures test the safeguards; they do not establish GrapheneOS, app, file or physical-device acceptance. Use the schemas and qualification procedure below with at least two disposable profiles before relying on an adapter for personal data.

## Commands and review

These commands require host execution, an explicitly enrolled Pixel and the original shared host control directory. Every command except `report` requires an explicit `--asset ID`; `--all` and `--group` are rejected before project state is opened. Start ADB explicitly through the ordinary host workflow. First enroll using direct USB, then verify its TLS endpoint:

```sh
pxv seedvault connect --project-root "$P" --asset "$ASSET" \
  --serial "$SERIAL" --endpoint PHONE_IP:CONNECT_PORT \
  --pair-endpoint PHONE_IP:PAIR_PORT
pxv seedvault inspect --project-root "$P" --asset "$ASSET" --transport wifi
pxv seedvault backup --project-root "$P" --asset "$ASSET" --transport wifi \
  --seedvault-adapter /private/reviewed/adapter.json --dry-run
```

Pairing is optional when this host is already paired. PXV requires the endpoint to be advertised as an ADB TLS pairing/connect service, then measures the connected phone's canonical physical serial, model and codename. Pairing codes are read interactively through private command input; they are never command-line arguments or manifest fields. A changed port requires a new verified connection, rather than an inventory edit that assumes the endpoint's identity.

`inspect` reports full-user identities, backup transport configuration, foreground/unlock state and unsupported user types. Preparation reconciles this inventory with the policy and refuses omitted, ambiguous or renamed profiles. An operation binds every profile's Android `userId + serialNo`, the physical phone, endpoint, OS fingerprint, Seedvault version and signing certificate. Numeric user IDs from a master are source metadata, never target-user creation instructions.

`backup` and `restore` prepare an immutable review. `--dry-run` prepares and stores this review but performs no device mutation. The **personal recovery tool's** `--dry-run` is stricter: it only reads inputs and prints phases, without preparing plans, creating files or contacting a phone. To execute a retained review, save the decoded `reviewSummary` bytes exactly and use the normal `agent execute --plan ID --review-file FILE --operator NAME` workflow. Readiness, signoff and backup-recovery attestations remain separate.

A restore request uses `--file REQUEST.json` and contains `operation: "restore"`, the qualified `adapter`, and `sources`. Every source supplies its policy `profileId`, public hexadecimal application restore token, and exact resource-ID/text selectors for the application restore set (`selector`) and file snapshot (`filesSelector`). Missing or duplicate mappings are rejected before execution. `--seedvault-adapter FILE` can supply the adapter separately; its acceptance path resolves relative to that file. The personal tool validates the request and qualification evidence before erasure and retains the reviewed definition for the session.

Runs expose the existing durable agent status/events and a per-profile report:

```sh
pxv seedvault report --project-root "$P" --run "$RUN"
pxv agent status --project-root "$P" --run "$RUN" --after 0
pxv agent resume --project-root "$P" --run "$RUN" --yes
```

Profiles run sequentially. PXV switches to the selected full user, pauses for private unlocking, verifies foreground identity and opens `com.android.settings.BACKUP_SETTINGS`. Recognized public Seedvault screens use resource selectors and measured postconditions. Recovery words, lock screens, biometrics, secure windows, external storage consent and unknown screens remain private checkpoints. Do not attest a Seedvault checkpoint as an unrelated provisioning check. If the review expires, resolve remote-work obligations before `agent refresh`; the new review preserves completed profile evidence and requires new approval.

## Personal recovery tool

The canonical source entry point is [tools/personal-recovery.mjs](../../tools/personal-recovery.mjs).
Use the pinned Node runtime and matching reviewed checkout/build. Invoke `node`
through its reviewed executable path when it is not on `PATH`; `PXV_BIN` selects
one built PXV executable. `create --help` and
`recover --help` list the accepted flags. There are no shell wrapper prerequisites.

With an explicitly recovery-enabled product and a qualified adapter, create a new
personal phone/master generation:

```sh
node tools/personal-recovery.mjs create \
  --project-root /private/phone/project --policy /private/reviewed/policy.json \
  --files-root /private/reviewed --asset personal-phone --serial PIXEL_SERIAL \
  --model 'Pixel 8a' --operator 'My name' --usb-root /media/me/BACKUP \
  --backup-dir /private/masters/generation-01 --endpoint 192.0.2.10:37123 \
  --seedvault-adapter /private/reviewed/seedvault-adapter.json \
  --coverage-file /private/reviewed/coverage.json
```

The new-phone flow erases the selected phone. `create --backup-only` instead uses
existing enrollment and never flashes, provisions or finalizes; it still requires
a new backup destination, endpoint, adapter and coverage file. Optional
`--pair-endpoint HOST:PORT` obtains a pairing code interactively. Use an already
mounted drive and trusted local network. Each exact dry-run review is displayed and
submitted only after explicit confirmation; interruption retains inspectable state
and never automatically repeats flashing.

Backup-only preflight, including `--dry-run`, requires a current authentic policy
lock before connecting or pairing. Missing, corrupt or stale approval requires
`policy validate` and explicit `policy lock` renewal, including after executable
upgrades. The tool never renews existing approval or changes lock bytes on rejection.

All new `seedvault connect` calls require current approval, including connection
dry runs. PXV checks before the pairing-code prompt and again under project ownership
before pairing/connecting. Backup-only work also rechecks after the physical checkpoint;
a changed baseline requires restarting the workflow even if its new lock is approved.
Disconnect and exact-session cleanup remain available without lock renewal.

The required private coverage file includes every policy profile and its important
apps, file scope and exclusions. An owner-only example is:

```json
{
  "schemaVersion": 1,
  "profiles": [{
    "profileId": "owner",
    "apps": [{ "packageId": "org.example.app", "status": "unknown" }],
    "files": "Selected documents and photos; inspect after restore",
    "exclusions": ["Service activation and hardware-backed keys need separate recovery"]
  }]
}
```

App statuses are `seedvault`, `exported`, `excluded` or `unknown`. This is the owner's
coverage inventory, not measured universal app recoverability. Keep recovery words,
account/MFA recovery and required exports separately accessible.

Recover from a retained master into the same phone or an approved replacement:

```sh
node tools/personal-recovery.mjs recover \
  --master-dir /private/masters/generation-01 --project-root /private/phone/project \
  --mode same-device --asset personal-phone --serial PIXEL_SERIAL --model 'Pixel 8a' \
  --operator 'My name' --usb-root /media/me/WORKING_BACKUP \
  --endpoint 192.0.2.10:37123 --seedvault-adapter /private/reviewed/seedvault-adapter.json
```

`same-device` requires the original project identity, enrollment/history and matching
physical serial/policy; it archives prior readiness through maintenance. Resolve
active/uninspected work before erasure. `replacement` requires a new project path
and the replacement's observed identity, with the source master's codename. Numeric
source Android user IDs are never adopted as target identities. Both paths verify
retained hashes and exact profile sources, copy to a new working backup tree and
leave the retained source unchanged. They require acknowledging unverified encrypted
generation correspondence before erasure and private representative content checks
after restore. Fresh provisioning rechecks the policy; drift/downgrade requests stop.

Every destination must be new. Failed copies retain incomplete state rather than
publishing a complete master. The tool does not copy project SQLite state, previous
approvals, inventory, registry credentials, recovery words or helper signing keys.
It refuses installed extensions and staged-file recipes; those need separately
reviewed installation/private inputs. Back up operator projects and the encrypted
registry separately as described in [recovery](#back-up-operator-projects-and-host-evidence).

Fresh creation finalizes only with `--finalize`; recovery finalizes by default unless
`--no-finalize` is explicit. `--locale en|pl` selects finalization language. Finalization
still requires real current checks, physical debugging-off confirmation and separate
self-acceptance. A backup does not establish `backup_recovery`; witness a representative
restore. Without finalization, disable debugging physically and make no custody claim.

## Qualified adapter format

The authoritative [contracts](../../packages/contracts/src/seedvault.ts) validate JSON definitions strictly. An adapter contains:

| Field | Required evidence or behavior |
| --- | --- |
| `schemaVersion`, `id` | Version 1 and the reviewed adapter identity. |
| `buildFingerprint`, `package` | Exact Android fingerprint and Seedvault package ID, positive version code and SHA-256 signer. |
| `acceptance` | Path and SHA-256 of the private acceptance document. |
| `activities` | Reviewed public Seedvault activities; secure or unrecognized windows pause. |
| `backup`, `restore` | Ordered selectors/actions and separate app/file/finalization/idle/generation postconditions. |
| `restoreSourceResourceId`, `restoreFileSourceResourceId` | Resource IDs of the exact public application-set and file-snapshot generation labels. |

Selectors require resource IDs. Backup includes an explicit `start-backup` trigger. Restore uses `select-source` before `start-restore`, followed by `select-file-source` and `start-files-restore`. Both flows must then observe a fresh `observe-files-running` checkpoint and persist that cursor before accepting file completion. A stale completed screen cannot establish a new operation. An interrupted, uncommitted trigger is retained for inspection rather than automatically replayed. Completion requires the exact selected application and file generation labels (`generation` and `fileGeneration`), a durable application restore token, app/file/finalization postconditions and measured quiescence; a shell exit code or notification is insufficient.

The acceptance document binds the adapter ID, fingerprint, package identity and `recipeDigest` (PXV's canonical SHA-256 digest of the adapter excluding `acceptance`). It records `testedAt`, a passing result and at least two distinct policy profile IDs and Android user serial numbers. Each profile must have retained evidence hashes and passing APK, app-data and file backup/restore, finalization and durable-generation checks. Hash validation binds the supplied record to the recipe; the record must truthfully describe an actual witnessed test. It is not a remote certification service.

To qualify a recipe:

1. Prepare at least two disposable full profiles with distinguishable app records, APK identities and known file bytes. Retain the exact OS/app/host identities and the reviewed selectors.
2. Perform complete Seedvault backups through its normal UI. Exercise separate application and file jobs, finalization, exclusions and USB destination selection. Retain the whole encrypted repository through the same USB-to-host copy used in recovery.
3. Restore from a working copy into fresh target users. Select each exact source token, restore APKs/application data and selected file snapshots, compare file bytes, open representative app records and verify isolation and reboot behavior.
4. Exercise locked/recreated users, reconnection, wrong sets, partial jobs, misleading `bmgr` output, stale completion screens, interrupted remote work and cleanup. Verify scheduling is quiescent before unplugging storage. Retain failure/pending outcomes as such.
5. Only after successful live results, retain the private acceptance record, hash it, and bind it into the reviewed adapter. Requalify after changing the recipe, fingerprint, version or signer.

## Interrupted jobs and connection cleanup

Worker failures preserve newer run progress and completed statuses. An unchanged
queued/manual run may receive an audited inspection status; launch cleanup releases
only its exact attempt claim. Retain the original and any secondary storage/disposal
errors, inspect run history and native fences, and use explicit recovery where needed.

Recipe/probe blockers may identify incomplete results, missing execution checkpoints
or source/refresh lineage that cannot be authenticated. Assisted recipe completion
also requires its consumed app-setup witness in audit history. Preserve these records
and prepare newly reviewed work after inspection; do not edit proofs to claim success.

ADB loss is not proof that an Android job stopped. Durable obligations retain the operation's Android job and previous foreground user. Cleanup checks the exact user, public idle state, mutating services and that user's registered Seedvault jobs before restoring the previous foreground. Unknown scheduling output or queued work remains pending. Scheduled periodic backups may need to be disabled privately through supported UI before the drive can safely move. PXV never force-stops Seedvault to manufacture completion.

Use ordinary inspected `device recover` for a backup/restore run, retaining its original project, operation ID and transport. Preserve unknown or reused-user obligations. A failed wireless connection has a separate socket-session record, including attempts that failed before inventory enrollment:

```sh
pxv seedvault connections --project-root "$P" --asset "$ASSET"
# After inspecting the exact connection attempt and native reservation:
pxv seedvault disconnect --project-root "$P" --asset "$ASSET" \
  --endpoint PHONE_IP:CONNECT_PORT --run "$CONNECTION_OPERATION_ID" --inspected
```

This cleanup selects the recorded endpoint and native recovery lineage; it disconnects only that host socket and can be retried after a failed cleanup. It does not restart a remote backup, kill the ADB server, revoke unrelated hosts or remove phone-side pairing trust. Remove this session's newly paired host privately and turn Wireless debugging off. Reconnect direct USB for finalization, then physically verify both debugging modes are off. The same person supplies operator and recipient acceptance.

Connection reports traverse the full retained history without a 1,000-record ceiling.
Exact-session recovery reads its record directly; an enrolled endpoint needs no
history scan to authorize disconnect. Prior matching sessions are reconciled with
their audit events before the initiating session loses its cleanup requirement.
Storage/audit errors or competing writes retain that requirement for explicit retry;
partial reconciliation preserves unrelated records and deletes no history.

## What a master establishes

The personal tool copies the entire host-mounted encrypted `.SeedVaultAndroidBackup` tree, including hidden/binary files, to a new private generation and verifies copied hashes. It retains policy, pinned local dependencies, per-profile identities/tokens and an explicit owner coverage/exclusion inventory. It leaves earlier generations and the recovery source unchanged. It does not copy secondary-user data through raw `/sdcard`: ADB storage remains in user 0's context after a user switch. See [AOSP's multi-user ADB behavior](https://source.android.com/docs/devices/admin/multi-user-testing#adb-interactions-across-users).

Copy integrity cannot prove that a directory contains the report's encrypted generation. Seedvault v2 names app snapshots using a hash of encrypted bytes; its restore token is inside the encrypted snapshot. See [Seedvault's snapshot implementation](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/java/com/stevesoltys/seedvault/repo/SnapshotManager.kt). The master therefore records `copyIntegrityVerified: true`, `allProfileJobsCompleted: true`, `generationCorrespondence: "unverified"`, `restoration: "untested"` and `complete: false`. A wrong or old drive cannot receive a complete-recovery claim merely because it is nonempty. Recovery requires acknowledging this distinction before erasure and produces a separate private representative-restore record after the exact selected sources and owner content checks succeed.

Application completion does not enumerate all exclusions or establish every app's recoverability. Per-profile evidence explicitly marks representative UI coverage and owner verification requirements. The private coverage inventory records Seedvault-covered, exported, excluded and unknown apps plus file scope and exclusions. Keep app exports, account/MFA recovery and Seedvault recovery words independently accessible; the personal tool asks only whether that material is available, never for its value.

Normal Seedvault UI is used because file and application backups are separate operations and `bmgr backupnow` has special finalization behavior. Scoped `bmgr --user ID` inspection parses semantic results, transport and restore sets; shell success alone is insufficient. See [Seedvault's app backup implementation](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/java/com/stevesoltys/seedvault/repo/AppBackupManager.kt) and [protected component declarations](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/AndroidManifest.xml). These upstream references explain the implementation boundary; they do not qualify a live build.
