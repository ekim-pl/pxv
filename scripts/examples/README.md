# Personal GrapheneOS master and recovery

These two interactive Bash examples serve one person using an owner profile and any reviewed secondary profiles. They use the existing PXV installation/provisioning workflows and the supervised Seedvault workflow for **every profile**. Passwords, device unlocks, recovery words, USB permissions and physical bootloader confirmations remain on the phone. An exact-build, reviewed Seedvault adapter is required for measured automated app **and** file backup/restore; a missing or unsupported adapter cannot produce a measured backup job.

The [adapter and acceptance schemas](../../packages/contracts/src/seedvault.ts) define the external JSON: an adapter pins the Android build and Seedvault package identity, allowed activities, resource-ID selectors, separate backup/restore steps, completion selectors, and an acceptance-file digest. Backup must start a fresh job and observe its file job running. Restore explicitly selects and starts both the app source and the separate file snapshot before observing fresh file work; both final generation labels are checked. The acceptance document binds the recipe digest (adapter excluding `acceptance`) and records dated passing app/APK/file backup, restore and durable-generation results for at least two distinct stable profiles. Keep recorded acceptance evidence beside the adapter; relative `acceptance.path` is resolved against that adapter file. The retained copy includes a portable adapter and its hashed acceptance proof, while its evidence retains the original adapter digest. The repository does not fabricate a passing production adapter. `--help` and `--dry-run` remain available without live acceptance.

Build PXV and its native supervisor first. Run with the repository's pinned Node version (`.node-version`). `PXV_NODE` can select that executable; `PXV_BIN` can select one PXV executable path. `--owner NAME` aliases `--operator NAME` for self-use, and creation accepts `--master-dir` as an alias for its new `--backup-dir`. The helper uses this checkout's product resources. It checks the exact product and executable identity before recovering a master, so retain the reviewed PXV checkout/build with your backups.

Use an already mounted USB drive, a trusted local network for wireless ADB, and separate private project/master directories. The phone uses its USB port for the drive during Seedvault operations; PXV verifies wireless ADB against its canonical physical serial. Pairing codes are entered only at PXV's interactive pairing prompt. Phone unlocks and wireless-debugging toggles are explicit physical checkpoints. The examples never run mutating ADB commands outside PXV supervision.

## Create a personal device and its master

