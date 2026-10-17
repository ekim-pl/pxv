# Personal Seedvault recovery automation

This is an optional experimental recovery module. Community disables new recovery
operations through `features.seedvault: false`; a reviewed recovery-enabled product
can opt in. Historical reports, connection listing/disconnection and inspected cleanup
remain available. Ordinary provisioning does not construct the recovery services.

The [personal recovery tool](#personal-recovery-tool) coordinates one person's phone and all persistent full Android users. Run it from the matching source checkout. It uses reviewed PXV installation/provisioning, temporary TLS wireless ADB while a USB drive occupies the phone's port, and supervised Seedvault UI operations. It supports rebuilding the original phone with its existing project or enrolling a replacement in a fresh project.

**No production Seedvault UI adapter is qualified or shipped by this change.** The runtime requires external exact-build qualification before it can measure an automated backup or restore. Offline fixtures test the safeguards; they do not establish GrapheneOS, app, file or physical-device acceptance. Use the schemas and qualification procedure below with at least two disposable profiles before relying on an adapter for personal data.

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

The canonical source entry point is [tools/personal-recovery.mjs](../tools/personal-recovery.mjs).
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
registry separately as described in [recovery](CANARY_BACKUP_RECOVERY.md).

Fresh creation finalizes only with `--finalize`; recovery finalizes by default unless
`--no-finalize` is explicit. `--locale en|pl` selects finalization language. Finalization
still requires real current checks, physical debugging-off confirmation and separate
self-acceptance. A backup does not establish `backup_recovery`; witness a representative
restore. Without finalization, disable debugging physically and make no custody claim.

## Qualified adapter format

The authoritative [contracts](../packages/contracts/src/seedvault.ts) validate JSON/YAML definitions strictly. An adapter contains:

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

ADB loss is not proof that an Android job stopped. Durable obligations retain the operation's Android job and previous foreground user. Cleanup checks the exact user, public idle state, mutating services and that user's registered Seedvault jobs before restoring the previous foreground. Unknown scheduling output or queued work remains pending. Scheduled periodic backups may need to be disabled privately through supported UI before the drive can safely move. PXV never force-stops Seedvault to manufacture completion.

Use ordinary inspected `device recover` for a backup/restore run, retaining its original project, operation ID and transport. Preserve unknown or reused-user obligations. A failed wireless connection has a separate socket-session record, including attempts that failed before inventory enrollment:

```sh
pxv seedvault connections --project-root "$P" --asset "$ASSET"
# After inspecting the exact connection attempt and native reservation:
pxv seedvault disconnect --project-root "$P" --asset "$ASSET" \
  --endpoint PHONE_IP:CONNECT_PORT --run "$CONNECTION_OPERATION_ID" --inspected
```

This cleanup selects the recorded endpoint and native recovery lineage; it disconnects only that host socket and can be retried after a failed cleanup. It does not restart a remote backup, kill the ADB server, revoke unrelated hosts or remove phone-side pairing trust. Remove this session's newly paired host privately and turn Wireless debugging off. Reconnect direct USB for finalization, then physically verify both debugging modes are off. The same person supplies operator and recipient acceptance.

## What a master establishes

The personal tool copies the entire host-mounted encrypted `.SeedVaultAndroidBackup` tree, including hidden/binary files, to a new private generation and verifies copied hashes. It retains policy, pinned local dependencies, per-profile identities/tokens and an explicit owner coverage/exclusion inventory. It leaves earlier generations and the recovery source unchanged. It does not copy secondary-user data through raw `/sdcard`: ADB storage remains in user 0's context after a user switch. See [AOSP's multi-user ADB behavior](https://source.android.com/docs/devices/admin/multi-user-testing#adb-interactions-across-users).

Copy integrity cannot prove that a directory contains the report's encrypted generation. Seedvault v2 names app snapshots using a hash of encrypted bytes; its restore token is inside the encrypted snapshot. See [Seedvault's snapshot implementation](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/java/com/stevesoltys/seedvault/repo/SnapshotManager.kt). The master therefore records `copyIntegrityVerified: true`, `allProfileJobsCompleted: true`, `generationCorrespondence: "unverified"`, `restoration: "untested"` and `complete: false`. A wrong or old drive cannot receive a complete-recovery claim merely because it is nonempty. Recovery requires acknowledging this distinction before erasure and produces a separate private representative-restore record after the exact selected sources and owner content checks succeed.

Application completion does not enumerate all exclusions or establish every app's recoverability. Per-profile evidence explicitly marks representative UI coverage and owner verification requirements. The private coverage inventory records Seedvault-covered, exported, excluded and unknown apps plus file scope and exclusions. Keep app exports, account/MFA recovery and Seedvault recovery words independently accessible; the personal tool asks only whether that material is available, never for its value.

Normal Seedvault UI is used because file and application backups are separate operations and `bmgr backupnow` has special finalization behavior. Scoped `bmgr --user ID` inspection parses semantic results, transport and restore sets; shell success alone is insufficient. See [Seedvault's app backup implementation](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/java/com/stevesoltys/seedvault/repo/AppBackupManager.kt) and [protected component declarations](https://github.com/GrapheneOS/platform_packages_apps_Seedvault/blob/7cfffed7ceeda60a10bf2a6d9818d6fda81828ba/app/src/main/AndroidManifest.xml). These upstream references explain the implementation boundary; they do not qualify a live build.
