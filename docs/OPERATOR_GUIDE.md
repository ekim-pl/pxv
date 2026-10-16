# Operator guide

## Responsibilities and working boundaries

The operator owns the host, project data, device identification and reviewed policy. The recipient owns final passwords, accounts, MFA and recovery material. Agree the intended uses, allowed profiles, support contact, backup destination and erasure authorization before provisioning. Do not record real credentials in a policy, recipe, screenshot, note, extension input or transcript.

Use the [quickstart](OPERATOR_QUICKSTART.md) to prepare an isolated project. A project contains `pxv.project.json`, `policy.yaml`, `inventory.json`, `policy.lock.json` and a private SQLite database under `state/`. The marker is `format: pxv-ts`. Existing legacy state is retained; this release provides no importer or compatibility execution mode.

## Build a policy for this deployment

Choose a starter and explicitly review OS release/codename/signing key, APK versions/content hashes/signer pins, repository trust anchors, profiles, permission grants, settings, VPN behavior, backup transports and required manual checks. Exactly one owner is required; secondary profiles and their names are policy choices. The five-profile example is optional.

Edit the project's policy, validate it and write its lock before planning. The lock binds the product descriptor, engine identity, policy, project configuration and installed extensions. Duplicate keys, unknown fields, duplicate identities and ambiguous selections are rejected. A changed lock or engine invalidates prior reviews.

If another process changes policy, configuration, inventory or executable bytes during a prompt, pxv rejects the stale context before approval, execution, signoff, finalization, custody or lifecycle changes. Reload the command/project, validate the intended configuration and prepare a new review. Expiry-only `agent refresh` does not authorize changed policy. Conflicting state changes are serialized; a stale update never silently replaces a newer one.

~~~sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P" --yes
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset lab-01
~~~

The exact asset `all` is valid. Select it with `--asset all`. A fleet requires explicit `--all` or a group selector; never substitute an asset string for a fleet selector.

## Review and provisioning

Prepare a plan with `device plan` or a workflow's `--dry-run`. Plans bind target identity, transport, current observations, artifact snapshots and device-wide APK effects. Review those effects across every Android user: APK code and version replacement can affect users outside the selected profile.

Run `device provision` for the policy, `device create-users` for profile creation or `device deploy` for app deployment. Each route uses the same verified artifact/install path. A digest alone does not establish publisher identity; verify signer pins from trusted material. Authenticated repositories also enforce signer, age and rollback floors.

~~~sh
pxv device provision --project-root "$P" --asset lab-01 --operator 'Operator'
pxv agent runs --project-root "$P"
pxv agent status --project-root "$P" --run RUN_ID --after 0
~~~

A pending run names its manual checkpoint. Configure only that checkpoint, record a named check, then resume the same approved run. `normal_credentials` must precede final language and optional `duress`. Complete ordinary app setup before language-sensitive final steps. Recipes bind OS fingerprint and exact package version/signer; an unsupported screen stays manual and does not become verified from a tap attempt.

File-selection automation is checked before an app is launched or private input is staged. If the exact accepted adapter is unavailable, complete the full import privately using the pending instructions; there is no staged file waiting for selection. A later adapter failure also removes owned temporary input where cleanup can be proven. Inspect retained recovery obligations if cleanup fails.

~~~sh
pxv device attest --project-root "$P" --asset lab-01 \
  --check normal_credentials --operator 'Operator' --yes
pxv agent resume --project-root "$P" --run RUN_ID --yes
~~~


If the remaining work outlives its review, run `agent refresh --run RUN_ID`. It prepares a new plan for unfinished work only and returns `planId`, exact `reviewSummary` and `expiresAt`. Save the decoded reviewSummary string exactly in a private file, inspect the new target/actions, then submit `agent execute --plan NEW_PLAN_ID --review-file FILE --operator NAME`. Refresh does not authorize work or replay completed actions. Interrupted mutations still require inspection/recovery first.

Read the actual pending check list; a policy can require routes, failure tests, backup restore, app setup, recipient acceptance or other supported capabilities. A note cannot override a contradictory measurement. Network-probe evidence covers the probe app UID and reviewed HTTPS endpoints, not every app's traffic.

## Verified OS installation

Install only on a phone explicitly authorized for erasure. Pin the official release's codename, URL, signature URL, OpenSSH principal/namespace and authenticated public key. Attend physical unlock, unlock-state, relock and first-boot checks. Fastboot needs direct USB and an exact serial. Host-ADB-only Docker mode cannot install an OS.

~~~sh
pxv device install-os --project-root "$P" --asset lab-01 --operator 'Operator'
~~~

