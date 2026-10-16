# Recipient guide

## What the phone provides

Your provider chooses a policy for your intended use. It can divide activities into Android users/profiles, install pinned applications and require specific network or backup settings. Application code updates can affect several users even when their data is separated. Ask which tasks belong in each profile and which changes require a maintenance visit.

A hardened configuration reduces particular risks; it cannot guarantee anonymity, protection against every attacker or recovery of data that was never backed up. Certification applies only to the exact pack, software build and checks in your accepted handoff record. Community starter packs are demonstrations of structure.

## Private setup and credentials

Set the normal screen lock yourself while the operator gives you privacy. If provisioning supplied an initial PIN or password, privately verify an ordinary unlock in every selected profile and replace the initial value if it is not your intended final credential. Enter accounts, MFA and recovery information on the phone or through the service's approved recovery process. Do not put these values in an operator's notes, a chat, a guide annotation, a repository or an unapproved photo.

Finish normal credentials before final language selection and any optional duress configuration. GrapheneOS uses one owner-managed duress PIN/password pair across the device ([official feature description](https://grapheneos.org/features#duress)). If you change the owner lock before automatic duress setup, privately update the referenced owner value using the approved private input procedure before the run resumes, or complete duress manually under a new reviewed plan. Do not disclose the value to the operator or put it in a note or chat. The owner value used for duress must be the current ordinary unlock credential.

Duress is an optional policy capability with potentially destructive consequences. Never enter a duress credential to see whether it works. Ask your provider how to avoid confusing ordinary and duress credentials and how to handle replacement or retirement safely. The [official GrapheneOS usage guide](https://grapheneos.org/usage) is a primary reference for device features; follow the exact instructions for your installed build.

## Language for each profile

Your provider can set a different initial language and region for every profile, including the owner: for example, owner `en-US`, work `pl-PL` and travel `de-DE`. After verifying ordinary screen locks and before optional duress setup, confirm the intended language in each profile and complete any pending manual language step there. These defaults do not set your time zone. The EN/PL language of this guide and your handoff document is selected separately.

## Profiles and applications

Learn the owner/secondary-profile layout actually delivered to you. Different users can have different apps and settings. Restarting or ending a user's session may affect which apps run in the background. Follow your provider's demonstrated procedure instead of assuming another Android model's menus are identical.

Install or remove applications only through the agreed policy. A new source, signer or version may invalidate qualification. Report unexpected permissions, accessibility prompts, administrator requests or app behavior before accepting them.

## Network and backup

Understand which VPN/routing arrangement applies to each profile. A VPN icon does not establish all traffic behavior. Ask for a demonstration of the intended route and agreed failure behavior for your actual applications. If connectivity fails, use support's recovery procedure; switching settings at random may change the policy.

Know what is backed up, where it is kept, how it is encrypted and what a successful restore looked like. Keep recovery material outside the phone. A backup-enabled switch is not proof of a usable backup. Test representative restoration before relying on a new device or a new destination.

Arrange a restore rehearsal with your provider before erasing or replacing your primary phone. The [backup and recovery runbook](CANARY_BACKUP_RECOVERY.md) explains the operator procedure; enter your recovery material privately and check the recovered data yourself.

## Acceptance and everyday use

Before custody transfer, verify the asset label, chosen language in every profile, required profiles, expected apps, contact/support information and agreed live checks. Confirm temporary setup/probe helpers are gone and debugging toggles are off. Retain the EN or PL handoff document; it deliberately excludes device credentials and recovery values.

Arrange maintenance before policy changes, replacing network services or moving recovery destinations. Maintenance produces new evidence and a renewed handoff. If the device is lost, tell support promptly and revoke affected services; a local loss record does not remotely wipe it. At retirement, follow a separately authorized erasure and custody process and retain confirmation.

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.
