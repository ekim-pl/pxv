# Prepare and use your own Pixel

Use this guide when you prepare one Google Pixel with pxv and also use it yourself.
You are both the **operator**, who reviews and runs preparation, and the
**recipient**, who verifies private setup and accepts the finished phone. Use your
own name for both roles. Keep their checks separate even though you perform them
all yourself.

One person can use only the Android Owner profile or several profiles for different
activities. Additional profiles do not require additional people. This guide follows
one phone through preparation, acceptance, daily use and maintenance. For a scripted
checklist, a separate five-profile starter and a private result sheet, use the
[five-profile self-service test procedure](SELF_SERVICE_FIVE_PROFILE_TEST.md).

**Before you start:** preserve existing phone data and recovery access. OS
installation erases data. Rehearse an unqualified configuration on a disposable
canary before relying on it on your primary phone. If you have no canary, an offline
rehearsal checks only the host workflow; it does not qualify flashing, apps, VPN or
restoration. Never erase your primary phone just to test recovery. Read the
[canary and recovery runbook](CANARY_BACKUP_RECOVERY.md) and
[verification boundaries](VERIFICATION.md).

## 1. Prepare your workstation and private project

Use the reviewed Linux x86_64 portable archive or installed package as your ordinary
user. Configure the Android tools, USB permissions and native runtime described in
[host dependencies](HOST_DEPENDENCIES.md). Examples below use the installed `pxv`
command; a built source checkout uses `pnpm pxv` instead.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
```

Resolve doctor failures before proceeding. Doctor does not start ADB; the last
command explicitly starts the service used for device work. Keep one operator
control domain for phones reachable from this workstation and use only one
controlling workstation at a time.

Choose a new private project directory outside the source/resource checkout. Replace
these placeholders before running the examples, and keep the variables in the same
shell session:

```sh
P='/absolute/private/path/to/my-phone-project'
POLICY='/absolute/private/path/to/reviewed-policy.json'
ASSET='my-phone'
OPERATOR='Your name'
```

Review your policy before initialization:

- For Owner-only use, start with [`simple`](../policy-packs/simple/policy.json).
  It is a structural starter with no apps or OS image pins, not a ready security
  configuration. Prepare your own reviewed copy.
- For several profiles, choose their purposes, names, apps, permissions, VPN and
  languages deliberately. Exactly one profile must be the Owner, and its name must
  match the observed Owner on the phone.
- Pin reviewed apps by package ID, version code, APK digest, signer digest and
  approved source. If you will install the OS, supply authenticated image provenance
  for the phone's exact Pixel codename.
- Keep passwords, MFA material and recovery secrets out of policy values, recipes,
  source files and ordinary notes.

See [policy starters](../policy-packs/README.md) and the
[policy format](POLICY_FORMAT.md) for the configuration details. Then initialize,
validate and lock the project:

```sh
pxv project init --path "$P" --policy "$POLICY"
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale en
```

Keep a consistent private backup of project state and inventory, with unlock
material stored separately. Project state is not a backup of phone data. When you
change policy, validate and lock it again and obtain a fresh plan review.

## 2. Enroll your exact phone

Give the phone an asset label matching `$ASSET`. Compare its physical identity,
hardware serial, model and codename; disconnect unrelated phones where practical.
For enrollment with Android running, temporarily enable USB debugging, connect by
USB and authorize your workstation on the phone.

```sh
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial OBSERVED_SERIAL --model 'ACTUAL PIXEL MODEL' --codename ACTUAL_CODENAME
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
```

Replace all identity placeholders with observed values. If the phone is already in
Fastboot Mode, add `--mode fastboot` to enrollment and skip `device inspect` until
Android is running with debugging authorized. Enrollment checks identity; it does
not authorize erasure. A replacement handset needs its own reviewed enrollment.

## 3. Install GrapheneOS only when needed

Skip this section if your intended OS is already installed and verified. Otherwise,
confirm that this exact phone may be erased and preserve supported data backups and
account recovery first. Use the installation preparation linked from the
[operator guide](../guides/source/markdown/operator-en.md#4-install-grapheneos-as-a-separate-destructive-phase),
including OEM unlocking when required. Manually enter Fastboot Mode and compare
the physical target again. Leave bootloader unlock and relock to the reviewed pxv
operation.

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Review the returned plan ID, exact target, codename, release, image/signature
identity, erasure scope and expiry. A dry run prepares a plan without executing it.
To proceed interactively:

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
```

This prepares a fresh review; read it before confirming. Attend the physical
bootloader unlock and relock prompts. Keep the returned run ID and inspect it with
`pxv agent status --project-root "$P" --run OS_RUN_ID --after 0`, replacing
`OS_RUN_ID` with that ID. Do not deliberately disconnect or interrupt flashing.

