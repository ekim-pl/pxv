# Pixel preparation: operator guide

Prepare one enrolled Google Pixel or an explicitly selected fleet with GrapheneOS, Android user profiles, pinned apps and reviewed settings. Work from a private project and keep the exact plan, run status and handoff evidence together.

**Start here:** identify the phone, review the policy, install the OS only if separately authorized, provision, complete phone checkpoints, then finalize and transfer custody. OS installation erases data. A completed command does not establish that the phone is ready for handoff.

Examples use the installed `pxv` command. Replace placeholders before use. `--yes` confirms a real review or physical check; it does not perform that check.

Commands display readable summaries by default. Add `--json` when capturing structured output for a script, and use `pxv COMMAND --help` for supported flags. `--dry-run` is accepted on commands with a preview mode. Device workflows prepare plans; policy app commands download and verify artifacts without writing the policy or creating a device plan. Finalization, attestation and recovery reject it. Run history is paginated: `agent runs --json` returns `items` and `nextCursor`; follow a non-null cursor with `--cursor` until it is null.

## 1. Prepare the workstation and project

Use the reviewed Linux x86_64 portable archive or installed package. The portable archive and Debian package include Node and the native supervisor; Android tools and USB permissions still need setup. Run as the ordinary operator account.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
```

Doctor does not start ADB. Resolve missing tools, permissions and native-runtime failures before connecting a production phone. A source checkout uses the pinned toolchain and `pnpm pxv` after building; follow [host dependencies](../../../docs/operators/host-setup.md) for the exact setup and checks.

Project initialization requires complete app pins. If your policy only declares app
sources, first [resolve it into a pinned file](../../../docs/operators/policy-reference.md#resolve-a-source-draft-before-project-initialization)
using explicit SDK/ABIs, then use that file below.

Create a new project outside the source/resource checkout. Keep one operator control domain for every phone reachable from this workstation.

```sh
P='/absolute/private/path/to/project'
ASSET='phone-01'
OPERATOR='Operator name'
pxv project init --path "$P" --policy /absolute/path/to/reviewed-policy.json
```

Back up private project state and inventory consistently. Keep unlock material separately. Never copy another phone's database, approvals or credentials to create a fleet member.

## 2. Define the intended phone, profiles and apps

Review the authored policy before enrollment or execution. The bundled five-profile pack is a structural starter: it does not supply approved apps, working VPN accounts or a qualified deployment.

Define an `apps` catalog once and reference its IDs in each profile's `apps` list. Pin package ID, version code, APK SHA-256, signer SHA-256 and an approved source. Android package versions are shared across users; profiles cannot independently install conflicting versions.

Installed managed apps must use one standalone APK. PXV verifies package, version,
signer and SHA-256 from the same pulled bytes. Different content at the same
version/signer requires a reviewed reinstall, including effects on other users.
Split installations require explicit maintenance; PXV never removes them
automatically. Missing or mismatched current hashes block acceptance/finalization.
Older authentic handoffs remain historical evidence without invented hashes.

### Resolve and update app pins

`policy resolve-apps` fills missing app version, content-hash and signer pins from
`direct`, official F-Droid (`fdroid`/`fdroidcl`), custom `fdroid-repository`, legacy
repository/URL, or local APK sources. Supplied pins remain constraints. Before
initializing a project from a source-only draft, preview and write a separate file:

```sh
pxv policy resolve-apps --policy /absolute/private/policy.sources.json \
  --sdk 36 --abi arm64-v8a --output /absolute/private/policy.pinned.json --dry-run
pxv policy resolve-apps --policy /absolute/private/policy.sources.json \
  --sdk 36 --abi arm64-v8a --output /absolute/private/policy.pinned.json
