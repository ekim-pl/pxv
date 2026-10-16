# Flash a new Pixel with the five-profile starter

This is the shortest supported PXV path to install GrapheneOS and create the five Android users represented by `reference-five`: owner, contacts, google, testing and onion. The owner already exists after first boot; PXV creates the four secondary users.

The starter is only a layout. It has no trusted OS release pin, apps, settings or VPN configuration, so it does not produce a hardened or deployment-ready phone. Review and complete the policy for your exact use before flashing.

## 1. Prepare the project and pin the OS

Use an authorized, carrier-unlocked Pixel and a dedicated new project. Flashing erases the phone during both bootloader unlock and relock. Fastboot needs direct USB; Docker host-ADB mode cannot flash.

From the PXV checkout, set a new project path and initialize it with the five-profile pack:

```sh
P="$HOME/pxv-projects/five-profile-phone"
pxv host doctor
pxv project init --path "$P" --policy "$PWD/policy-packs/reference-five/policy.json"
```

Edit `"$P/policy.yaml"` for the intended deployment. Add an `os` object using the exact codename and current release shown on the [GrapheneOS releases page](https://grapheneos.org/releases):

```json
"os": {
  "codename": "EXACT_DEVICE_CODENAME",
  "release": "CURRENT_10_DIGIT_RELEASE",
  "url": "https://releases.grapheneos.org/EXACT_DEVICE_CODENAME-install-CURRENT_10_DIGIT_RELEASE.zip",
  "signatureUrl": "https://releases.grapheneos.org/EXACT_DEVICE_CODENAME-install-CURRENT_10_DIGIT_RELEASE.zip.sig",
  "signerPrincipal": "contact@grapheneos.org",
  "namespace": "factory images",
  "publicKey": "ssh-ed25519 CURRENT_KEY_FROM_OFFICIAL_ALLOWED_SIGNERS"
}
```

Use the current signing key from GrapheneOS' official [`allowed_signers`](https://releases.grapheneos.org/allowed_signers) source, omitting the principal from the `publicKey` value. Update the owner display name if needed so it matches the name selected during first-boot setup. Add reviewed app pins and other settings before claiming the phone is configured; do not invent hashes or reuse a key from an old guide.

If the recipient wants the guided run to include optional duress setup, also add `"duress"` to the top-level `capabilities` array. The starter does not enable it by default. Validate and lock the policy after all edits.

Validate and lock the reviewed policy:

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P" --yes
```

PXV requires fastboot 35.0.2 or newer and OpenSSH signature verification. Resolve anything reported by `pxv host doctor` before continuing.

## 2. Enroll and flash in Fastboot mode

If OEM unlocking is not already enabled, finish only the temporary stock setup needed to enable Developer options and OEM unlocking. OEM unlocking may require internet access on some carrier-capable variants. Then boot to the phone's **Fastboot Mode** screen and connect it directly to the computer. See the [official GrapheneOS CLI install guide](https://grapheneos.org/install/cli) for the device buttons and physical checkpoints.

Replace the sample asset, serial, model and codename with the exact values observed on this phone. Keep the phone in Fastboot mode for enrollment:

```sh
pxv inventory enroll --project-root "$P" --asset phone-01 \
  --serial EXACT_FASTBOOT_SERIAL --model 'EXACT_PIXEL_MODEL' \
  --codename EXACT_DEVICE_CODENAME --kind pixel --transport usb \
  --mode fastboot --yes
pxv device install-os --project-root "$P" --asset phone-01 --dry-run
pxv device install-os --project-root "$P" --asset phone-01 --operator 'Operator'
```

Check the dry-run review for the exact phone, codename, release and USB serial. In the real run, attend and confirm the phone's unlock and relock prompts. PXV downloads the pinned image, verifies its OpenSSH signature, and runs the `flash-all.sh` script from that verified archive with the enrolled serial forced. If flashing fails or is interrupted, stop and inspect the phone and PXV recovery state; do not relaunch the flash blindly.

## 3. Create the five users

After the phone boots, complete first-boot setup. Set the owner name to the reviewed policy name, keep the bootloader locked, and leave OEM unlocking off. The recipient should privately set the owner's initial screen lock during setup, or afterward at **Settings > Security & privacy > Device unlock > Screen lock**. Choose a random PIN of six or more digits, or a strong password the recipient can reliably enter. Do not record it in PXV notes, shell commands or the operator's records. Enable USB debugging only for provisioning and authorize the connected computer.

Then run the policy-derived guided flow. Review first, then execute:

```sh
pxv host adb-start --yes
pxv device inspect --project-root "$P" --asset phone-01
pxv device guided --project-root "$P" --asset phone-01 --operator 'Operator' --dry-run
pxv device guided --project-root "$P" --asset phone-01 --operator 'Operator'
```

The guided run creates the missing secondary users and applies only the reviewed policy. Complete the named phone checkpoints and resume the same run when prompted. When each secondary user is ready, switch into it and have the recipient set that profile's own PIN or password at **Settings > Security & privacy > Device unlock > Screen lock**. Use a separate credential for each profile, then lock and unlock each profile once with its normal credential. GrapheneOS profiles have separate encryption keys based on their lock methods; keep each credential private to the recipient and out of operator records. See the [GrapheneOS user-profile notes](https://grapheneos.org/features#improved-user-profiles) and [screen-lock instructions](https://support.google.com/pixelphone/answer/2819522).

### Optional: set up a duress PIN and password

Do this only after normal screen locks are set for all profiles and the final language setup is complete. PXV prompts for this final manual step only if `"duress"` was added to the policy capabilities before validation and locking.

In the **owner** profile, open **Settings > Security & privacy > Device unlock > Duress Password** and follow the on-screen setup. GrapheneOS requires both a duress PIN and a duress password, even if the profiles currently use only one lock type. A duress PIN is used at PIN prompts; a duress password is used at password prompts. Keep both distinct from the normal credentials so they cannot be confused.

This feature irreversibly erases the phone's data, all profiles and installed eSIMs as soon as a duress credential is entered at a device-credential prompt; the wipe cannot be interrupted. When Settings asks you to confirm access during setup, enter the current normal owner credential. Never test the duress PIN or password by entering it. Read the [official GrapheneOS duress documentation](https://grapheneos.org/features#duress) first and make sure the recipient accepts the loss of all local data and eSIMs.

If the guided run pauses at the `duress` checkpoint, attest it only after the recipient has finished the setup, then resume the same run:

```sh
pxv device attest --project-root "$P" --asset phone-01 \
  --check duress --operator 'Operator' --yes
pxv agent resume --project-root "$P" --run RUN_ID --yes
```

With the unchanged starter, the resulting users are empty profiles; the required network, backup, recipient and operator checks still need to be completed before handoff. Disable and physically verify USB debugging when provisioning is finished.
