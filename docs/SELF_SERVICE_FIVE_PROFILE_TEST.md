# Five-profile self-service acceptance test

This is a complete test procedure for **one person acting as operator and recipient**,
with one exact physical Pixel and five Android profiles. It prepares a test; it does
not record a pass. Use your own name for both roles and complete their confirmations
separately. Follow the [self-managed guide](SELF_MANAGED_PHONE.md) for background and
[verification boundaries](VERIFICATION.md) when interpreting evidence.

The starter is [single-nerd](../policy-packs/single-nerd/policy.json).
It contains no app pins, OS pins, VPN configuration, credentials or destructive
duress defaults. Schema validity alone is insufficient for the full test. Complete
the private configuration gate below before phone-changing commands.

## 1. Scope, authorization and pass criteria (F00)

Use a disposable owned canary and synthetic data first. Preserve primary-phone data,
account access and independent recovery material. Creating profiles changes the
phone; OS installation erases data. Flash only an exact separately authorized target
through the [installation procedure](SELF_MANAGED_PHONE.md#3-install-grapheneos-only-when-needed).
Do not deliberately interrupt flashing or erase a primary phone to test restoration.

A single person can operate several test devices. A full backup/restore result needs
an authorized clean restore target; if none is available, keep that result **pending**
and preserve the original. Offline tests do not replace it. Community's experimental
Seedvault automation and trusted extensions remain disabled.

For full acceptance, every mandatory result below must pass, all five profile rows
must be complete, cleanup must be proven and final custody must be recorded. A
failure or pending mandatory result prevents a full pass. Mark optional/out-of-scope
work with a reason; never use that status to waive a required policy check. The test
does not activate duress or notification-triggered wiping.

## 2. Freeze the executable and open a private test record (F01)

Use Linux x86_64 on supported Debian 12 or Ubuntu 24.04 with Node 24.22.0, pnpm
12.11.2 and the [host prerequisites](HOST_DEPENDENCIES.md). These examples use a
**source checkout**, including its test templates and guide renderer. Run from that
checkout in Bash; keep the same shell and its variables throughout:

```sh
S=$(pwd -P)
pnpm install --frozen-lockfile
pnpm build
node --version
pnpm --version
git rev-parse HEAD
git status --short
pxv() {
  PXV_RESOURCE_ROOT="$S" PXV_SUPERVISOR="$S/packages/runtime/dist/supervisor.js" \
    node "$S/packages/cli/dist/main.js" "$@"
}
pxv version
pxv host doctor
```

Resolve required doctor failures before device work. Retain a fresh source-bound
`PXV_REQUIRE_CRYPTO=1 pnpm quality` result for this revision. Freeze source, builds,
product and policy for the visit; edits require a fresh lock/review and matching
quality evidence. Keep the same shared host control root as other installations;
do not create a new control domain to avoid an existing reservation.

Create a **new** directory outside the checkout. The result sheet is private once
filled, even though its blank source is public:

```sh
umask 077
TEST_ROOT="$HOME/pxv-private/single-nerd-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TEST_ROOT"
chmod 700 "$TEST_ROOT"
P="$TEST_ROOT/project"
POLICY="$TEST_ROOT/policy.json"
ASSET='self-test-phone'
OPERATOR='REPLACE WITH YOUR NAME'
cp "$S/policy-packs/single-nerd/policy.json" "$POLICY"
cp "$S/tests/acceptance/single-nerd-results.md" "$TEST_ROOT/results.md"
chmod 600 "$POLICY" "$TEST_ROOT/results.md"
```

Record the source revision, quality source digest and actual tool versions. Do not
copy filled results, private policies, serials, credentials or screenshots into Git.

## 3. Complete the private configuration gate (F02)

Use an editor to complete `$POLICY` before initialization. Keep secrets in private
phone entry or approved private stores, never in policy values or shell arguments.

| Policy ID | Initial display name | Purpose to review | Initial locale |
| --- | --- | --- | --- |
| owner | Owner | Administration and independent recovery access | en-US |
| contacts | contacts | Chosen personal/contact apps and data | pl-PL |
| google | google | Explicitly selected Google-dependent apps, if any | pl-PL |
| testing | testing | Synthetic test apps/data and controlled experiments | pl-PL |
| onion | onion | Explicitly selected privacy/routing apps | pl-PL |

Match Owner's display name to the observed Android user zero. Review all secondary
names and their existing users; never remove an existing profile to make the layout
fit. Names do not configure services, anonymity or network routes.

Before the full run, fill the private results matrix with:

- The exact Pixel model/codename, approved GrapheneOS release and authenticated OS
  pin. Even when skipping installation, pinned OS verification must pass. Follow
  [policy format](POLICY_FORMAT.md); do not invent hashes, keys or signatures.
- Review the starter's [pinned app catalog and assignments](../policy-packs/README.md#five-profile-apps),
  including Rethink DNS in all five profiles, Oblivion in owner, Session/Telegram/Signal
  in contacts, Aurora Store in google and Orbot in onion. Confirm the exact versions,
  content and signer digests and trusted sources, and record any private changes or
  intentional absences. Rethink's supplied APK requires arm64-v8a; replace its pin
  for x86_64 emulator work. An empty catalog qualifies only a profile-layout rehearsal,
  not verified app deployment.
- Explicit per-profile settings, permissions, account/import checkpoints and network
  expectations. Pin supported recipes where available; the standard CLI otherwise
  uses assisted checkpoints. Explain every permission and shared-package effect.
- VPN package/configuration, always-on and lockdown settings where required, plus
  actual-app route/failure tests. See [network evidence](NETWORK_POLICIES.md). An
  onion name or a helper's egress result cannot establish all-app Tor routing.
- Each profile/app's backup method, supported categories, exclusions, independent
  recovery access, restore target and expected synthetic data. Keep the required
  `backup_recovery` check pending until a representative restore is demonstrated.
- Five privately chosen ordinary screen locks and final languages. This starter
  has no credential-default files and no duress action; do not copy destructive
  defaults from fleet-nerd merely to satisfy a checklist.

Leave `routes`, `network_failure_tests`, `backup_recovery`, `recipient_acceptance`
and `operator_signoff` required. Ordinary credentials and physical verified boot
are also required by the engine. Do not remove checks to turn an incomplete visit
into a pass. A deliberately reduced rehearsal must be labeled as such.

Initialize the new project only after reviewing the private policy:

```sh
pxv project init --path "$P" --policy "$POLICY"
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale en
pxv guide project --project-root "$P" --kind pixel --locale pl
```

Initialization copies the policy to `$P/policy.yaml`; `$POLICY` is not a live link.
After initialization, edit the project policy identified by `pxv.project.json`,
validate/lock again and obtain a new plan. Do not edit configuration during execution.

## 4. Enroll and verify the exact target (F03)

Keep unrelated phones disconnected where practical. Compare the physical asset,
serial, model and codename. Temporarily enable USB debugging and authorize your
workstation on the phone. Doctor does not start ADB; do so explicitly:

```sh
pxv host adb-start --yes
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial OBSERVED_SERIAL --model 'ACTUAL PIXEL MODEL' --codename ACTUAL_CODENAME
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
```

Replace all identity placeholders with observed values, privately. Record existing
Android users by numeric ID **and serial number**, names, OS build/fingerprint,
bootloader/verified-boot state and the selected USB endpoint. Resolve discrepancies
before planning. Enrollment does not authorize erasure.

If OS installation is required, perform the separately reviewed phase from the
[self-managed installation guide](SELF_MANAGED_PHONE.md#3-install-grapheneos-only-when-needed).
Record its own plan/run IDs, attend unlock/relock prompts, complete the setup pause
and reconfirm identity with inspection. Do not flash again to advance a pause.
If already on the intended verified build, record installation as not needed;
OS verification remains mandatory.

## 5. Review and execute provisioning (F04)

```sh
pxv device provision --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Review the exact target, profile mapping, authenticated artifacts, global package
changes, settings/permissions, manual gates and expiry. Expect Owner plus exactly
four intended secondary profiles, not five new secondary users. Stop on unapproved
extra profiles, identity conflicts, unexpected destructive actions or absent pins.

Then request an interactive, newly prepared review and confirm only after reading it:

```sh
pxv device provision --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
RUN='REPLACE WITH THE RETURNED PROVISIONING RUN ID'
pxv agent status --project-root "$P" --run "$RUN" --after 0
```

The dry-run plan is not automatically the executed plan. Save both IDs and the
review actually approved. For exact saved-plan submission use the private
`reviewSummary`/`--review-file` procedure in [automation](AUTOMATION.md#prepare-review-and-execute).
Native-host workers are detached: terminal exit does not prove completion. Read
status and new event cursors. Exit 4 means pending work, 3 means failure/inspection,
and 130 means cancellation; do not wrap phone operations in an unattended retry loop.

## 6. Complete the named private gates (F05)

Follow the **actual** `pauseReason` and instructions, one checkpoint at a time:

1. Finish account sign-ins, imports, MFA and Android consent privately in each
   intended profile. Establish required VPN account/configuration before lockdown.
2. Set or verify ordinary locks for all five profiles. Lock and unlock each with its
   own ordinary credential; retain recovery access outside this phone.
3. At the requested `normal_credentials` gate, record the checks actually performed:

   ```sh
   pxv device attest --project-root "$P" --asset "$ASSET" \
     --check normal_credentials --operator "$OPERATOR"
   pxv agent resume --project-root "$P" --run "$RUN"
   ```

4. Set and verify the language in each profile at its `language:PROFILE` pause,
   then resume. Do not invent a language attestation. Owner is initially English;
   the four secondary profiles are initially Polish, unless you reviewed changes.
5. At an `app_setup` gate, complete that specific profile/action's setup, then:

   ```sh
   pxv device attest --project-root "$P" --asset "$ASSET" \
     --check app_setup --operator "$OPERATOR"
   pxv agent resume --project-root "$P" --run "$RUN"
   ```

   Another profile's receipt is insufficient.

Read status after every resume. Never attest a check just because its name appears
here. If a review expires at a valid manual pause, use `agent refresh`, inspect its
new exact review and submit the replacement plan; refresh does not itself approve
execution. Failed or uncertain mutations require inspected recovery instead.

Duress is outside this starter's scope. Never test a destructive unlock credential
or send a notification-wipe key. If the run asks for an unexpected destructive gate,
stop and inspect the actual policy/review instead of accepting it.

## 7. Perform all five profile walkthroughs (F06-F08)

Complete one row per profile in the private results sheet. Check **actual state**,
not only installed icons, a stored report or a successful command:

- Match the intended name, Android user ID and stable serial. Check ordinary unlock,
  locale, each app's version/signer and intended account, needed permissions and
  settings. Perform a harmless real app action using synthetic data.
- Put distinguishable synthetic data in each in-scope app/profile. Switch profiles
  and confirm other profiles cannot access it through normal unapproved paths.
  Document intentional sharing. Shared package versions do not imply shared data.
- Check every profile's expected route using representative actual apps. Where
  declared, verify always-on/lockdown. A probe covers only its own UID and endpoints.
  Use an agreed safe VPN failure method with the underlying network still available;
  confirm required traffic blocks, then restores. Do not disable lockdown to make
  the test easier. If no safe failure method is available, keep the check pending.
- Test expected Wi-Fi/mobile transitions where applicable and record exclusions.
  A VPN or Tor label is not evidence of anonymity or complete traffic coverage.
- Reboot normally. Unlock Owner first, revisit all four secondary profiles and
  repeat essential locks, language, app/account, setting and routing checks. Verify
  end-session behavior on the installed build without deleting profiles.

After testing, restore the reviewed intended state. Collect fresh inspection and
readiness output while debugging is still authorized. Do not change app builds or
policy merely to hide a failure; that requires a new reviewed visit.

## 8. Demonstrate backup and restore (F09)

Follow the [representative restore drill](CANARY_BACKUP_RECOVERY.md#perform-a-representative-restore-drill)
with the same methods/builds intended for this phone. Back up each declared profile
scope; Owner's backup does not imply coverage for other profiles. Use known file
bytes/counts and actual synthetic app records, attachments and settings.

Restore on an authorized clean target, compare the expected data and open the apps.
Record target identity privately, backup generation/age, elapsed recovery time,
missing categories and independent access to required keys/accounts/MFA. Recheck
profile separation, permissions and routing. The target has its own enrollment and
fresh review; do not copy another device's receipts or resume a pre-reset run.

Never erase the primary phone or delete its Testing profile to manufacture a restore
result. Without a suitable target, retain backups and mark this mandatory result
pending. A copied archive, enabled backup switch or success notification is not a
restore pass. Keep operator project/control backups separate from phone-data backups.

## 9. Optional encrypted record and private insert (F10)

If using retention, follow the strict input formats and revision rules in
[phone registry](PHONE_REGISTRY.md). Enter values in an owned `0600` file inside
an owned `0700` directory outside the checkout. Do not put values in this results
sheet. Start a new registry only in this new test project:

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file "$TEST_ROOT/phone-record.json" --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Create `phone-record.json` privately using the registry reference, with the actual
five stable profile bindings. Revision zero is only for the first record. Confirm
ordinary output contains metadata without secret values, revisions remain encrypted,
and history is retained. `current` means last operator-confirmed, not live proof.

Before final signoff/debugging shutdown, optionally run `device collect-oblivion`,
`device collect-sessionid` and `device collect-simcards` with the same project/asset.
Follow [the collector procedure](PHONE_REGISTRY.md#opt-in-pre-handoff-collection):
check mixed app presence, private fallback entry, SIM numbers at device level,
explicit retention despite `--yes`, and foreground restoration. Absent/skipped
values retain their previous fields; collection with no values preserves ciphertext.
Each successful invocation merges captured fields while retaining encrypted history.

An explicit private `registry reveal` must create a new protected output file;
compare privately and handle the plaintext under your retention policy. If testing
printed retention, `registry print-insert` exports saved secret values to a private
phone-sized PDF. Follow [the private insert procedure](PHONE_REGISTRY.md#prefilled-private-phone-sized-insert),
check both languages privately, and never upload that PDF or its page images.
Blank policy-generated inserts can instead be completed privately by hand.

## 10. Interruption and recovery rehearsal (F11)

Complete this rehearsal before the final happy-path acceptance run. After it,
obtain a fresh review and repeat invalidated setup/acceptance checks; do not reuse
a pre-rehearsal approval. Use a disposable synthetic visit for deliberate
cancellation, not a primary-phone flash. Choose a safe reviewed non-flash stage, retain its run ID and request
`agent cancel --run RUN_ID --project-root "$P"`. Inspect its terminal state,
owned helper/resources, native receipts and retained reservations. Do not assume
cancellation undid a package/account change or that closing a terminal killed a worker.

For any unexpected failure, stop further mutations. Use the original transport and
endpoint, retained operation ID and the [typed recovery procedure](CANARY_BACKUP_RECOVERY.md#recover-an-interrupted-pxv-operation).
Inspection-only `device recover` intentionally exits 4. Acknowledge `--inspected`
only after actual inspection/cleanup; unresolved obligations must remain fenced.
Never delete SQLite state, locks or receipts, restore historical control state or
change control roots. After successful cleanup, prepare a fresh plan for changed
work. Record the rehearsal separately from the happy-path acceptance visit.

A normal named manual pause uses resume, not recovery. Automated supervisor tests
cover owner death and escaped descendants; do not improvise host-kill or bootloader
fault injection on a phone containing real data.

## 11. Fresh acceptance, finalization and your custody (F12)

Return to the intended accepted visit, with no unresolved cleanup from any visit.
Read its policy requirements and stored report:

```sh
pxv guide project --project-root "$P" --kind pixel --locale en
pxv device report --project-root "$P" --asset "$ASSET"
```

For each required outstanding check, perform the real check and record it using
`device attest --project-root "$P" --asset "$ASSET" --check CHECK --operator "$OPERATOR"`.
Replace `CHECK` deliberately; do not batch-confirm checks. Physical verified boot,
ordinary credentials, routes, network failure and representative restore must be
truthful for the current configuration. Contradictory or stale measurements cannot
be overridden by a receipt. Resolve helpers, drift and expired evidence first.

Once the remaining requirements pass, accept as recipient, then sign as operator:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check recipient_acceptance --operator "$OPERATOR"
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check operator_signoff --operator "$OPERATOR"
pxv device finalize --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR" --locale en
```

Finalization takes fresh measurements and disables debugging. Physically verify
USB debugging and Wireless debugging are both off, the bootloader is locked, OEM
unlocking is off and you retain the phone. Confirm there are no installed pxv
helpers or unresolved cleanup. Then record custody under the same person's name:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient "$OPERATOR" --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output "$TEST_ROOT/handoff-en"
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale pl --output "$TEST_ROOT/handoff-pl"
```

Inspect both reports privately: correct phone/profile configuration and limitations,
no credential values, and accepted custody. Keep them with your results and backups.
Do not enable debugging again merely to collect final screenshots. Any later service
visit follows maintenance, fresh observations and renewed acceptance as applicable.

## 12. Build the five-profile blank guides and close the record

From the source checkout, after the private project policy is frozen:

```sh
pxv guides rebuild --policy "$P/policy.yaml" \
  --output-dir "$TEST_ROOT/guides" --chromium /usr/bin/google-chrome
```

Choose an actually installed Chromium path. This compiles source before rendering;
finish device work first, and use a new review if executable bytes change before a
later mutation. The five-profile build should produce **13 quickstart sections** and
**12 blank credential-insert sections** per language. Sections span panels; use QA for the physical A4 sheet counts. Inspect the generated QA,
font/glyph checks, every page and profile names/order. These are intended settings,
not device acceptance; populated registry inserts are separate private exports.

Complete every result and record remaining limitations. Preserve a consistent private
project backup and current host evidence using the [cold-backup procedure](CANARY_BACKUP_RECOVERY.md#back-up-operator-projects-and-host-evidence).
Do not overwrite current host control state from a backup. Only a separately reviewed,
sanitized summary may be shared publicly; omit serials, account IDs, credentials,
raw logs, private policies, populated inserts and identifiable screenshots.