Start with a reviewed **JSON** policy containing the exact GrapheneOS codename, signed release and trust key, desired profile names, APK pins and required checks. Resolve the localized owner name before provisioning. Local APK paths are relative to `--files-root` (the policy's directory by default).

```sh
scripts/examples/01-create-personal-master.sh \
  --project-root /private/phone/project \
  --policy /private/reviewed/policy.json --files-root /private/reviewed \
  --asset personal-phone --serial PIXEL_SERIAL --model 'Pixel 8a' \
  --operator 'My name' --usb-root /media/me/BACKUP \
  --backup-dir /private/masters/2026-10-16 \
  --endpoint 192.0.2.10:37123 --pair-endpoint 192.0.2.10:41234 \
  --seedvault-adapter /private/reviewed/seedvault-adapter.json \
  --coverage-file /private/reviewed/coverage.json
```

The installation erases the selected phone. Each machine-readable dry-run review is saved privately, displayed exactly, and submitted with its original bytes only after `EXECUTE`. The helper observes the exact returned run, handles manual checkpoints and refreshed reviews, and preserves failed/interrupted state for inspection. It never automatically repeats flashing.

After personal setup and per-profile Seedvault completion, reconnect the drive to the computer when prompted. The helper streams the entire encrypted `.SeedVaultAndroidBackup` tree, including hidden files, into a new private generation. It also records reusable policy, local APK/probe dependencies, exact product/build identity and the durable per-profile Seedvault source selectors. Remote APK/repository references retain their pins and still require network access when recovering.

Existing personal phones can refresh their master without flashing, enrolling or provisioning:

```sh
scripts/examples/01-create-personal-master.sh \
  --backup-only --project-root /private/phone/project --asset personal-phone \
  --operator 'My name' --usb-root /media/me/BACKUP \
  --backup-dir /private/masters/2026-11-01 \
  --endpoint 192.0.2.10:37123 \
  --seedvault-adapter /private/reviewed/seedvault-adapter.json \
  --coverage-file /private/reviewed/coverage.json
```

Both creation modes require an explicit private coverage inventory. List every policy profile, important apps, separately exported data, known exclusions and file coverage; do not include credentials or recovery words. App statuses are your inventory, rather than measured guarantees. For example, an owner-only inventory is:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "profileId": "owner",
      "apps": [{ "packageId": "org.example.app", "status": "unknown" }],
      "files": "Documents and photos selected in Seedvault; inspect after restore",
      "exclusions": ["Hardware-backed keys and service activation need separate recovery"]
    }
  ]
}
```

Supported app statuses are `seedvault`, `exported`, `excluded` and `unknown`. Add an entry for every actual policy profile. The manifest always records `allAppsRecoverable:false` and retains this inventory beside the measured job evidence.

Each destination must be new; existing generations are never overwritten. A copy failure leaves a sibling `.incomplete-*` directory with an incomplete marker or unpublished manifest. A retained generation is published only after all requested profiles have completed app/file backup-job evidence and all copied files have matching digests. Its manifest remains `complete:false`, with `copyIntegrityVerified:true`, `allProfileJobsCompleted:true`, `generationCorrespondence:"unverified"` and `restoration:"untested"`. Modern Seedvault snapshot tokens are encrypted inside hashed snapshot files, so the host cannot establish that the mounted drive contains the reported generations. A wrong or old nonempty drive must never become a verified master merely because copying succeeded. Back up to external storage: a copy retained solely on the phone will be erased during installation.

## Recover the same phone or a replacement

Keep the master drive attached to the computer initially. Recovery verifies the retained-copy manifest, every policy-profile source and file digest and copies it to a **new working** `.SeedVaultAndroidBackup` tree on the USB drive before asking you to attach that drive to the phone. Use a drive without an existing Seedvault tree; the source copy is never changed. Before erasure, acknowledge its unverified encrypted generation correspondence and confirm separate recovery words and required exports for every source profile. After the requested-token restores, inspect representative app data/files in each profile; the private recovery-project check record links those observations to the source manifest digest without asserting universal app recovery.

```sh
scripts/examples/02-recover-personal-device.sh \
  --master-dir /private/masters/2026-11-01 \
  --project-root /private/phone/project --mode same-device --asset personal-phone \
  --serial PIXEL_SERIAL --model 'Pixel 8a' --operator 'My name' \
  --usb-root /media/me/WORKING_BACKUP --endpoint 192.0.2.10:37123 \
  --seedvault-adapter /private/reviewed/seedvault-adapter.json
```

`--mode same-device` retains the original project UUID, enrollment and history, records maintenance to archive/invalidate prior readiness, and requires the exact original physical serial, source-project identity and matching reviewed policy. Queued/running/manual-pending work must be explicitly cancelled and inspected before erasure; unresolved failure history needs a recorded recovery. Outstanding device fences still require inspected recovery; changing project directories cannot bypass them.

For a replacement, pass `--mode replacement`, supply its serial/model, and choose a nonexistent `--project-root`. PXV creates fresh project identity, enrollment, database and evidence. The replacement must have the same codename as the selected master; optional `--codename` must match it. Fresh target Android users are mapped by policy profile ID; backed-up Android numeric user IDs are never adopted as target identities. Following restore, a fresh reviewed provisioning pass checks the policy again. Unexpected app-version drift or downgrade requests stop for review. `--master` and `--source-root` remain aliases for the canonical `--master-dir` and `--files-root` flags.

## Checks and boundaries

Both scripts support `--help` and `--dry-run`. The latter only reads/validates inputs and prints the planned phases; it does not create directories, initialize projects, prepare PXV plans or contact a phone.

Fresh creation offers optional `--finalize`; recovery finalizes by default, with explicit `--no-finalize` to opt out. Backup-only never provisions or finalizes. `--locale en|pl` selects finalization language. It obtains fresh provisioning observations, asks you to perform each real required check, disables debugging through PXV, then records self-acceptance after physical toggle checks. `backup_recovery` requires an actual representative restore; creating a backup does not establish that check. When finalization is omitted, turn USB and Wireless debugging off physically after the final command. No readiness/custody completion is claimed.

Masters do not clone SQLite databases, reviewed plans, inventory, credentials, recovery phrases, signing keys or per-device private recipe inputs. These examples refuse installed extensions and staged-file recipes: prepare their exact trusted installation and fresh private inputs separately before extending the workflow. App opt-outs, hardware-backed keys and service/account activation can limit what Seedvault restores; completion means the selected supported backup operations finished, not a block-level phone clone. Keep recovery words separately and retain older backup generations.
