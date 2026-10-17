# Your prepared Pixel: recipient guide

This guide explains how to receive and use a Pixel prepared with GrapheneOS and one or more Android user profiles. Your handoff packet describes the profiles and checks for **your phone**. App names and screen locations depend on the reviewed configuration and installed build.

**Before daily use:** confirm the phone's label, learn which profile serves each purpose, verify your ordinary locks, complete private app setup, and receive the support and recovery instructions. Never try a destructive code or notification key to check that it works.

The separate [A5 quick start](quickstart-en.md) is designed to accompany every phone. Your preparer supplies a sealed, privately completed [credential insert](credentials-en.md) with a matching asset label. After receipt, keep that insert securely apart from the phone; its optional erasure page is separate from ordinary unlock details.

## 1. Check what you are receiving

With the operator, confirm the following:

1. The physical phone matches the asset label on your handoff packet.
2. Each promised profile exists, opens and has the intended apps and language.
3. You know how to unlock each profile with its ordinary PIN or password.
4. Required app accounts, VPN connections and recovery methods have been checked, or their remaining limitations are written down.
5. USB debugging and Wireless debugging are physically off after preparation.
6. You have the operator's actual support contact, the agreed backup location and a way to recover access without this phone.

Raise missing apps, broken connections or unexpected data before accepting the phone. A generic guide or an old test result is not proof that your phone passed its checks. The operator records finalization and your custody confirmation separately.

## 2. Use the intended profile

If your handoff packet lists only the Owner profile, use that profile; no user switching is needed. If it lists additional profiles, open the Android user switcher and select the intended profile. Ask the operator to demonstrate switching, locking and ending a secondary-user session on this exact build.

Keep personal, work, test or other agreed activities in their intended profiles. App data and account setup belong to the profile where you entered them. Installing an app in several profiles does not sign those profiles into the same account automatically.

App package versions are shared by the phone, while user data and many settings are separate. An update or package-level change can affect several profiles. Ask for support before removing a profile, replacing a managed app or changing a required VPN setting.

A visible profile name is not a durable account identifier. Android user numbers can be reused after deletion; support also tracks the user's serial number. Do not recreate a missing profile under the same name and assume its old record still applies.

## 3. Complete private setup in the right order

The operator may pause preparation while you work privately on the phone. Follow the named checkpoint rather than completing unrelated steps at random.

1. Complete ordinary app configuration when requested: sign-ins, imports, MFA and Android consent. Check the correct profile before entering anything.
2. Set or verify the **ordinary screen lock in every intended profile**. If an initial PIN/password was supplied, privately verify it or replace it as agreed. Try an ordinary lock/unlock with the correct credential.
3. Apply and check the final language in each profile after normal locks have been verified.
4. Complete optional GrapheneOS duress setup only after normal locks and language. Both duress values must differ from every actual ordinary profile PIN/password, including values you changed privately.

Never use a duress value for an ordinary unlock or authentication prompt. Do not activate destructive duress as an acceptance test. If you are unsure which credential a screen requests, stop and ask before entering it.

Initial defaults are only initialization values. A successful setup command does not prove that you can unlock the profile, and changing a value on the phone does not automatically update the support registry.

Tell the operator that the named step is complete without speaking, displaying or writing secret values into public notes. If authorized ongoing support retains your current credentials, transfer the required update through the agreed private process described below.

## 4. Configure apps and VPN in each profile

Follow each app's supported sign-in, configuration import and recovery process. Use the approved private transfer method for sensitive imports. If automated setup is unsupported, complete the full setup privately; do not look for an expired temporary file left by an earlier attempt.

A VPN app needs its own configuration and Android consent in every profile where it is required. Complete that setup before the operator enables always-on VPN or blocking connections without VPN. Check the intended connection and apps afterward.

If networking stops, check that you are in the intended profile, the expected VPN app is configured and the agreed network is available. Report the profile, app and visible error without credentials. Do not remove the VPN or disable its protection merely to make a test pass.

Successful helper checks cover only their recorded scope. They do not promise that every app's traffic has the same route. Keep limitations in your handoff packet and ask before changing routing, backup or permission settings.

