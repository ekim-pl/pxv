# Policy pack starters

These packs demonstrate one, five and arbitrary profile layouts. They are structural templates, not certified hardening policies. No live device acceptance is claimed.

Use each pack's `policy.json` for Community projects. Its shared app catalog,
profile app references and per-codename OS pins follow the [policy format](../docs/POLICY_FORMAT.md).

Before using a pack on a phone, a product maintainer must add reviewed OS provenance, APK versions, content digests and signer pins, repository trust anchors, required settings, permission grants and VPN configuration. Empty package lists intentionally avoid presenting invented digests as trusted artifacts. Changes to the normalized execution policy change its resolved digest and invalidate the previous reviewed plan. Authoring-only changes, such as adding an unused app catalog entry, do not change that digest. Validate and lock the edited policy before reviewing a new plan.

`reference-five` retains owner, contacts, google, testing and onion roles. `simple` uses only the owner. `custom` demonstrates arbitrary role names and Polish recipient language. Exactly one owner is required; five profiles and the literal name owner are not engine requirements.

Every starter profile, including the owner, declares `defaultLocale`. Edit profiles independently, for example owner `en-US`, work `pl-PL` and travel `de-DE`. The field accepts one canonical BCP 47 language/region/script tag, such as `sr-Latn-RS`; it does not set a time zone or document language. The alternate `language` field is accepted, with conflicting aliases rejected. Locale setup runs after normal credentials and before optional duress through an accepted UI adapter or a manual checkpoint.

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

Normal defaults initialize profiles without an existing screen lock. The recipient privately verifies or replaces each default at `normal_credentials`, then confirms each profile's locale through the accepted UI path or the manual `language:<profileId>` checkpoint. Owner duress setup follows locale setup and retains the manual `duress` checkpoint. See [initial screen locks, language and duress](../docs/POLICY_FORMAT.md#initial-screen-locks-language-and-duress) for credential formats, private-file conditions and the current-owner-credential procedure. This starter remains a structural template, with no certified hardening or live-device acceptance claim.

Select a pack at new-project initialization with `project init --path DIRECTORY --policy FILE`, or explicitly review an installed extension's declared policy contribution. Validate the resulting project policy and write a fresh lock before planning. Copying a file is not policy acceptance.

Forks own these manifests, assets and release qualification. Preserve the engine contract version and safety regressions when merging upstream. Secrets, recipient inventory and private helper signing keys never belong in a distributed pack. Record emulator provenance and physical EN/PL acceptance separately from offline test results.


## One-person five-profile acceptance

[`self-service-five/policy.json`](self-service-five/policy.json) keeps the Owner,
contacts, google, testing and onion layout with English Owner and Polish secondary
profiles. It requires ordinary credentials and network/backup acceptance, but has
no initial credential references or duress configuration. Enter ordinary credentials
privately on the phone. The Owner display name starts as `Owner`; match it to the
observed Owner before review.

The app catalog and OS pins are deliberately empty, and no VPN route is configured.
Complete a private copy with authentic artifacts and explicit per-profile network
and backup expectations before the full test. A profile named onion does not route
traffic through Tor, and a profile named google does not install Google services.
Follow the [full self-service procedure](../docs/SELF_SERVICE_FIVE_PROFILE_TEST.md).
