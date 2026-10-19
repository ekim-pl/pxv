# Canary testing, backups and device recovery

Use this runbook for physical testing, live acceptance and recovery. For code development without a phone, use [developing and testing pxv](TESTING.md). Read the [verification boundaries](VERIFICATION.md) before interpreting results. This document describes procedures; it does not record a completed test or qualify a device.

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

In an explicitly Seedvault-enabled product, the typed `seedvault inspect|backup|restore` workflow and [personal recovery tooling](SEEDVAULT_AUTOMATION.md#personal-recovery-tool) supervise qualified exact-build Seedvault UI operations across profiles. Community disables new Seedvault operations, and no production adapter is currently qualified. Read [adapter acceptance and recovery limits](SEEDVAULT_AUTOMATION.md). PXV has no general phone cloning or project-state import command. A policy's `backup` requirement measures whether backup is enabled and which transport is selected. The `backup_recovery` check records a witnessed representative restore. Neither observation proves that every app, profile or future backup is recoverable. Android apps may use separate backup APIs and exclusions; see [Android Auto Backup](https://developer.android.com/identity/data/autobackup) and verify the exact app and transport before making a coverage claim.

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
2. Retain the candidate's source and artifact hashes, product identity, policy lock, exact extension versions/integrities, host tools and intended OS/app identities. Run the relevant [code and distribution checks](TESTING.md) first. An older physical acceptance record remains evidence for its recorded candidate.
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

1. Review target identity, measured state, authenticated OS/APK artifacts, required settings and APK effects across all Android users. Retain the exact reviewed plan. Use the [operator guide](../guides/source/markdown/operator-en.md) or the supported equivalent MCP route; a CLI-only run does not test MCP.
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
7. Obtain fresh required attestations, finalize and physically check USB and Wireless debugging are off. Confirm OEM unlocking remains off after installation. Record recipient acceptance and custody separately. Export EN/PL handoff documents when applicable. Follow the [operator guide](../guides/source/markdown/operator-en.md); a successful request to disable debugging does not prove the physical toggle state.

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

Host SDK/JDK and ADB selection follows [host dependencies](HOST_DEPENDENCIES.md#environment-selection). Export the same reviewed `PXV_HOST_ADB_HOST`/`PXV_HOST_ADB_PORT`, `PXV_ADB_SERVER_SOCKET` and `PXV_ADB_VENDOR_KEYS` settings used for the owned service before inspecting recovery state. pxv does not load `.env` automatically; native ADB variable names do not select a recovery endpoint. An invalid explicit tool override or selected helper SDK/JDK home fails without selecting a lower-priority home; host executable search sources are documented separately.
