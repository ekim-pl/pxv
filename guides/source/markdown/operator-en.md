# Pixel preparation: operator guide

Prepare one enrolled Google Pixel or an explicitly selected fleet with GrapheneOS, Android user profiles, pinned apps and reviewed settings. Work from a private project and keep the exact plan, run status and handoff evidence together.

**Start here:** identify the phone, review the policy, install the OS only if separately authorized, provision, complete phone checkpoints, then finalize and transfer custody. OS installation erases data. A completed command does not establish that the phone is ready for handoff.

Examples use the installed `pxv` command. Replace placeholders before use. `--yes` confirms a real review or physical check; it does not perform that check.

Commands display readable summaries by default. Add `--json` when capturing structured output for a script, and use `pxv COMMAND --help` for supported flags. `--dry-run` is accepted only where it prepares a plan; finalization, attestation and recovery reject it. Run history is paginated: `agent runs --json` returns `items` and `nextCursor`; follow a non-null cursor with `--cursor` until it is null.

## 1. Prepare the workstation and project

Use the reviewed Linux x86_64 portable archive or installed package. The portable archive and Debian package include Node and the native supervisor; Android tools and USB permissions still need setup. Run as the ordinary operator account.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
```

Doctor does not start ADB. Resolve missing tools, permissions and native-runtime failures before connecting a production phone. A source checkout uses the pinned toolchain and `pnpm pxv` after building; follow [host dependencies](../../../docs/HOST_DEPENDENCIES.md) for the exact setup and checks.

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

Place device-wide Android `global` settings in `deviceSettings`. Profile `settings` contain `secure` or `system` entries. Define profile names, permissions, VPN and language deliberately; the owner name must match the observed owner. Keep secrets out of policy values and recipe text.

For mixed models, `os` maps each exact Pixel codename to a complete authenticated GrapheneOS image pin. Every model to be flashed needs its own entry. No image is selected by a guessed model or fallback. See [policy format](../../../docs/POLICY_FORMAT.md) for the schema.

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale en
```

A policy change needs a new lock and fresh review. Select the reviewed policy in `pxv.project.json`, validate and lock it before preparing new plans.

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

Skip this phase when the intended OS is already installed and verified. Before installation, agree erasure scope, preserve supported phone-data backups and confirm that the selected phone may be wiped. Read [canary, backup and recovery](../../../docs/CANARY_BACKUP_RECOVERY.md).

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

Keep the returned run ID and read its status and `pauseReason`. A manual pause leaves work unfinished. Poll with the last event cursor to read new events. For background submission of a retained exact plan, use the byte-exact review-file procedure in [automation](../../../docs/AUTOMATION.md). `device guided` presents policy-derived instructions and executes after confirmation; use `--dry-run` to review first.

Private initial credential defaults, if selected, come from `secrets/credentials/ASSET.json`: a `schemaVersion: 1` document whose `values` map resolves policy secret references. Use an owned `0600` file and private directories; never put values in commands or notes. Omit default declarations for private manual setup. Defaults initialize a profile with no existing screen lock and are not a password-change mechanism; accepted defaults are skipped on repeat runs for the same stable user.

For automatic duress defaults, `ownerCredentialRef` must resolve to the owner's **current ordinary unlock credential**, updated privately if it changed. Never supply an existing duress credential for authentication. Unsupported commands or existing locks require inspection and a fresh reviewed manual path; a successful default write does not prove a real unlock.

## 6. Complete the named phone checkpoints

A pending run returns a `pauseReason` and the next gate. Perform only the named work in the correct profile. Configure app accounts, imports, MFA and Android consent privately before attesting.

App configuration precedes VPN enforcement. A changed always-on/lockdown VPN without a matching recipe pauses for `app_setup`: configure that profile's VPN app, grant VPN consent and check its intended connection before resuming. Separate profile gates need separate fresh confirmations.