At the re-enrollment/setup pause, finish initial phone setup, authorize USB debugging
again and reconfirm the existing enrollment with `device inspect`. Verify the OS
and locked bootloader through the reported checks and phone prompts. Prepare a new
provisioning plan next; do not flash again to advance this pause or enroll the same
unchanged handset twice. Flashing can stale registry bindings even if it fails.

## 4. Review and run provisioning

Provisioning prepares the policy's profiles, apps, settings and configuration steps.
OS installation remains a separate operation.

```sh
pxv device provision --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Inspect the target, every action, shared-package effects, stable Android user
identities, manual gates and expiry. Then start interactive provisioning:

```sh
pxv device provision --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
```

Read its newly prepared review before confirming. Save the returned run ID:

```sh
RUN='REPLACE_WITH_PROVISIONING_RUN_ID'
pxv agent status --project-root "$P" --run "$RUN" --after 0
```

Read status, `pauseReason` and the next gate. For later status requests, use the
last event cursor to read new events. A pending run still needs work; process exit
alone does not establish readiness. Use `pxv COMMAND --help` for supported flags.
`--yes` confirms your review or physical check; it does not perform either.

If a review expires, `pxv agent refresh --project-root "$P" --run "$RUN"` prepares
remaining work for a new review. Review and submit its new plan with the exact
review-file procedure in [automation](AUTOMATION.md). Refresh is not recovery for
an uncertain interrupted mutation.

## 5. Complete private checkpoints yourself

Work through the named pause in the correct profile. Follow this order:

1. Complete app sign-ins, imports, MFA and Android consent privately. Configure each
   required VPN in its own profile and check its connection before always-on VPN
   or blocking connections without VPN is enforced.
2. Set or verify the ordinary lock in every intended profile. Privately try an
   ordinary lock/unlock with the correct credential, including any initial value
   you retained or replaced.
3. Apply and verify the final language in each profile.
4. If your policy includes GrapheneOS duress, complete it only after ordinary locks
   and language. Both duress values must differ from every actual ordinary profile
   credential. Never enter a duress value for ordinary authentication or activate
   erasure as a test.

For an `app_setup` gate, complete its actual work before recording and resuming:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check app_setup --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run "$RUN"
```

Use the gate actually requested by your run; do not attest `app_setup` if it is not
required. Separate profile gates require separate fresh confirmations. A
`language:PROFILE` pause is completed on the phone and then resumed; do not invent
a language attestation. Read status after resuming and repeat for the next gate.

