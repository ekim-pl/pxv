# Prepare one device

Follow this path for one enrolled Pixel, whether it has only Owner or several
Android profiles. If you also use the phone, act as both operator and recipient:
perform the recipient’s private checks and record custody separately from operator
signoff. A profile layout does not determine how many phones a project contains.

Examples use synthetic `phone-01` and placeholder physical identities. Replace
paths, names, serial, model, and codename with observed or approved values. Keep
the project outside the source/resource checkout and use the same project and
operator control directory throughout.

## Prepare the host and project

Install a reviewed Linux x86_64 distribution and follow [host setup](host-setup.md).
Use the ordinary operator account with the required USB permissions. Host doctor
inspects prerequisites; starting ADB is a separate explicit action.

`project init` requires complete app pins. If your source policy omits them, first
follow [standalone source resolution](policy-reference.md#resolve-a-source-draft-before-project-initialization)
with the intended SDK/ABIs, then pass the resulting pinned file to initialization.
A source-only draft cannot be enrolled or provisioned as a normal project policy.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
P='/absolute/private/single-phone'
ASSET='phone-01'
OPERATOR='Operator name'
pxv project init --path "$P" --policy /absolute/private/reviewed-policy.json
pxv policy validate --project-root "$P"
```

Expected result: a distinct project with copied/validated policy, its initial lock,
and an empty inventory. Project initialization does not flash a phone.

Choose the required profiles and customize the policy **before device work**.
Starter packs are structural templates. Supply reviewed app sources, content and
signer pins, exact OS pins for the intended model, configuration requirements,
languages, VPN behavior, and acceptance checks. Follow the
[policy reference](policy-reference.md) for the complete format.

Optional project `insertMetadata` supplies a display name and real support contact
for printed inserts; preserve the other fields in `pxv.project.json`. Policy,
extension, and metadata edits need validation, a renewed lock, and fresh reviews:

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
```

## Enroll and inspect the physical phone

Privately unlock the phone and authorize the intended USB debugging host when
using ADB. Compare the phone’s physical label and observed serial/model/codename.

```sh
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial OBSERVED_SERIAL --model 'OBSERVED_PIXEL_MODEL' \
  --codename OBSERVED_CODENAME --transport usb
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
```

For enrollment while already in Fastboot Mode, add `--mode fastboot`; defer the
ADB inspection until Android boots and debugging is authorized. First enrollment
uses USB, not an assumed Wi-Fi endpoint. Enrollment verifies identity and records
inventory; it does not authorize erasure. See [host transports](host-setup.md).

## Resolve or update app pins before planning

Use `policy resolve-apps` to fill missing pins and verify supplied ones. Use
`policy update-apps` to upgrade complete pins from already trusted F-Droid
repositories. For an existing enrolled phone running the intended Android release:

```sh
pxv policy resolve-apps --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv policy resolve-apps --project-root "$P" --asset "$ASSET" --transport usb
```

For a planned repository upgrade, use this pair instead:

```sh
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
```

Each write invocation presents a fresh review before confirmation. Both commands
leave the existing lock unchanged; run validation and locking after any policy
write, including resolution. With no connected phone or when targeting a different
Android release, replace `--asset`/`--transport` with the intended `--sdk N --abi ABI`
pair. Discovery still needs network access for remote sources.

Read all skipped update reasons and any verification errors. A direct source's
first observed signer needs review; supplied pins are never overwritten by
resolution. Check recipes bound to exact app versions, qualify changes on a canary,
and prepare a fresh device plan after locking. See the
[policy command choices](policy-reference.md#choose-the-policy-command).

## Install the OS only when required

Skip this phase only when the intended installed OS is verified. Before erasure,
agree authorization and backup scope and read
[backup and recovery](recovery-and-maintenance.md). Prepare OEM unlocking as
required by the approved installation procedure and manually enter Fastboot Mode.
PXV does not automatically reboot an ADB phone into fastboot for you.

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Read the target, codename, release, image/signature identity, destructive actions,
and review expiry. For interactive execution, the next command prepares a fresh
review that you must inspect before confirming:

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run OS_RUN_ID --after 0
```

Attend the physical unlock/relock confirmations. Direct USB is required; host-ADB
Docker cannot flash. Keep the run ID. After the re-enrollment pause, finish initial
Android setup, authorize debugging, and inspect the existing enrollment again.
Do not repeat flashing to advance the pause or duplicate the same handset’s
inventory entry. Prepare a new provisioning plan after setup.

## Review and run provisioning

Provisioning handles profiles, apps, settings, permissions, and configuration.
It does not silently install the OS.

```sh
pxv device provision --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv device provision --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run RUN_ID --after 0
```

Review each command’s prepared plan, shared-package effects, stable Android user
identity, artifacts, manual gates, and expiry. The dry run does not approve the
subsequent interactive review. To execute the retained exact plan instead, use
the [review-file automation procedure](../ai-agents/cli-automation.md).

Track returned run IDs and retain the last event sequence for subsequent status
reads. Exit 4 means pending work; inspect the result instead of retrying blindly.
For `inspection` or uncertain mutation, follow
[inspected recovery](recovery-and-maintenance.md#recover-an-interrupted-pxv-operation).

## Complete the named checkpoints

Follow the run’s actual `pauseReason` and instructions in the named profile:

1. Complete required app accounts, imports, MFA, and Android consent privately.
   Unsupported recipes remain assisted work; attest only an actual requested check.
2. At each profile’s `vpn_settings` pause, inspect Android VPN Settings and witness
   the reviewed app, Always-on VPN, and Block connections without VPN state.
   Disabled and already-matching profiles also require their own witness.
3. Privately verify or replace ordinary credentials in every profile, then confirm
   the language. Follow `normal_credentials` and `language:PROFILE` instructions.
4. Complete optional Owner duress setup after ordinary credentials and language.
   Duress values must differ from all ordinary credentials. Never activate erasure.

For a requested VPN witness:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check vpn_settings --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run RUN_ID
```

Repeat only when the next profile’s checkpoint requests it. A language pause is
completed on the phone and resumed; do not invent a language attestation. Read
[network evidence](policy-reference.md#network-policies-and-evidence) and
[credential initialization](policy-reference.md#initial-screen-locks-language-and-duress).
Initial defaults are for eligible empty locks, not later password changes.

If the ordinary Owner credential changes before automatic duress setup, privately
update its `ownerCredentialRef` input to the current ordinary credential. The
encrypted support registry is a separate record and does not provide this input.

Only intentional manual pauses resume. An expired review at that pause can use
`agent refresh` to prepare unfinished work for a fresh exact review and execution.
Re-enrollment, acceptance, and inspection pauses have their own next steps; see
[workflow recovery](../ai-agents/workflow-and-recovery.md).

## Optionally retain support data

With the recipient’s agreement, initialize the [encrypted registry](registry.md)
and privately record confirmed fields and stable profile identities. Optional
Oblivion, Session ID, and SIM collectors run before finalization/debugging shutdown.
They require private unlocking and explicit retention confirmation. Keep values
out of commands, notes, logs, general guides, and MCP.

## Accept, finalize, and record custody

Read readiness and the installation-specific requirements:

```sh
pxv device report --project-root "$P" --asset "$ASSET"
pxv guide project --project-root "$P" --kind pixel --locale en
```

Perform the [acceptance checks](acceptance.md) on this phone: every profile,
ordinary unlock, app/account behavior, network requirements, reboot persistence,
and agreed backup/restore scope. Record required actual checks before the final
recipient acceptance and fresh operator signoff:

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check recipient_acceptance --operator "$OPERATOR"
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check operator_signoff --operator "$OPERATOR"
pxv device finalize --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR" --locale en
```

Stay within the application’s measurement freshness window. Stale measurements,
drift, incomplete work, or cleanup obligations block readiness. Physically verify
USB and Wireless debugging are both off, the bootloader remains locked, and OEM
unlocking is off. After the recipient takes custody:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient 'Recipient name' --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output /absolute/private/phone-01-handoff
```

## Finish the device packet

Follow [guide generation and inserts](guides-and-inserts.md) to supply a policy-based
quick start, this phone’s accepted report and dated notes, privately completed
credential/recovery material, and a matching asset label. Registry exports work
offline after debugging is off; their presence does not certify readiness.

Review [receiving your phone](../endusers/receiving-your-phone.md) with the recipient,
especially [ordinary and duress credentials](../endusers/pins-passwords-and-duress.md).
The path is complete when this phone’s checks, custody, and packet all match.