The reviewed installer verifies image/signature bytes and runs the authenticated script through a serial-forcing fastboot wrapper. Do not bypass an interrupted installation, relock an unverified image or turn an unsigned download into a trusted artifact. Follow the [official GrapheneOS installation instructions](https://grapheneos.org/install/cli) for the device's physical procedure and stop when its state differs from the expected checkpoint.

## Recovery and loss of supervision

For backup preparation, restore drills and recovery procedures for disposable, protected reference/master and primary/master phones, use the separate [canary, backup and recovery runbook](CANARY_BACKUP_RECOVERY.md). It also explains consistent private project backups and the limits of restoring operator state.

Cancellation requests stop future work and clean owned resources where provable; they do not undo an arbitrary flash, account entry or APK change. A native supervisor persists process ownership and completion receipts. An interrupted mutation reserves the physical device and transport across projects, forks and Docker workers.

~~~sh
pxv agent cancel --project-root "$P" --run RUN_ID
pxv device recover --project-root "$P" --asset lab-01
pxv device recover --project-root "$P" --asset lab-01 \
  --run ORIGINAL_RUN_ID --inspected --yes
~~~

Inspect the phone and retained evidence first. Recovery uses stable Android user serial numbers, not reusable IDs/names. A recreated user must remain unresolved. Child probe cleanup must not release a parent workflow's resources. Unproven native cleanup can require a host reboot; manual acknowledgment cannot bypass a live native owner. Failed recovery retains its fence and may be retried through the recorded recovery lineage. Never delete a database, lock or receipt to make a blocked device appear ready.

Failed obligations stay blocked until an explicit inspected retry succeeds. Each child can register/resolve only its own resources. A resolved obligation is not replayed, and ownership or stable-user mismatches remain unresolved.

## Signoff and custody

Reboot and check persistence, user isolation, network behavior and a representative restore. Record the policy's checks against fresh observations; the current freshness window is 15 minutes. Finalization remeasures required permissions and settings and refuses drift, outstanding helpers, unresolved cleanup or stale evidence.

~~~sh
pxv device report --project-root "$P" --asset lab-01
pxv device finalize --project-root "$P" --asset lab-01 --operator 'Operator' --locale en
pxv handoff accept --project-root "$P" --asset lab-01 \
  --recipient 'Recipient' --debugging-off --yes
pxv handoff export --project-root "$P" --asset lab-01 --locale en --output "$P/handoff"
pxv handoff export --project-root "$P" --asset lab-01 --locale pl --output "$P/handoff"
~~~

Handoff export uses the accepted product and resolved-policy snapshot, even if the current editable policy has changed. Keep such a packet as historical evidence; it does not establish current readiness. The CLI exports Markdown and HTML. PDF creation is an explicit guides API/tooling path, without a CLI PDF flag.

A report describes stored readiness and is not a fresh device attestation. Read the finalization result. Physically confirm debugging toggles are off, remove temporary helpers and transfer custody only after recipient acceptance. Ready-for-handoff, completed-custody, subset and emulator outcomes remain distinct.


The final USB-debugging-disable request can close its selected ADB transport before the client returns a normal reply. The dedicated shutdown step accepts only its precisely checked expected disconnect as acknowledgment of the request. Physically confirm USB/wireless debugging are off before custody acceptance; acknowledgment alone is not that confirmation. Other disconnects, failed checks or interrupted cleanup remain inspection/recovery work, without automatic retry.

## Return visits

Record maintenance, policy changes, loss or retirement through `lifecycle`. These events invalidate prior handoff evidence. Maintenance needs new observations and renewed handoff. Retirement records confirmed erasure and custody; the command does not silently wipe a device. Revoke external accounts/tokens through their owners when a phone is lost.

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.

## Guidance from the selected policy

Use `pxv guide project --project-root "$P" --locale en --kind pixel` to print profiles, readiness checks and private setup order derived from the current policy; `--kind emulator` selects emulator-specific requirements. `pxv device guided --project-root "$P" --asset lab-01 --operator 'Operator'` presents that guidance and runs the shared provisioning path, returning concrete pending next steps. Its `--dry-run` form prepares review without mutation. The generic operator/recipient guides remain available separately. Guidance never supplies credentials, overrides measurements or turns a manual step into verified completion.

## Owner-name preflight

The owner display name in policy must match the phone's actual localized owner name, such as Właściciel. If preflight reports an owner-name mismatch, update that reviewed policy field or rename the owner on the phone, then write a fresh policy lock and prepare again. The engine does not silently rename it. Stable Android user identity and fresh measured-state checks still apply.