Unsupported automation requires completing the named work manually through a
private method. If you choose initial credential defaults, follow the
[operator instructions](../guides/source/markdown/operator-en.md#5-prepare-review-and-submit-provisioning)
for private files and current Owner authentication. Defaults initialize a profile
without a lock; they are not a password-change mechanism or proof of a working
unlock. Keep secrets out of shell arguments, screenshots and public logs.

If you use an Oblivion notification-wipe key, keep it separate from GrapheneOS
duress values. Its whole-phone wipe behavior is user-described and unqualified for
an exact app/build here. Never send a real key in a notification as a setup or
acceptance test. See the [recipient guide](../guides/source/markdown/user-en.md#5-distinguish-session-oblivion-and-duress).

## 6. Check and accept your own phone

Read the policy's current requirements and stored readiness:

```sh
pxv guide project --project-root "$P" --kind pixel --locale en
pxv device report --project-root "$P" --asset "$ASSET"
```

`device report` reads stored evidence; it is not a fresh device inspection. Perform
the actual required checks, including reboot persistence, locks, profile separation
where applicable, apps, permissions, language, expected network behavior and any
required representative restore. A network helper covers its own UID and reviewed
endpoints, not all app traffic. Record only checks you performed:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check REQUIRED_CHECK --operator "$OPERATOR"
```

Replace `REQUIRED_CHECK` with each applicable check. If a required check remains
unperformed or fails, the phone is not ready for acceptance. Being your own operator
does not waive policy requirements or let a receipt override contradictory
measurements.

After completing the other requirements, accept the phone as its user, then sign
off as its operator and finalize. Use your own name in both roles:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check recipient_acceptance --operator "$OPERATOR"
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check operator_signoff --operator "$OPERATOR"
pxv device finalize --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR" --locale en
```

Signoff and finalization use fresh measurements. Finish within the evidence window
reported by the application; resolve stale evidence, drift, helpers or cleanup
before proceeding.

After finalization, physically verify **USB debugging and Wireless debugging are
both off**, the bootloader remains locked and OEM unlocking is off. Confirm that
you hold the phone for daily use. Then record custody under your own name and
export the accepted report:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient "$OPERATOR" --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output "$P/handoff"
```

The command retains its handoff terminology: for you, it records completion of
preparation and your custody for everyday use. It is separate from the earlier
acceptance attestation. Retain the report with dated notes on actual profile
purposes, checks, backup coverage and unresolved limitations. General guides and
generated policy instructions do not certify this phone.

Keep the [quick start](../guides/source/markdown/quickstart-en.md) available for
daily reference. If you use the [private credential insert](../guides/source/markdown/credentials-en.md),
complete it privately, match the asset label and store it securely apart from the
phone. Keep optional destructive credentials on their separate sealed sheet. Fill
recovery routes you can use yourself without this phone, rather than assuming a
separate operator will retain access for you.

## 7. Use profiles and keep recoverable data

With only Owner, stay in that profile. With several profiles, use the Android user
switcher to select the intended environment and learn how to lock and end a
secondary-user session on your installed build. Keep each activity, account and app
data in its intended profile. Installing an app in several profiles does not sign
them into an account automatically.

App package versions are shared across the phone; profile data and many settings
are separate. Updates and package removal can affect several profiles. Android user
numbers and names can be reused after deletion; a recreated profile does not inherit
the old stable identity or acceptance evidence.

Document backup coverage and exclusions for each profile and important app. Use
supported OS/app backup, export and account-recovery methods. Do not assume Owner's
backup includes every profile. Keep recovery material accessible if the phone, its
number or its MFA becomes unavailable, and back up workstation project state
separately from phone data.

A success notification or enabled backup setting is not a demonstrated restore.
Perform any required representative restore on an authorized separate test device;
never erase the primary phone, delete a profile or unlock its bootloader just to
test a backup. Community disables experimental Seedvault automation; manual
backup/restore remains a separately checked procedure. See
[backup and recovery](CANARY_BACKUP_RECOVERY.md).

## 8. Optionally retain your own encrypted credential record

You can use the [local encrypted registry](PHONE_REGISTRY.md) for your own
last-confirmed phone/profile credentials and account records. Choose what to retain
and protect its unlock passphrase separately from its encrypted database. The
registry works offline; it neither reads live credentials nor configures accounts.

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file /absolute/private/path/to/phone-record.json --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Prepare the complete input using the registry reference, in an owned `0600` file
inside a `0700` directory. Revision zero is for the first record only; subsequent
updates use the revision reported by `show` and replace the complete current record.
Prior revisions remain encrypted history. Unlock uses a hidden local prompt.

`current` means last explicitly confirmed by you, not continuously measured.
Update retained values privately after changing them on the phone. Flashing,
profile changes and lifecycle events can stale bindings. Ordinary views omit values;
`reveal` deliberately writes plaintext that needs protection and cleanup. Follow
the registry's backup and reconciliation procedure after restoring project state;
old credentials and approvals are not proof of current readiness.

## 9. Handle interruptions and later maintenance

For a normal pending checkpoint, complete the named work and resume. On failure,
cancellation, lost host or `needs-inspection`, stop further mutations and inspect
the phone, run evidence and owned cleanup first:

```sh
pxv agent status --project-root "$P" --run "$RUN" --after 0
pxv device recover --project-root "$P" --asset "$ASSET"
```

Use the affected run ID, including the OS run ID if installation was interrupted.
If cancellation is needed, `pxv agent cancel --project-root "$P" --run "$RUN"`
requests it; this does not prove cleanup finished. After actual inspection and
cleanup, acknowledge recovery using the original operation ID named in retained
evidence:

```sh
pxv device recover --project-root "$P" --asset "$ASSET" \
  --run ORIGINAL_OPERATION_ID --inspected
```

Never delete SQLite state, locks, fences or receipts to force a retry. Never target
cleanup at a recreated profile just because its user number or name matches. Some
native cleanup requires a host restart and inspected recovery. Follow the
[recovery runbook](CANARY_BACKUP_RECOVERY.md) before a new review.

Record maintenance before making preparation changes:

```sh
pxv lifecycle maintenance --project-root "$P" --asset "$ASSET" \
  --operator "$OPERATOR" --note 'Reviewing phone configuration before maintenance'
```

Use `lifecycle policy-change`, `loss` or `retirement` for the applicable event, with
the same asset, operator and a non-secret note. These events invalidate earlier
handoff evidence; a new deployment needs fresh review, checks and acceptance. Use
`--erased` only after erasure was actually confirmed. For a lost phone, use your
independent recovery access and review affected service accounts; a registry record
cannot recover the handset.

After maintenance, check both debugging switches are off again, update retained
credentials and keep the new accepted report where required. Use the
[command reference](COMMAND_REFERENCE.md),
[operator guide](../guides/source/markdown/operator-en.md) and
[security boundaries](../SECURITY.md) for detailed procedures.
