# Generate guides and pack every device

Finish both the [single-device](single-device.md) and [fleet](fleet.md) paths here.
A complete packet combines the correct policy-based guide, the accepted report
for the actual phone, dated verification notes, private credential/recovery
material, and a matching label. General PDFs are instructions, not proof of
acceptance.

## Prepare the renderer and destinations

Guide rebuilding runs from a matching source checkout with Node **24.22.0**,
pnpm **12.11.2**, frozen dependencies, and the compiled packages. Follow the
[developer build](../developers/build.md). Installed releases include guide sources
but do not include the guide rebuilding workspace.

Select an installed local Chromium using `--chromium` or `PXV_CHROMIUM`. PDF
rendering/inspection uses Poppler: `pdfinfo`, `pdftotext`, `pdffonts`, `pdftoppm`,
and, for real-PDF regressions, `pdftohtml`. CSS page-margin-box support is needed
for repeating private-insert identities. The command does not download a browser.

Use one output directory for shared policy-based editions and a separate private
`0700` directory for each asset’s exports. Private outputs must be new files,
owned by the operator, with no symlinks or overwriting. The commands write `0600`
files. They permit project `secrets` or destinations outside project/product
resources. Keep populated PDFs out of shared guide output and source/release assets.

## Build project guide editions

Set project display metadata before the final policy lock/reviews. Preserve every
other field in the existing private `pxv.project.json`; this is an optional fragment:

```json
{
  "insertMetadata": {
    "projectName": "Example delivery",
    "support": {
      "name": "Device support",
      "email": "support@example.org"
    }
  }
}
```

