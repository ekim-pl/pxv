# Prepare a fleet

A fleet project contains independently enrolled phones under one reviewed policy.
Use this path after understanding the [single-device workflow](single-device.md).
Fleet execution is local, with bounded concurrency and per-phone retained state;
it does not provide remote MDM or cross-workstation locking.

## Set up the project and batch

Use one private project when the phones share the intended policy. A policy may
describe multiple profiles and map several Pixel codenames to exact OS pins.
Create separate projects when the intended app/profile configuration, policy
ownership, product identity, or support boundaries require distinct policies.
Do not clone another project’s UUID, database, approvals, credentials, or evidence.

```sh
P='/absolute/private/fleet'
OPERATOR='Operator name'
pxv project init --path "$P" --policy /absolute/private/reviewed-fleet-policy.json
pxv policy validate --project-root "$P"
pxv host doctor
pxv host adb-start --yes
```

Review app pins, shared-package effects, per-model OS images, and support metadata
using the [policy reference](policy-reference.md). Policy or metadata changes need
a renewed lock and fresh operational reviews.

Enroll each physical phone separately, matching its label and observed identity:

```sh
pxv inventory enroll --project-root "$P" --asset batch-01 --group delivery-a \
  --serial OBSERVED_SERIAL_01 --model 'OBSERVED_MODEL_01' --codename OBSERVED_CODE_01
pxv inventory enroll --project-root "$P" --asset batch-02 --group delivery-a \
  --serial OBSERVED_SERIAL_02 --model 'OBSERVED_MODEL_02' --codename OBSERVED_CODE_02
pxv inventory enroll --project-root "$P" --asset batch-03 --group delivery-a \
  --serial OBSERVED_SERIAL_03 --model 'OBSERVED_MODEL_03' --codename OBSERVED_CODE_03
pxv inventory list --project-root "$P"
```

Use fastboot enrollment only for a phone already in that mode. Do not enroll an
unverified Wi-Fi endpoint or interpret a matching display name as physical identity.

## Qualify the canary

Select one authorized disposable phone and complete the single-device path for the
exact candidate, policy, apps, models, and required capabilities. Retain
[physical acceptance evidence](acceptance.md) and demonstrate representative
recovery before scaling. More than one model/build may need its own checks.

Install the OS as a separate reviewed destructive phase for each required target.
Attend every bootloader prompt and post-flash setup. A primary phone’s private
backup is not a fleet seed, and a canary’s checks do not supply recipient acceptance
or credentials for the other phones.

## Select and review batch work

Choose exactly one selector: `--asset ID`, `--group GROUP`, or explicit `--all`.
There is no implicit wildcard; `--asset all` selects an asset literally named
`all`. `--jobs` accepts 1–8. Begin with one job, increasing only when you can attend
the physical prompts and independently track all selected phones.

```sh
pxv fleet provision --project-root "$P" --group delivery-a --jobs 1 --dry-run
pxv fleet provision --project-root "$P" --group delivery-a --jobs 2 --operator "$OPERATOR"
```

The second command prepares fresh plans. Inspect every displayed review before
accepting. A previous dry-run review does not approve them. Keep an asset-to-run
mapping in a value-free private work record. Review each target, OS/app identity,
cross-profile APK effects, expiry, and assisted checkpoints.

## Continue each phone independently

This example is a work-record illustration, not a completed test:

| Asset | Observed result | Next action |
| --- | --- | --- |
| `batch-01` | Provisioning complete; acceptance pending | Perform its own acceptance and fresh signoff; finalize and record custody when ready. |
| `batch-02` | `manual-step` at `vpn_settings` | Witness the named profile’s VPN settings, attest that check for `batch-02`, and resume its run. |
| `batch-03` | Inspection required after interrupted mutation | Stop mutation for this asset, inspect retained obligations, and recover using its original operation ID. |

```sh
pxv agent status --project-root "$P" --run BATCH_02_RUN --after 0
pxv device attest --project-root "$P" --asset batch-02 \
  --check vpn_settings --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run BATCH_02_RUN
pxv device recover --project-root "$P" --asset batch-03
```

For `batch-03`, follow [inspected recovery](recovery-and-maintenance.md#recover-an-interrupted-pxv-operation)
before acknowledging cleanup. Use the original operation ID reported by evidence;
do not replace it with an unrelated batch/run identifier. Recovery does not replay
an interrupted flash. Prepare new reviewed work only after obligations permit it.

Resume a paused run instead of restarting provisioning across successful devices.
An expired intentional manual pause needs a refreshed exact review. Re-enrollment,
acceptance, and inspection have different next steps. Inspect exit 4 as pending,
3 as failed/inspection-required, and 130 as cancellation. Cancellation does not
prove cleanup; a successful phone never satisfies another phone’s gates.

## Accept and export one asset at a time

For each phone, complete private checkpoints and optional authorized registry
collection before debugging shutdown. Attestation, finalization, recovery, custody,
and private exports use one exact asset. Follow the
[single-device acceptance commands](single-device.md#accept-finalize-and-record-custody)
with that asset and its actual recipient. Keep the measurement window fresh.

## Generate packets and close the batch

Build [shared project guide editions](guides-and-inserts.md#build-project-guide-editions)
once for a fixed policy/support metadata set. Choose each recipient’s language.
Repeat the private export/packing procedure for **every asset**, using unique
destinations and the latest reviewed registry state. Rebuild when the policy or
metadata changes; do not apply another project’s booklet to a different layout.

Use [the full packing checklist](guides-and-inserts.md#packing-checklist-for-every-device)
and track the following per asset:

- Physical phone and inventory label match; all required checks are complete.
- Accepted handoff and dated actual-device notes are present.
- Correct policy/language quick start is present.
- Blank privately completed or registry-backed inserts match the phone; destructive sheets are sealed separately.
- Label, report, ordinary insert, destructive material, and recipient identity match.
- Custody is recorded and the recipient knows how to store private material apart from the phone.

Deliver completed assets independently. Keep pending/failed phones and their
unresolved requirements visible in the work record; do not mark the batch accepted
because a subset succeeded.