## 5. Distinguish Session, Oblivion and duress

A **Session messenger ID** identifies a messenger account. It is not the Android profile ID, Android user number, phone number or hardware serial. Confirm which Session account belongs to each profile before sharing its ID.

An **Oblivion notification-wipe key** belongs to an app installation in a particular Android profile. The requested behavior is user-described as wiping the **whole phone** when the key is received in a notification. That behavior is not qualified for a reviewed exact app/build by this project.

Treat an actual Oblivion key as destructive secret material. Keep it separate from the GrapheneOS duress PIN/password. Do not send it during preparation, acceptance tests or ordinary support, or include it in screenshots, logs or public exports. Intentional erasure needs its own agreed process. Registry access does not send a notification or activate erasure.

If you do not understand an erasure feature or its intended scope, leave configuration to the agreed supervised process. There is no need to trigger real erasure to receive or check this phone.

## 6. Understand the retained support record

For authorized ongoing support, the operator can retain last-confirmed credentials in a **local encrypted registry**. Agree who may unlock it, what is retained, how changes are reported and how private copies are handled.

The record can contain:

- Phone identity: asset label, hardware serial, Pixel codename and phone number.
- Device-wide GrapheneOS duress PIN/password, separate from Oblivion.
- Each profile's PIN/password, Oblivion key, Session messenger ID, Proton VPN username/password and optional phone number.
- Stable Android profile identities and encrypted historical revisions.

`current` means a value was last explicitly confirmed by the operator; it is not a continuous reading from your phone. `initial`, `unknown` and `stale` are distinct states. After changing a retained credential or account on the phone, arrange a private registry update so support does not rely on the old value.

Flashing, profile creation, certain initial credential writes and maintenance/lifecycle changes can mark affected records stale. Previous revisions remain encrypted history. Do not use an old retrieved value as evidence that it still unlocks the phone.

Ordinary reports and handoff exports omit registry values. A private retrieval deliberately creates a plaintext file that needs protection and cleanup. Registry backups and unlock material need separate protection; the operator can rotate the encryption passphrase. See [registry details](../../../docs/PHONE_REGISTRY.md) and [security boundaries](../../../SECURITY.md).

## 7. Keep recoverable copies of your data

Agree which data is covered in **each profile**, where backups are stored, who has recovery material and what is excluded. App installation, a backup-enabled setting or a success notification is not a demonstrated restore.

Use the exact OS/app-supported backup or export method chosen with the operator. Keep recovery access available when this phone, its number or its MFA is unavailable. Do not assume the owner's backup includes every secondary profile or app.

Ask for a representative restore check on an authorized separate test device when available. Never erase your primary phone, delete a profile or unlock its bootloader just to test a backup. Read the agreed exclusions before depending on recovery.

## 8. Request support without exposing secrets

Report your asset label, affected profile, app, time and a description of the problem. Send secrets only through the agreed private registry/update process; ordinary support notes and screenshots should exclude them.

Contact the operator before repair, profile deletion, factory reset, OS reinstallation or transfer to another person. These changes require new identity checks and can invalidate the previous handoff. If the phone is lost, use the agreed loss procedure and review affected service accounts; possession of a registry record does not recover the missing phone.

During maintenance, temporary debugging may be needed under supervision. At the end, check both debugging switches are off again, review changed credentials and receive the new handoff record where required.

## Further instructions and qualification

The [operator guide](operator-en.md) covers commands and acceptance. Technical references include [host dependencies](../../../docs/HOST_DEPENDENCIES.md), [policy format](../../../docs/POLICY_FORMAT.md), [command reference](../../../docs/COMMAND_REFERENCE.md), [backup and recovery](../../../docs/CANARY_BACKUP_RECOVERY.md), [automation](../../../docs/AUTOMATION.md) and [Docker](../../../docs/DOCKER.md).

Read the [verification status](../../../docs/VERIFICATION.md) for the limits of retained evidence. An offline rehearsal or historical phone result does not qualify the current configuration. Without a physical canary, live flashing, app/VPN behavior and recovery remain unqualified until actually checked on an authorized target.
