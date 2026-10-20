# Local encrypted phone registry

The registry retains last-confirmed current phone and profile credentials for one
operator/workstation. Each project has one encrypted database at
`secrets/phone-registry.pxv`, joined to its enrolled inventory by asset ID, canonical
hardware serial and Pixel codename. It does not replace the ordinary workflow
SQLite database. Registry commands work offline and do not contact a phone.

<a id="opt-in-oblivion-key-collection"></a>

## Opt-in pre-handoff collection

After provisioning and private app setup, initialize the registry and optionally
run any of these independent commands before final signoff and debugging shutdown:

```sh
pxv registry init --project-root DIRECTORY
pxv device collect-oblivion --project-root DIRECTORY --asset PHONE
pxv device collect-sessionid --project-root DIRECTORY --asset PHONE
pxv device collect-simcards --project-root DIRECTORY --asset PHONE
```

Run `registry init` only when creating a new registry. Each collector requires one
exact enrolled Pixel, local host execution and interactive confirmations. All three
accept `--transport usb|wifi`, `--passphrase-file PRIVATE_FILE`, `--yes` and `--json`.
Start the configured ADB server explicitly first. Fleet selectors and Docker are
refused. Collection is optional; finalization does not require it.

`collect-oblivion` visits enrolled profiles with `net.oblivion.wipe`, the separate
emergency-wipe app rather than the starter policies' `org.bepass.oblivion`. It
verifies the app signer, opens the QR dialog and compares its visible key text with
the main screen. Opening Oblivion can enable its wipe triggers: complete private
setup and deliberately confirm opening it. Collection never sends a key or tests
erasure.

`collect-sessionid` visits enrolled profiles with `network.loki.messenger`, verifies
the signer pinned for the Session repository build, opens user settings and reads
the account's own ID. It does not read recovery passwords or contact IDs. Both app
collectors check the retained stable Android identities against the live phone,
visit profiles sequentially and ask for private unlocking. They do not install apps,
create accounts or bypass app locks and Android consent.

`collect-simcards` inspects the current physical SIM/eSIM subscription list once
for the device and excludes historical subscriptions. Numbers are stored once in
the device's `phoneNumber` field, one per line. Masked or missing numbers require
private entry or an explicit skip; unsupported subscription inspection permits a
privately supplied number list. No country code is inferred. Retention confirmation
replaces the complete saved device number list with the collected numbers, including
when some current lines were skipped. Review that choice before confirming.

Unsupported app screens offer hidden manual entry or an explicit skip. Invalid
input is rejected without echoing it. Empty private input skips a value; interrupting
collection cancels saving. Unexpected device/profile/app identities, changed app
versions or failed foreground restoration prevent saving. `--yes` cannot bypass
unlock or retention confirmations. No screenshot, clipboard transfer, message or
test notification is used.

All collectors show a value-free review and use the same JSON summary contract:
`collector` (`oblivion`, `sessionid` or `simcards`), `assetId`, `outcomes`, `saved`,
`revision` and `recordRevision`. Outcomes identify a profile or device/SIM slot and
have status `collected`, `not-present`, `unavailable` or `skipped`. JSON goes to
stdout; progress and review go to stderr. Values never appear in either stream.

Each invocation atomically merges only captured fields, marked `current` after
explicit confirmation. Missing phone/profile records are created as needed.
Uncollected fields and their confirmation dates remain intact; invalid bindings
remain stale. Encrypted history is retained. If nothing is collected, ciphertext
and revisions are unchanged. Raw UI hierarchies, account IDs and numbers are not stored
in ordinary SQLite, logs, handoff reports or MCP responses. `--passphrase-file`
uses the same private-file rules as registry commands.

For app collection, the original foreground profile is restored and verified before
saving. On failed restoration or process loss, retain the operation ID and use
`device recover --asset PHONE --run OPERATION_ID --inspected`. Existing Oblivion
recovery obligations remain supported. Inspect the registry before retrying an
interrupted commit. A retained current value is the operator's last confirmation,
not continuous verification of the phone.

## Operator flow

Use the same `--project-root DIRECTORY` on every command below. First enroll the
phones in inventory, then initialize the registry:

```sh
pxv registry init --project-root DIRECTORY
pxv registry list --project-root DIRECTORY
```

Unlock uses a hidden local terminal prompt. Initialization asks twice. For local
automation, `--passphrase-file PRIVATE_FILE` reads the passphrase from a current-user
owned file with mode `0600` in a directory with mode `0700`. One trailing line ending
is removed; other whitespace is preserved. Passphrases must contain 12–1024 UTF-8
bytes. Use a strong unique passphrase and retain it separately from the database.
Passphrase values are never command arguments or environment options.

Prepare a private JSON record in a `0700` directory, with the file mode set to
`0600` (maximum input size 2 MiB). This deliberately synthetic example uses policy profile `admin`; replace
its identity with the actual stable Android user identity from device inspection:

```json
{
  "fields": {
    "duressPin": { "value": "12345678", "state": "initial" },
    "duressPassword": { "value": "example-only-duress-password", "state": "initial" },
    "phoneNumber": { "value": "+48000000000", "state": "unknown" }
  },
  "profiles": [
    {
      "profileId": "admin",
      "user": { "userId": 0, "serialNo": 0, "name": "Owner" },
      "fields": {
        "pin": { "value": "87654321", "state": "initial" },
        "oblivionNotificationWipeKey": { "value": "example-only-key", "state": "initial" },
        "sessionMessengerId": { "value": "example-only-messenger-id", "state": "initial" },
        "protonVpnUsername": { "value": "example-only-vpn-user", "state": "initial" },
        "protonVpnPassword": { "value": "example-only-vpn-password", "state": "initial" }
      }
    }
  ]
}
```