```

Use the intended Android SDK and ABIs instead of assuming these example values.
Review any newly observed APK signer; a direct download's first observed certificate
does not independently authenticate its publisher. Custom repository certificates
must already be trusted. Pass the pinned output to `project init`. An existing
project can resolve its configured policy with `--project-root` instead of `--policy`.

To upgrade existing pins from trusted F-Droid repositories, use `policy update-apps`.
After enrolling the phone in section 3 and starting its owned ADB service:

```sh
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb
```

The write invocation presents a fresh review. It retains the APK signer and prevents
downgrades. Inspect every skipped source; publisher/local downloads without a trusted
repository mapping need separate release review. A source resolution fails if any
app cannot be verified, including unused catalog entries.

Both commands run on the host. All APK inspection needs `aapt` and `apksigner`;
repository discovery also needs `fdroidcl` and Java. Without a connected phone,
replace `--asset`/`--transport` with `--sdk N --abi ABI[,ABI...]`; remote sources
still require network access. These commands write policy files, not phone state,
and leave the existing policy lock untouched. After a policy write, validate and
lock it using the commands below, check exact-version recipes, and review a fresh
device plan. See [the policy command choices](../../../docs/operators/policy-reference.md#choose-the-policy-command).

### Review the rest of the policy

Place device-wide Android `global` settings in `deviceSettings`. Profile `settings` contain `secure` or `system` entries. Define profile names, permissions, VPN and language deliberately; the owner name must match the observed owner. Keep secrets out of policy values and recipe text.

For mixed models, `os` maps each exact Pixel codename to a complete authenticated GrapheneOS image pin. Every model to be flashed needs its own entry. No image is selected by a guessed model or fallback. See [policy format](../../../docs/operators/policy-reference.md) for the schema.

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale en
```

Planning through finalization requires a matching lock. `policy validate` reports `policyLockStatus` (`current`, `missing`, `stale`, `invalid`). Explicitly renew after policy, configuration, extension or executable changes. Inspection, cancellation, typed recovery and offline records work without installed extensions. Custody uses the original handoff across baseline changes until lifecycle invalidation. Select the reviewed policy in `pxv.project.json` before validating/locking.

## 3. Enroll one exact physical device

Check the physical asset label, hardware serial, model and codename. Keep unrelated phones disconnected where practical. First enrollment uses USB. With Android running, enable USB debugging temporarily and authorize this workstation on the phone.

```sh
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial OBSERVED_SERIAL --model 'ACTUAL PIXEL MODEL' --codename ACTUAL_CODENAME
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
```

For a phone already in fastboot, enrollment instead adds `--mode fastboot`; the exact serial and reported codename are checked. Skip the ADB-based `device inspect` command until Android has booted and debugging is authorized. Enrollment does not authorize erasure. A replacement handset requires its own reviewed inventory identity.

Use `--asset ID` for one phone. Fleet selection requires `--group GROUP` or `--all`, explicitly; these selectors cannot be combined. An asset named `all` is still selected with `--asset all`.

## 4. Install GrapheneOS as a separate destructive phase

Skip this phase when the intended OS is already installed and verified. Before installation, agree erasure scope, preserve supported phone-data backups and confirm that the selected phone may be wiped. Read [canary, backup and recovery](../../../docs/operators/recovery-and-maintenance.md).