Recipes are bound to an exact Android build and app version/signer. Unsupported screens or imports remain assisted/manual. If an accepted file-selection adapter is unavailable, complete the entire import through an approved private method; no temporary staged file is left for later selection. Do not paste sensitive settings into public recipe text.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check app_setup --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run RUN_ID
```

Use the actual named gate instead of `app_setup` when different. A `language:PROFILE` pause is completed on the phone and then resumed; do not invent a language attestation. The private sequence is normal locks verified in every profile, final language, then optional duress setup. Both duress values must differ from every actual ordinary profile credential. Never activate erasure as a test.

If review expires, `agent refresh --run RUN_ID` prepares the remaining work for a new review. Save its new exact summary and submit its new plan with `agent execute`. Refresh does not approve changes or recover an uncertain interrupted mutation.

## 7. Check, finalize and transfer custody

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

After finalization, physically verify **USB debugging and Wireless debugging are both off**. Confirm the bootloader remains locked and OEM unlocking is off. Confirm the phone is in the recipient's custody before recording acceptance:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient 'Recipient name' --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output /absolute/path/to/handoff
```

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

The local encrypted registry joins asset ID, hardware serial and codename with per-profile stable Android identities. It can retain phone number and device duress PIN/password, plus each profile's PIN/password, Oblivion key, Session messenger ID, Proton VPN username/password and optional phone number. Reused service accounts are recorded explicitly; a Session ID is not an Android user ID.

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file /private/directory/phone.json --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Use revision zero only for the first record; subsequent updates require the revision shown by `show`. Each update replaces the complete current phone record and preserves all previous revisions encrypted. States are `initial`, `current`, `unknown` and `stale`; `current` means last explicitly confirmed by the operator, not automatically read from the phone. Coordinate private credential changes with a registry update.

Unlock uses a hidden local prompt. Private inputs/outputs need an owned `0600` file in a `0700` directory. `list`, `show` and `history` omit values; `reveal --asset ID --output NEW_PRIVATE_FILE` deliberately writes plaintext. `rekey` rotates the unlock passphrase. `reconcile` explicitly accepts a restored/interrupted copy by appending stale revisions; reconfirm current values afterward. Read [registry storage, history and recovery](../../../docs/PHONE_REGISTRY.md) before use.

Flashing, profile creation, credential-default writes and lifecycle changes stale affected bindings; old values remain history. Registry commands are local/offline and do not configure phones or supply provisioning secrets. Per-profile Oblivion notification-wipe behavior is user-described as affecting the whole phone and is unqualified for any exact app/build. Keep its keys separate from GrapheneOS duress values; never place real keys in notifications, logs, ordinary exports or tests.

## 10. Handle interruptions and later maintenance

On pending work, read the gate. On failure, cancellation, lost host/container or `needs-inspection`, stop further mutations and inspect the phone, run events and owned cleanup first.

```sh
pxv agent status --project-root "$P" --run RUN_ID --after 0
pxv agent cancel --project-root "$P" --run RUN_ID
pxv device recover --project-root "$P" --asset "$ASSET"
pxv device recover --project-root "$P" --asset "$ASSET" \
  --run ORIGINAL_OPERATION_ID --inspected
```

Cancellation is a request, not proof of cleanup. Use the original operation ID named by retained recovery evidence. Never delete SQLite state, fences, locks or receipts to retry. Reused Android user IDs/names do not authorize cleanup against a new user serial. Some unresolved native cleanup needs host restart and inspected recovery.

Record `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT` for the applicable event. Notes contain no secrets. These events invalidate earlier handoff evidence; a new deployment needs fresh review and acceptance. Use `--erased` only after erasure was actually confirmed.

## Offline rehearsal and reference

Without a physical canary, the shortest rehearsal uses a new dedicated project and a synthetic policy:

```sh
pxv project init --path /private/path/offline-rehearsal --policy /path/to/synthetic-policy.json
pxv policy validate --project-root /private/path/offline-rehearsal
pxv guide project --project-root /private/path/offline-rehearsal --kind pixel --locale en
```

Initialization records a lock. Source maintainers can also run the fake-port registry/workflow tests. This checks the host-side workflow only; it cannot qualify flashing, UI recipes, VPN behavior, restoration or physical custody. Never substitute a primary phone for an unavailable disposable canary.

Use the [command reference](../../../docs/COMMAND_REFERENCE.md), [automation/MCP](../../../docs/AUTOMATION.md), [Docker operation](../../../docs/DOCKER.md), [security boundaries](../../../SECURITY.md) and [verification status](../../../docs/VERIFICATION.md). Community disables optional extensions and experimental Seedvault automation; supported manual backup/restore remains a separately checked phone procedure. Historical physical records qualify only their recorded candidate, not the current build.
