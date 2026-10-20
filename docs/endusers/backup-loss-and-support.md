# Backups, loss, and support

Agree a recovery plan before important data depends on this phone. Record what is
covered in each profile, where the backups live, how recovery is unlocked, who can
help, and what remains excluded.

## Keep recovery available without the phone

Use the exact OS/app-supported backup or export method agreed with the operator.
Do not assume the Owner backup includes every secondary profile or every app.
Hardware-backed keys, account activation, MFA, and private files may need separate
recovery methods. Keep the required account/recovery access available if the phone,
its number, or its MFA is unavailable.

A backup-enabled setting, copied files, or a success notification does not prove
restorability. Ask which representative restore was actually demonstrated and
on what authorized target. Never erase the primary phone, unlock its bootloader,
or delete a profile merely to test a backup. Follow the agreed exclusions.

## Understand optional support retention

With your authorization, the operator may retain last-confirmed credentials in a
local encrypted registry. Agree the retained fields, authorized readers, update
process, encrypted backup handling, and private export/copy handling.

The record can contain phone identity, phone numbers, GrapheneOS duress values,
profile ordinary credentials, Oblivion keys, Session IDs, Proton VPN accounts,
stable Android user identities, and encrypted historical revisions. You should
know which of these are actually retained for your phone.

`current` means last explicitly confirmed by the operator, not live verification.
Phone changes do not synchronize automatically. Initial/unknown/stale values must
not be mistaken for proven access. Flashing, profile changes, some credential
initialization, and lifecycle events can invalidate saved bindings. Older values
remain in encrypted history; an update does not remove that history.

Ordinary reports omit registry values. Explicit private retrieval and populated
inserts create plaintext files requiring protection and cleanup. The operator can
rotate the registry passphrase, but older backups still require their original
passphrase. There is no registry password-reset or escrow service.

After changing a retained credential/account, use the agreed private update process.
Never put the update into an ordinary ticket, AI prompt, screenshot, or public log.
See the [operator registry reference](../operators/registry.md) for exact behavior.

## Loss, repair, or transfer

If the phone is lost, use the agreed loss procedure and review affected service
accounts through their supported recovery channels. A registry entry does not
recover a missing device. Intentional erasure has its own agreed authorization
process; do not send a wipe key or try a duress value during ordinary troubleshooting.

Before repair, reset, OS reinstallation, profile deletion, or transfer to another
person, contact the operator and review backup coverage. These changes can invalidate
the prior handoff and require renewed identity checks, configuration review, private
credential verification, and recipient acceptance.

During supervised maintenance, the operator may temporarily enable debugging.
Before resuming normal use, verify both debugging switches are off, review changed
ordinary credentials and registry records privately, and receive the updated
handoff evidence where required. Keep private inserts apart from the phone and
destructive sheets separately protected.