Profile fields also support `password` and `phoneNumber`. The owner profile must
use Android user ID zero; secondary profiles need their own user IDs and serial
numbers. Session messenger account IDs are separate from Android user IDs.
Phone-level `duressPin`/`duressPassword` are separate from the Oblivion key held by
each profile installation. Accounts can be recorded on several profiles; uniqueness
is not assumed. Optional `assetId`, `canonicalSerial` and `codename` must match the
selected inventory entry when supplied.

Input contains `fields` and `profiles`, plus the optional physical identity fields
above. When using a reveal file as the starting point, remove its top-level
`revision` and `generation`; use the shown revision in `--record-revision` instead.

Import the complete phone record, using revision zero for its first entry:

```sh
pxv registry update --project-root DIRECTORY --asset PHONE --file PRIVATE.json --record-revision 0
pxv registry show --project-root DIRECTORY --asset PHONE
pxv registry history --project-root DIRECTORY --asset PHONE
```

`show` reports the record revision needed for the next update. Every update is a
complete replacement of that phone's fields/profiles and retains the complete
previous revisions encrypted. Omitted fields remain accessible through history.
Stale revisions or concurrent writes are rejected. Review the private file before
using `--yes` for non-interactive confirmation.

Each value has a state: `initial`, `current`, `unknown`, or `stale`. Setting `current`
requires explicit operator confirmation; the registry stamps the confirmation time.
This means **last confirmed by the operator**, not measured from the phone. Private
changes made on the phone require an explicit registry update. Initial values never
automatically become current values.

## Private retrieval and key rotation

Ordinary list/show/history responses contain identity and field-presence/state
metadata. They exclude credentials, account IDs, telephone numbers and hardware
serials. To retrieve values, choose a new private output file:

```sh
pxv registry reveal --project-root DIRECTORY --asset PHONE --output PRIVATE_DIRECTORY/phone.json
pxv registry reveal --project-root DIRECTORY --asset PHONE --record-revision 1 --output PRIVATE_DIRECTORY/old-phone.json
pxv registry rekey --project-root DIRECTORY
```

The reveal file is intentionally plaintext, mode `0600`, inside a `0700` directory.
Choose a destination under the project's `secrets` directory or outside the project
and product resource checkout; public project/resource destinations are refused.
Existing files and symlinks are refused. Protect it and remove it when finished.
Historical values are marked stale on retrieval. Rekey asks for the current
passphrase and the new passphrase twice; automation may also use
`--new-passphrase-file PRIVATE_FILE`. Rekey replaces the encrypted database atomically
without deleting its history. Existing encrypted backups still need their original
passphrase. There is no password reset or escrow service.

Back up the encrypted database with the private project state and inventory, keeping
unlock material separately. A public ciphertext revision anchor in SQLite refuses
older copies and interrupted commits. To reconcile an intentional restore or a
pending commit, unlock the retained copy and explicitly confirm:

```sh
pxv registry reconcile --project-root DIRECTORY
```

Reconciliation appends stale revisions for every retained phone before accepting the
copy. Confirm each phone's current values through a new update afterward. If both
the encrypted database and its entire project state are rolled back together, this
offline system cannot detect that rollback; compare with separately retained backup
revision records and reconcile the restored copy before using it.

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
[project names and support contacts](../guides/README.md#project-names-and-support-contacts)
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

## Identity and security boundaries

Before an attempted flash, the engine durably invalidates the phone's registry
generation. Before creating a profile, it invalidates that profile's generation.
Credential-default writes invalidate their profile; device-wide duress-default
writes invalidate the phone. Accepted defaults skipped on repeat runs do not rotate
the generation again.
Lifecycle events also invalidate device bindings. A failed or interrupted operation
therefore leaves affected credentials stale. Rebinding requires a new private update
and confirmation; old values remain in encrypted history. Registry writes share the
project's native lease and recheck identity/generation before committing.
Known Android user identity changes in sufficiently fresh recorded workflow
observations also stale affected profile values. Registry commands do not inspect a
connected phone; unobserved changes remain unknown until a workflow records them or
the operator updates the registry.

The database uses Node's [authenticated AES-256-GCM implementation](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
random salts/nonces, and scrypt with `N=131072`, `r=8`, `p=1`, following the
[OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The authenticated envelope binds the project ID and fixed version/algorithm
parameters. Only ciphertext is written during database updates, with atomic
replacement and file/directory synchronization. Wrong passphrases, altered content,
unsafe file permissions, symlinks and cross-project copies fail closed. The database
is bounded to 16 MiB of plaintext, 1,000 phones and 10,000 retained updates; it refuses
overflow rather than deleting history.

Unlock material is held only for the command; temporary buffers are cleared on
completion. JavaScript strings and operating-system memory cannot be guaranteed
erased. The local OS/account remains trusted, and encrypted disk/backups protect
the surrounding workstation state.

Registry access does not configure accounts, change a phone's credentials, supply
provisioning defaults, send notifications, or activate erasure. Existing private
credential-default inputs remain a separate initialization mechanism. The claimed
Oblivion whole-phone notification wipe is user-described and still needs exact-app
qualification before any configuration automation can claim support. Registry
operations and acceptance tests must not send real wipe keys or activate erasure.
Registry values are excluded
from MCP, normal plans, logs and ordinary handoff exports. Only explicit private
registry retrieval and insert commands export saved values.