Replace the synthetic contact with a real support route. A support override replaces
the complete product contact; it requires a name and at least one email, HTTPS URL,
or phone. Project name and support are independently optional, single-line values.
See [project metadata rules](../../guides/README.md#project-names-and-support-contacts).

From the source checkout, using the project’s already reviewed policy/metadata:

```sh
P='/absolute/private/example-project'
CHROMIUM='/absolute/path/to/chromium'
GUIDE_DIR='/absolute/private/print-builds/example-policy'
pnpm pxv guides rebuild --project-root "$P" --output-dir "$GUIDE_DIR" \
  --chromium "$CHROMIUM"
```

The command builds the renderer and generates both English and Polish editions:
operator/user HTML and office/bleed PDFs, plus A4 cut-and-fold quick starts and
blank credential inserts. Generated Markdown and QA artifacts record what was
rendered. Inspect all pages and the QA manifest before printing. The profile
appendix reflects intended profile names, roles, language, and declared configuration.

`--project-root` uses that project’s policy and selected display metadata without
opening its registry. Do not combine it with `--policy`. Alternatively, build from
an explicitly selected authoring policy with `--policy FILE --output-dir DIRECTORY`.
Policy/project builds require a separate destination outside authoritative guide
sources. `--html-only` creates HTML without PDF tooling; `--no-render` creates PDFs
without page images. An HTML-only build is not a reviewed printable packet.

Share these editions only among phones with the same intended policy and support
metadata; print the recipient’s chosen language. Build a different set for another
project policy. Guide language (`en`/`pl`) and Android profile locale are different
choices. Shared credential fields remain blank.

## Worked example for one asset

After the phone’s checks and custody are complete, export its accepted report and
prepare its private folder. Replace every absolute path with a chosen location:

```sh
ASSET='phone-01'
PRIVATE_DIR='/absolute/private/device-packets/phone-01'
install -d -m 700 "$PRIVATE_DIR"
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale en --output "$PRIVATE_DIR/handoff"
pxv registry print-insert --project-root "$P" --asset "$ASSET" \
  --output "$PRIVATE_DIR/insert.pdf" --locale en --chromium "$CHROMIUM"
pxv inventory print-label --project-root "$P" --asset "$ASSET" \
  --output "$PRIVATE_DIR/label" --locale en --chromium "$CHROMIUM"
```

`print-insert` requires an initialized, authorized registry record; use the
[registry procedure](registry.md) first. If no registry retention is agreed, print
the blank policy-generated insert and complete it privately with the recipient.
A label requires inventory, not a registry unlock. These exports do not contact the
phone and can run after debugging shutdown. Review saved value states rather than
assuming retained values are current.

For the same populated insert during guide rebuilding, use a **new** private PDF
name and separate shared output directory:

```sh
pnpm pxv guides rebuild --project-root "$P" --asset "$ASSET" \
  --output-dir /absolute/private/print-builds/example-policy-new \
  --private-insert-output "$PRIVATE_DIR/combined-insert.pdf" \
  --locale en --chromium "$CHROMIUM"
```

This mode requires explicit project, asset, output directory, and PDF-capable
Chromium; `--policy` and `--html-only` are rejected. The publishing subprocess
receives only policy and selected display metadata. Registry values remain in the
separate private export path.

## Choose the printed items

| Item | Source and scope | Format and handling |
| --- | --- | --- |
| Quick start and blank sheets | Project/policy guide build; reusable for matching phones | A4 cut-and-fold, 68 × 100 mm panels; choose EN/PL. |
| Accepted report | `handoff export` for one asset | Markdown/HTML retained policy snapshot; review before sharing. |
| Populated insert | `registry print-insert` for one asset | All saved current-record values; ordinary and destructive sections on separate A4 sheets, with overflow. |
| Optional compact cards | `registry print-card` for one asset | Native 68 × 100 mm PDF pages; destructive credentials, numbers, Session IDs and Oblivion keys; excludes ordinary unlock/VPN credentials. |
| Asset sticker | `inventory print-label` for one asset | 40 × 15 mm PDF plus 300 DPI PNG; asset, hardware serial, and month. |

## Device box cards and asset stickers

Generate an exact-size card from the latest saved record for one enrolled phone:

```sh
pxv registry print-card --project-root DIRECTORY --asset PHONE \
  --output PRIVATE_DIRECTORY/card.pdf --locale en --chromium /absolute/path/to/chromium
```

Each PDF page is **68 × 100 mm**, ready for printing at **100% / actual size**.
The generator targets one card and adds cards when the contents need more space.
It includes the canonical hardware serial, device duress PIN/password, device and
profile phone numbers, every profile's Session ID and Oblivion notification-wipe
key. Ordinary unlock and Proton VPN credentials are omitted. Profile identity,
effective credential states, update/confirmation times, destructive-use warnings,
and missing-value notices remain visible. Identical metadata is shared across
consecutive fields in the same profile. Continuation cards repeat the phone serial
and relevant profile/field identity, with card numbering. Long values wrap and
continue without truncation or shrinking the credential font.

This command uses the same hidden unlock prompt or `--passphrase-file`, read-only
registry loading, project identity, revision-anchor and effective binding checks as
`registry print-insert`. It works offline without connecting to the phone.

Generate a small asset sticker directly from inventory, without a registry unlock:

```sh
pxv inventory print-label --project-root DIRECTORY --asset PHONE \
  --output PRIVATE_DIRECTORY/label --date 202610 --locale en \
  --chromium /absolute/path/to/chromium
```

The extensionless output basename creates **both** `label.pdf` and `label.png`.
The PDF contains one **40 × 15 mm** page with three lines: asset ID, canonical phone
serial, and date. The matching PNG is rasterized from that PDF at **300 DPI**
(473 × 178 pixels, with pixel rounding). `--date` accepts `YYYYMM` with month
`01`–`12`; omit it to use the machine's local generation month. Supply the original
month explicitly for a reproducible reprint. Poppler's `pdftoppm` is required on
PATH, or select it with `--pdftoppm /absolute/path/to/pdftoppm`. Oversized identities
are rejected instead of clipped, truncated or reduced below the fixed print font.

Both generators support `--locale en|pl` (English by default), require one exact
enrolled `--asset`, and run only on the local host. No handoff record is required.
Print the PDF at actual size, without fit-to-page. Output destinations follow the
private registry export rules: a new file under project `secrets` or outside the
project and product resources, a `0700` parent directory and `0600` files, with no
symlinks or overwriting. Sticker outputs are both rendered before publication;
failure to publish either removes any newly published partner without changing
existing files. Temporary HTML, PDFs and isolated browser profiles are removed
after success or failure. Only export metadata reaches the console. A fixed,
CSP-hashed layout script measures text; supplied values remain escaped text and
the renderer disables background networking.

These are separate commands; existing A4 cut-and-fold inserts and shared guide
rebuilds retain their current behavior.

## Prefilled private phone-sized insert

Export the latest saved record for one enrolled phone as a recipient PDF:

```sh
pxv registry print-insert --project-root DIRECTORY --asset PHONE \
  --output PRIVATE_DIRECTORY/insert.pdf --locale en --chromium /absolute/path/to/chromium
```

Use `--locale pl` for Polish; English is the default. Unlock uses the same hidden
prompt or `--passphrase-file` as other registry commands. A local Chromium executable with CSS page-margin-box support
is required (for repeating asset/profile headers); nothing is downloaded. The command works offline during preparation
and does not require an accepted handoff report or connect to a phone.

Guide rebuilding can also export a separate private insert from the same registry:

```sh
pxv guides rebuild --project-root DIRECTORY --asset PHONE \
  --output-dir PUBLIC_GUIDE_DIRECTORY \
  --private-insert-output PRIVATE_DIRECTORY/insert.pdf \
  --locale pl --chromium /absolute/path/to/chromium
```

This source-checkout command uses the selected project's policy. An explicit
`--project-root`, `--asset`, `--output-dir` and Chromium are required; do not combine
it with `--policy` or `--html-only`. English is the default private-insert locale;
`PXV_CHROMIUM` can supply the browser path. Unlock uses the same hidden prompt or
`--passphrase-file`. The PDF must be outside the shared guide output directory.
Both export paths use the same registry loading, binding checks and renderer.
Both use optional `insertMetadata` from the project's `pxv.project.json`: the project
name is printed when supplied, and a project support contact replaces the whole
product contact. Without a support override, the product contact is used. See
[project names and support contacts](../../guides/README.md#project-names-and-support-contacts)
for configuration, validation and the required policy-lock/review refresh after edits.
Shared guide HTML, Markdown, PDFs and QA artifacts remain blank templates, and the
publishing subprocess receives only the selected insert metadata in addition to the
project policy, with no registry values or passphrase. Blank credential editions
include the project name and support contact; credentials stay blank. Insert export is
offline and can run after debugging has been disabled.

The PDF includes **all saved values in the latest record**, including ordinary unlocks,
phone numbers, Session IDs, Proton VPN accounts, device duress credentials and per-
profile Oblivion keys. Historical revisions are not supported. Values are grouped into
one section per profile, with identical effective state and update/confirmation metadata
shared within that section. Field-specific differences remain explicit; stale and
unknown values are prominently flagged. Current means last operator-confirmed, not
measured from the phone. Only recorded fields are printed; blank recipient, recovery and
backup worksheets are omitted. Profiles without ordinary values and destructive sections
without values are explicitly marked. Omitted fields are not recorded, which does not
mean unconfigured.

The phone's canonical hardware serial is printed in the device details of both
the ordinary and destructive sections, labeled in the selected language. It comes
from the saved registry record; it is distinct from an Android profile's user serial.

The output must be a new `.pdf` under project `secrets` or outside the project and
product resources, in a private `0700` directory. Files are `0600`; existing files
and symlinks are refused. Only the PDF is retained. Temporary HTML and the isolated
browser profile are removed after success or failure. Console output contains only
export metadata. The plaintext PDF remains sensitive: protect it and remove it when
finished, accounting for backups and printer queues.

Print landscape A4 at **100% / actual size, single-sided**. Check the 50 mm scale, cut
solid lines and fold dashed lines with printing inside to 68 × 100 mm. Stack slips by
number. The populated asset identifier appears once per A4 sheet; profile identity
repeats on continuation panels. Ordinary device/profile credentials come first, with
compact destructive credentials starting on a fresh sheet. Typical one- and five-profile
records target two sheets; long values or larger records use extra sheets without
truncation or smaller type. Values use 10 pt type; state/date metadata uses at least 8
pt. Keep destructive credential sheets detached and sealed separately from ordinary
credentials. Never test duress or send an Oblivion key as a test. Match the asset to the
phone and report, privately verify ordinary unlocks, and seal for the recipient. Store
the completed insert securely apart from the phone. The insert is an operator record and
does not certify readiness or erasure capability.

## Packing checklist for every device

1. Match the physical handset, asset ID, and hardware serial to the inventory,
   accepted report, label, and every private export. Use unique output names/folders
   per asset; never copy a previous phone’s private packet as a template.
2. Print the correct policy and recipient language. Inspect profile appendices and
   supply blank ordinary credential/recovery sheets for all configured profiles
   when using manual inserts. Add actual support and recovery routes privately.
3. Attach the accepted handoff report and dated notes describing actual profiles,
   installed apps, network/restore checks, and unresolved limitations. The general
   booklet and report do not enumerate every promised check.
4. Print at **100% / actual size**, without fit-to-page. Check the insert’s 50 mm
   scale. Use landscape A4, single-sided for cut-and-fold sheets, cut solid lines,
   fold dashed lines with text inside, and stack slips by number. Keep all overflow
   pages; never truncate values or shrink credentials to force a fit.
5. Privately verify ordinary unlock information with the recipient. Explain missing,
   initial, unknown, and stale values. Mark unused manual fields explicitly. Never
   activate duress or send a notification-wipe key as a test.
6. Detach destructive credential sheets, seal them separately, and match their asset
   identity before sealing the ordinary insert. If a feature is not configured,
   label the manual template accordingly. Optional compact cards are also sensitive.
7. Account for printer queues, spare copies, misprints, temporary files, and backups.
   Use a trusted local printer. Remove unneeded plaintext exports through the agreed
   private handling process; do not upload them with public documentation or QA.
8. Attach the matched packet to the device packaging, record actual custody, and
   teach the recipient to store private inserts securely apart from the phone.

For a fleet, repeat this checklist for each exact asset. Shared editions can be
reused; private inserts, labels, accepted reports, and custody records cannot.
Track packet completion separately from provisioning completion in the batch record.

If printing fails, retain existing outputs, diagnose Chromium/Poppler or destination
permissions, and choose new filenames for the retry. Check both label outputs and
all continuation pages before packing. A generated insert is a support record and
does not establish phone readiness, credential validity, or erasure qualification.
