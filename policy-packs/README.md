# Policy pack starters

These packs demonstrate one, five and arbitrary profile layouts. They are structural templates, not certified hardening policies. No live device acceptance is claimed.

Before using a pack on a phone, a product maintainer must add reviewed OS provenance, APK versions, content digests and signer pins, repository trust anchors, required settings, permission grants and VPN configuration. Empty package lists intentionally avoid presenting invented digests as trusted artifacts. Changing any field changes the resolved policy digest and invalidates the previous reviewed plan.

`reference-five` retains owner, contacts, google, testing and onion roles. `simple` uses only the owner. `custom` demonstrates arbitrary role names and Polish recipient language. Exactly one owner is required; five profiles and the literal name owner are not engine requirements.

Every starter profile, including the owner, declares `defaultLocale`. Edit profiles independently, for example owner `en-US`, work `pl-PL` and travel `de-DE`. The field accepts one canonical BCP 47 language/region/script tag, such as `sr-Latn-RS`; it does not set a time zone or document language. Legacy `language` is accepted, with conflicting aliases rejected. Locale setup runs after normal credentials and before optional duress through an accepted UI adapter or a manual checkpoint.

## Reference-five defaults

The `reference-five` policy initializes these ordinary screen locks and locales:

| Profile  | Lock     | Locale            | Private reference |
| -------- | -------- | ----------------- | ----------------- |
| owner    | Password | English (`en-US`) | `owner-password`  |
| contacts | PIN      | Polish (`pl-PL`)  | `contacts-pin`    |
| google   | PIN      | Polish (`pl-PL`)  | `google-pin`      |
| testing  | PIN      | Polish (`pl-PL`)  | `testing-pin`     |
| onion    | PIN      | Polish (`pl-PL`)  | `onion-pin`       |

The owner configures the device-wide duress pair: `pinRef: duress-pin` and `passwordRef: duress-password`, authenticated with `ownerCredentialRef: owner-current`. `owner-current` must contain the owner's actual ordinary unlock credential when duress setup runs. Initially, copy the privately chosen `owner-password` value into it if that password is retained. Both duress values must differ from that current owner credential and every ordinary profile credential.

Create `secrets/credentials/<assetId>.json` inside the private project, replacing `<assetId>` with the enrolled asset ID. Use mode `0600`. The following strict JSON is a placeholder template: replace every placeholder privately before use. It contains no usable default values. The public policy contains references only; keep the private file outside version control and release assets.

```json
{
  "schemaVersion": 1,
  "values": {
    "owner-password": "<replace privately: initial ordinary owner password>",
    "owner-current": "<replace privately: current ordinary owner credential>",
    "duress-pin": "<replace privately: duress PIN>",
    "duress-password": "<replace privately: duress password>",
    "contacts-pin": "<replace privately: contacts PIN>",
    "google-pin": "<replace privately: google PIN>",
    "testing-pin": "<replace privately: testing PIN>",
    "onion-pin": "<replace privately: onion PIN>"
  }
}
```

Normal defaults initialize profiles without an existing screen lock. The recipient privately verifies or replaces each default at `normal_credentials`, then confirms each profile's locale through the accepted UI path or the manual `language:<profileId>` checkpoint. Owner duress setup follows locale setup and retains the manual `duress` checkpoint. See [default lock and duress setup](../docs/OPERATOR_GUIDE.md#optional-default-lock-and-duress-credentials) for credential formats, private-file conditions and the current-owner-credential procedure. This starter remains a structural template, with no certified hardening or live-device acceptance claim.

Select a pack at new-project initialization with `project init --path DIRECTORY --policy FILE`, or explicitly review an installed extension's declared policy contribution. Validate the resulting project policy and write a fresh lock before planning. Copying a file is not policy acceptance.

Forks own these manifests, assets and release qualification. Preserve the engine contract version and safety regressions when merging upstream. Secrets, recipient inventory and private helper signing keys never belong in a distributed pack. Record emulator provenance and physical EN/PL acceptance separately from offline test results.
