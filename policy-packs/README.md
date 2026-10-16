# Policy pack starters

These packs demonstrate one, five and arbitrary profile layouts. They are structural templates, not certified hardening policies. No live device acceptance is claimed.

Before using a pack on a phone, a product maintainer must add reviewed OS provenance, APK versions, content digests and signer pins, repository trust anchors, required settings, permission grants and VPN configuration. Empty package lists intentionally avoid presenting invented digests as trusted artifacts. Changing any field changes the resolved policy digest and invalidates the previous reviewed plan.

`reference-five` retains owner, contacts, google, testing and onion roles. `simple` uses only the owner. `custom` demonstrates arbitrary role names and Polish recipient language. Exactly one owner is required; five profiles and the literal name owner are not engine requirements.

Select a pack at new-project initialization with `project init --path DIRECTORY --policy FILE`, or explicitly review an installed extension's declared policy contribution. Validate the resulting project policy and write a fresh lock before planning. Copying a file is not policy acceptance.

Forks own these manifests, assets and release qualification. Preserve the engine contract version and safety regressions when merging upstream. Secrets, recipient inventory and private helper signing keys never belong in a distributed pack. Record emulator provenance and physical EN/PL acceptance separately from offline test results.