Follow the [official GrapheneOS preparation instructions](https://grapheneos.org/install/cli#enabling-oem-unlocking), including enabling OEM unlocking in the running OS when required. Manually enter the bootloader's **Fastboot Mode**, compare its physical identity and keep it in that mode. PXV checks the exact fastboot target; it does not reboot from ADB into fastboot for you. Leave unlock/relock commands to the reviewed PXV operation.

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Read the returned `planId`, `reviewSummary` and expiry. Check the exact physical target, codename, release, image/signature identity and destructive scope. For interactive execution, run:

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run OS_RUN_ID --after 0
```

This prepares a fresh plan and asks you to review it again before confirmation; the earlier dry run grants no approval. Keep the returned run ID for `agent status`. Attend the physical bootloader unlock and relock confirmations. Do not disconnect the phone or interrupt flashing deliberately. Verify installation and the relocked bootloader through the reported checks and phone prompts. A host-ADB Docker worker cannot flash; direct USB is required.

The OS run pauses for re-enrollment/setup. Finish the phone's initial setup, authorize USB debugging again, reconfirm the existing physical enrollment with `device inspect`, then prepare a **new provisioning plan**. Do not rerun flashing to advance this pause or enroll the same unchanged handset twice. Registry bindings affected by flashing are stale even if installation fails.

## 5. Prepare, review and submit provisioning

Provisioning prepares profiles, apps, settings, permissions and declared configuration steps. It does not silently include OS installation. `create-users` and `deploy` are narrower operations when that is the intended scope.

```sh
pxv device provision --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Inspect every action and shared-package effect, physical target, stable Android user identity, manual gate and expiry. Start interactive provisioning and inspect its newly prepared review before confirming:

```sh
pxv device provision --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run RUN_ID --after 0
```

Keep the returned run ID and read its status and `pauseReason`. A manual pause leaves work unfinished. Poll with the last event cursor to read new events. For background submission of a retained exact plan, use the byte-exact review-file procedure in [automation](../../../docs/ai-agents/workflow-and-recovery.md). `device guided` presents policy-derived instructions and executes after confirmation; use `--dry-run` to review first.

Private initial credential defaults, if selected, come from `secrets/credentials/ASSET.json`: a `schemaVersion: 1` document whose `values` map resolves policy secret references. Use an owned `0600` file and private directories; never put values in commands or notes. Omit default declarations for private manual setup. Defaults initialize a profile with no existing screen lock and are not a password-change mechanism; accepted defaults are skipped on repeat runs for the same stable user.

Set `scramblePinLayout: true` on each profile that should use a shuffled primary PIN keypad, or `false` for the standard layout; omission leaves it unmanaged. This applies during profile settings before PIN initialization and remains managed on later provisioning runs. The fleet starters enable it on profiles with initial PINs. Stored-setting readback is followed by private visual verification at `normal_credentials`; it does not configure fingerprint second-factor PIN scrambling.

For automatic duress defaults, `ownerCredentialRef` must resolve to the owner's **current ordinary unlock credential**, updated privately if it changed. Never supply an existing duress credential for authentication. Unsupported commands or existing locks require inspection and a fresh reviewed manual path; a successful default write does not prove a real unlock.

## 6. Complete the named phone checkpoints

A pending run returns a `pauseReason` and the next gate. Perform only the named work in the correct profile. Configure app accounts, imports, MFA and Android consent privately before attesting.

App configuration precedes VPN verification. A changed VPN without a matching app recipe may first pause at `app_setup` for private account setup and consent. Every profile then pauses at `vpn_settings`, including already-matching and disabled VPNs. Open Android VPN Settings in the named profile and configure or witness the reviewed app, Always-on VPN and Block connections without VPN toggles. Record `device attest --check vpn_settings --asset "$ASSET" --operator "$OPERATOR"` with the project root, then resume. Each profile needs its own confirmation. PXV labels this `operator-witnessed-settings`; saved configuration is not an automated live-enforcement measurement. Required network probes remain separate.

Declare VPN state only in the policy's `vpn` block. Remove secure-setting entries
for `always_on_vpn_app` and `always_on_vpn_lockdown`; duplicates are rejected even
when values match. Completed witnesses require the retained reviewed action, run
and audited receipt. Review refresh preserves proofs only through validated history.
If provenance is missing or changed, retain it for inspection and prepare a newly
reviewed provisioning run instead of editing evidence files.

Recipes are bound to an exact Android build and app version/signer. Unsupported screens or imports remain assisted/manual. If an accepted file-selection adapter is unavailable, complete the entire import through an approved private method; no temporary staged file is left for later selection. Do not paste sensitive settings into public recipe text.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check app_setup --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run RUN_ID
```

Use the actual named gate instead of `app_setup` when different. A `language:PROFILE` pause is completed on the phone and then resumed; do not invent a language attestation. The private sequence is normal locks verified in every profile, final language, then optional duress setup. Both duress values must differ from every actual ordinary profile credential. Never activate erasure as a test.

If review expires at an intentional manual checkpoint, `agent refresh --run RUN_ID` prepares the remaining work for a new review. Save its new exact summary and submit its new plan with `agent execute`. Refresh does not approve changes or recover an uncertain interrupted mutation.

After provisioning, attestation can use an expired execution plan if measurements are no older than 15 minutes and live state is unchanged. Stale acceptance measurements require a newly reviewed provisioning run. Docker terminal execution streams prompts and progress; JSON execution needs explicit noninteractive confirmation. The wrapper mounts explicitly named external files and outputs, and direct USB retains the caller’s supplementary groups. See the Docker reference for sidecar recreation and raw-container MCP operation.

## 7. Check, finalize and transfer custody

Recipe/probe readiness requires complete results, exact source lineage and
audit-backed app-setup receipts. Missing or conflicting recipe checkpoints block
resume/refresh; PXV never replays UI or repairs evidence. Preserve records, inspect
the app and complete required recovery before newly reviewed work. Worker failures
preserve newer/completed records; combined operation/disposal errors show both
failures.

Before final signoff, you may collect agreed registry values with the three optional device collectors in section 9. Complete collection before debugging is disabled.

Read current requirements and stored readiness, then perform the actual checks on the phone:

```sh
pxv device report --project-root "$P" --asset "$ASSET"
pxv guide project --project-root "$P" --kind pixel --locale en
```

Check reboot persistence, profile separation, app behavior, permissions/settings, languages, expected network behavior and the required representative restore. A network helper checks its own UID and reviewed endpoints; it does not certify all app traffic. Record only checks actually performed; receipts cannot override contradictory measurements.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check REQUIRED_CHECK --operator "$OPERATOR"
```

Complete all other required checks, then record the recipient's actual acceptance before fresh `operator_signoff`. This attestation is separate from the later transfer-of-custody record. Signoff and finalization use fresh measurements; finish within the evidence window reported by the application. Outstanding helpers, cleanup, drift or stale policy/build identity block readiness.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check recipient_acceptance --operator "$OPERATOR"
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check operator_signoff --operator "$OPERATOR"
pxv device finalize --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR" --locale en
```

`finalization-inspection` blocks incomplete shutdown. Inspect the phone/evidence, complete required recovery, then use the [maintenance procedure](../../../docs/operators/recovery-and-maintenance.md#recover-incomplete-finalization) for new provisioning and acceptance. Do not retry shutdown or claim custody. Storage/decoding failures are errors, not VPN tasks. Custody authenticates the full original plan; altered/incomplete evidence blocks it.

The retained intent also blocks new planning, submission, refresh, execution/resume,
attestation, extension contributions, Seedvault and collectors after policy or
executable changes. Lock renewal cannot clear it. Inspection, history, cancellation,
typed recovery, disconnect and offline records stay available; explicit maintenance
archives it before newly reviewed provisioning.

In an enabled recovery product, backup-only preflight also checks current policy
approval during dry runs, before pairing/connecting. Validate and explicitly renew
missing, corrupt or stale locks after upgrades; automation never renews approval.
Connection history has no 1,000-record ceiling. Failed disconnect reconciliation
retains cleanup for explicit retry and preserves unrelated sessions.

Every new Seedvault connection requires current approval, checked again after prompts.
Backup-only work stops if its initial baseline changes while waiting, even after lock
renewal; restart the workflow. Disconnect and inspected cleanup stay available.

After finalization, physically verify **USB debugging and Wireless debugging are both off**. Confirm the bootloader remains locked and OEM unlocking is off. Confirm the phone is in the recipient's custody before recording acceptance:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient 'Recipient name' --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output /absolute/path/to/handoff
```

Custody completes the matching run without further acceptance instructions; subset/extension completion alone does not prove custody. Reports flag `measurement-freshness` (invalid, future or over 15 minutes) and `policy-lock`. Unavailable readiness retains history with `ready: false`, `readinessStatus: unavailable` and a reason. Historical custody survives expiry; never reprovision solely to refresh it.

The handoff packet is Markdown/HTML from its retained policy snapshot. Review it before sharing. Generic guide PDFs are instructions, not device acceptance evidence.

Attach the [phone-sized quick start](quickstart-en.md) to every phone, together with its accepted handoff report and a sealed [private credential insert](credentials-en.md). Match all asset labels. Complete the insert privately outside guide sources and release assets, copying the profile/account pages as needed. Verify ordinary locks privately; mark unused fields and initial or last-confirmed values clearly. Keep optional destructive credentials on the separately sealed erasure page. Fill real support and recovery routes and agree any support retention. Ask the recipient to store the completed insert apart from the phone after receipt. See [packing and printing](../../../guides/README.md#pack-every-device).

## 8. Run a fleet without hiding individual outcomes

Enroll each physical phone separately. Confirm each codename has its own OS pin and review every device's plan. Start with one target, then increase concurrency deliberately; `--jobs` accepts 1–8.

```sh
pxv fleet provision --project-root "$P" --group BATCH --jobs 2 --dry-run
pxv fleet provision --project-root "$P" --group BATCH --jobs 2 --operator "$OPERATOR"
```

The second command prepares fresh plans and asks for confirmation. Inspect its displayed review before accepting. Track each run independently; one phone's success does not satisfy another's gate or repair its failure. Attestation, finalization, registry updates and recovery use one exact asset. Use the separate OS phase for any fleet flashing and attend every phone's prompts.

## 9. Retain current credentials for authorized support

After private app setup and before final signoff/debugging shutdown, optionally run
`device collect-oblivion`, `device collect-sessionid` and `device collect-simcards`,
each with `--project-root "$P" --asset "$ASSET"`. Initialize the registry first.
The app collectors visit enrolled profiles, verify signing identities and ask for
private unlocking; SIM numbers are retained once at device level. Oblivion reads
`net.oblivion.wipe`, distinct from the starter policies' `org.bepass.oblivion`.
Opening it can enable wipe triggers; confirm opening it only after private setup.
Unreadable values offer hidden manual entry or an explicit skip. Review outcomes
and confirm retention; `--yes` bypasses neither unlocking nor retention. SIM retention
replaces the complete saved device number list. No screenshots or messages are
created. Changed identities or failed foreground restoration prevent saving; use
[collection and recovery](../../../docs/operators/registry.md#opt-in-pre-handoff-collection).
Finalization does not require these optional commands.

The local encrypted registry joins asset ID, hardware serial and codename with per-profile stable Android identities. It can retain phone number and device duress PIN/password, plus each profile's PIN/password, Oblivion key, Session messenger ID, Proton VPN username/password and optional phone number. Reused service accounts are recorded explicitly; a Session ID is not an Android user ID.

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file /private/directory/phone.json --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Use revision zero only for the first record; subsequent updates require the revision shown by `show`. Each update replaces the complete current phone record and preserves all previous revisions encrypted. States are `initial`, `current`, `unknown` and `stale`; `current` means last explicitly confirmed by the operator, not automatically read from the phone. Coordinate private credential changes with a registry update.

Unlock uses a hidden local prompt. Private inputs/outputs need an owned `0600` file in a `0700` directory. `list`, `show` and `history` omit values; `reveal --asset ID --output NEW_PRIVATE_FILE` deliberately writes plaintext. `rekey` rotates the unlock passphrase. `reconcile` explicitly accepts a restored/interrupted copy by appending stale revisions; reconfirm current values afterward. Read [registry storage, history and recovery](../../../docs/operators/registry.md) before use.

`pxv registry print-insert` requires an asset, a new private PDF path and local Chromium. It groups ordinary credentials by profile, with destructive credentials on a separate cut-and-fold A4 sheet. Longer records add sheets without shrinking values. Assets appear once per sheet. Saved SIM numbers from `device collect-simcards` are printed at device level; profile phone numbers remain separate. Missing supported fields have labeled spaces to fill by hand or mark not configured; separate recovery worksheets are omitted. See the [registry export instructions](../../../docs/operators/guides-and-inserts.md#prefilled-private-phone-sized-insert).

Guide rebuilding can also create the same private PDF with `--private-insert-output FILE --project-root DIRECTORY --asset ID --output-dir DIRECTORY --chromium PATH`. It uses the project policy; keep the private output outside the shared guide directory. Shared guide artifacts remain blank.

To print a project name or a different support contact, add optional `insertMetadata`
to the existing `pxv.project.json`, for example
`"insertMetadata": { "projectName": "Example Fleet", "support": { "name": "Device Support", "phone": "+48 123 456 789" } }`.
The project name and support object are independently optional. A support override
requires a name and at least one email, HTTPS website or phone number; it replaces
the complete product contact. Without it, the product contact is used. Use nonblank,
single-line text. Metadata edits change the policy identity: update the policy lock
and prepare fresh operational reviews.

```sh
pxv policy lock --project-root "$P"
pxv guides rebuild --project-root "$P" --output-dir /private/project-guides --chromium /usr/bin/google-chrome
```

This builds EN/PL blank inserts using project metadata and policy without unlocking
the registry. `--html-only` can replace the Chromium option. Use a separate output
directory and omit `--policy`. Both private export paths use the same contact details.
See [project insert metadata](../../../guides/README.md#project-names-and-support-contacts).

Flashing, profile creation, credential defaults and lifecycle changes stale affected registry bindings; history remains. Offline records neither configure phones nor supply provisioning secrets. Oblivion notification-wipe behavior is user-described as phone-wide and unqualified for any exact app/build. Keep its keys separate from GrapheneOS duress; never include real keys in notifications, logs, ordinary exports or tests.

## 10. Handle interruptions and later maintenance

On pending work, read the gate. On failure, cancellation, lost host/container or `needs-inspection`, stop further mutations and inspect the phone, run events and owned cleanup first.

```sh
pxv agent status --project-root "$P" --run RUN_ID --after 0
pxv agent cancel --project-root "$P" --run RUN_ID
pxv device recover --project-root "$P" --asset "$ASSET"
pxv device recover --project-root "$P" --asset "$ASSET" \
  --run ORIGINAL_OPERATION_ID --inspected
```

Cancellation does not prove cleanup. Use the original operation ID from recovery evidence. Never delete SQLite state, fences, locks or receipts. Reused Android user IDs/names cannot authorize cleanup against a different user serial. Uncertain native cleanup may require host restart and inspected recovery.

Record `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT` for the applicable event. Notes contain no secrets. These events invalidate earlier handoff evidence; a new deployment needs fresh review and acceptance. Use `--erased` only after erasure was actually confirmed.

## Offline rehearsal and reference

For an offline rehearsal, use a new project and synthetic policy:

```sh
pxv project init --path /private/path/offline-rehearsal --policy /path/to/synthetic-policy.json
pxv policy validate --project-root /private/path/offline-rehearsal
pxv guide project --project-root /private/path/offline-rehearsal --kind pixel --locale en
```

Initialization records a lock. Synthetic tests qualify host behavior only; verify flashing, UI recipes, VPN, restoration and custody separately on a disposable canary. References: [commands](../../../docs/operators/command-reference.md), [automation/MCP](../../../docs/ai-agents/workflow-and-recovery.md), [Docker](../../../docs/operators/host-setup.md), [security](../../../SECURITY.md), [verification](../../../docs/operators/acceptance.md). Community disables extensions and experimental Seedvault. Verify manual backup/restore separately; physical results qualify only their recorded candidate.
