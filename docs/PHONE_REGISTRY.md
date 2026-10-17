# Local encrypted phone registry

The registry retains last-confirmed current phone and profile credentials for one
operator/workstation. Each project has one encrypted database at
`secrets/phone-registry.pxv`, joined to its enrolled inventory by asset ID, canonical
hardware serial and Pixel codename. It does not replace the ordinary workflow
SQLite database. Registry commands work offline and do not contact a phone.

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
from MCP, normal plans, logs and handoff exports.
