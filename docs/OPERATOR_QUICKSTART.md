# Operator quickstart

Use a dedicated authorized phone and an isolated project. Review the selected policy before connecting a recipient's phone. The shipped one-profile, five-profile and custom-layout packs are structural starters: they contain no invented trusted APK hashes or OS signing keys and are not qualified hardening profiles.

## Prepare the host and project

Install a verified portable archive, Debian package or npm package. A portable archive and Debian package include Node and the Linux supervisor; an npm installation requires Node 24.22.0. A source checkout requires pnpm 12.11.2, the pinned compiler and a Rust toolchain for the supervisor.

~~~sh
pnpm install --frozen-lockfile
pnpm build:native
pnpm build
pnpm pxv --help
~~~

The remaining examples use an installed command. Create a new directory outside the source checkout:

~~~sh
P="$HOME/pxv-projects/lab"
pxv host doctor
pxv project init --path "$P"
pxv policy validate --project-root "$P"
pxv host adb-start --yes
~~~

Doctor inspects tools and the configured ADB endpoint; it does not start a server or bootstrap a toolchain. See [host dependencies](HOST_DEPENDENCIES.md) for verified downloads and explicit SDK license handling.

## Enroll, review and execute

Enable debugging only for the provisioning session, inspect the phone's USB authorization prompt, and compare the physical asset label, serial, model and codename. Replace the sample serial; never copy one from another phone.

~~~sh
pxv inventory enroll --project-root "$P" --asset lab-01 \
  --serial YOUR_OBSERVED_SERIAL --model 'Pixel 8a' --codename akita --yes
pxv device inspect --project-root "$P" --asset lab-01
pxv device plan --project-root "$P" --asset lab-01
pxv device provision --project-root "$P" --asset lab-01 --operator 'Lab operator'
~~~

Review every generated plan, including global APK effects and manual checkpoints. `--yes` confirms the displayed review in automation; it does not replace a phone's unlock/relock prompt or a human check. OS installation is a separate destructive workflow and needs a pinned, authenticated OS policy.

A pending result means work remains. Perform the exact pending check privately on the phone, record only its named attestation, then use `agent resume --run RUN_ID --yes`. Inspect recovery reservations before retrying a failed or interrupted operation. Finish with fresh signoff, recipient acceptance, debugging shutdown and the custody record described in [operator guide](OPERATOR_GUIDE.md).

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.
