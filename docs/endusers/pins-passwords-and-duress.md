# Ordinary PINs, passwords, and duress credentials

**Use only your ordinary profile PIN or password for normal unlocking and
authentication.** A configured duress credential is destructive. Never enter it
to test a lock, check an insert, demonstrate setup, or complete a support request.

## Know which value you are holding

| Value | Purpose and scope | Handling |
| --- | --- | --- |
| Ordinary profile PIN/password | Unlocks the intended Android profile | Verify privately with an ordinary lock/unlock; use for normal authentication. |
| GrapheneOS duress PIN/password | Device-wide destructive credentials configured through the Owner workflow | Keep distinct from every ordinary credential and separately protected. |
| Oblivion notification-wipe key | App-specific destructive secret associated with one profile’s app installation | Keep separate from GrapheneOS duress; never send it as a test notification or support message. |
| Session messenger ID | Identifies a messenger account | Confirm the intended profile/account before sharing; it is not an Android user ID or an unlock credential. |
| Recovery material | Regains supported account/data access | Keep an accessible protected copy outside the phone according to the agreed recovery plan. |

The insert’s phone hardware serial, Android user serial, profile name, phone number,
and messenger ID are different identifiers. Ask if a label is unclear.

## Complete setup in the required order

When preparation pauses for your private work:

1. Finish the named app setup, imports, MFA, and consent in the correct profile.
2. Set or verify ordinary screen locks in every intended profile. Privately replace
   supplied defaults when agreed, then check ordinary unlocking. If primary PIN
   scrambling is configured, privately confirm the requested keypad layout: shuffled
   when enabled and standard when disabled.
3. Confirm each profile’s final language.
4. Complete optional GrapheneOS duress setup only after ordinary locks and language
   are correct, following the supervised instructions for this build.

Both duress values must differ from every actual ordinary profile PIN/password,
including credentials you changed privately. If an Owner authentication prompt
appears during setup, it needs the current **ordinary** Owner credential. Never
substitute a duress value.

Initial defaults are initialization values. A command reporting success does not
prove your current unlock. Tell the operator a named check is complete without
disclosing the credential in public notes. If a changed value is retained for
authorized support, update it through the agreed private process.

## Understand the destructive consequences

GrapheneOS duress is a device-wide erasure feature, not an alternative ordinary
unlock. Treat its PIN and password as capable of destroying access to the phone’s
data. Do not assume another profile will preserve its data if duress is triggered.
Agree whether the feature is actually configured and what emergency process applies.

Oblivion is a separate app integration. The requested notification-triggered
whole-phone wipe behavior is user-described and is **not qualified by this project
for an exact app/build**. Its presence, a saved key, or an insert does not prove that
behavior. The operator must retain that limitation; never send a real key to
investigate it. Collecting or storing the key does not activate a wipe.

If you cannot tell whether a credential is ordinary or destructive, stop before
entering it. Keep the phone in its current state and contact the agreed operator
through a separate safe route. Explain the screen and asset/profile without sending
the secret. Do not guess, try each printed value, or use destructive activation as
a way to resolve uncertainty.

## Protect printed and retained values

Keep ordinary inserts securely apart from the phone. Detach and seal destructive
pages separately so they are not mistaken for ordinary unlock instructions. Check
asset identities when receiving multiple sheets or continuation cards.

Private registry-backed inserts contain saved values and confirmation states.
`current` means last operator-confirmed, not continuously measured; `initial`,
`unknown`, and `stale` require their own interpretation. A missing field means not
recorded, not necessarily unconfigured. Older encrypted history may still exist
after an update. Agree the operator’s retention and access rules before saving values.

Protect private PDFs, backups, spare copies, printer queues, and misprints. Follow
the [support and recovery agreement](backup-loss-and-support.md) when credentials
change, a phone is lost, or access becomes uncertain.
