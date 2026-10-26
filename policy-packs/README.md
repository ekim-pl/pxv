# Policy pack starters

These packs demonstrate one, two, three, five and arbitrary profile layouts. They are structural templates, not certified hardening policies. No live device acceptance is claimed.

Use each pack's `policy.json` for Community projects. Its shared app catalog,
profile app references and per-codename OS pins follow the [policy format](../docs/operators/policy-reference.md).

Before using a pack on a phone, a product maintainer must add reviewed OS provenance, required settings, permission grants and service-specific network configuration. All packs include pinned apps listed below; review their versions, sources and signer pins for the deployment. Add repository trust anchors if using repository-backed artifacts. Changes to the normalized execution policy change its resolved digest and invalidate the previous reviewed plan. Authoring-only changes, such as adding an unused app catalog entry, do not change that digest. Validate and lock the edited policy before reviewing a new plan.

`fleet-nerd` retains owner, contacts, google, testing and onion roles. `single-simple` uses only the owner. `fleet-custom` demonstrates arbitrary role names and Polish recipient language. Exactly one owner is required; five profiles and the literal name owner are not engine requirements.

[`bete-pl`](bete-pl/policy.json) has two profiles: owner `Admin` in `en-US` and
secondary `contacts`, displayed as `Kontakty`, in `pl-PL`. Both profiles include
Rethink DNS and the common apps below. Kontakty also installs Session and Molly
from their official F-Droid repositories, using the same pins as the nerd packs.

Every starter profile, including the owner, declares `defaultLocale`. Edit profiles independently, for example owner `en-US`, work `pl-PL` and travel `de-DE`. The field accepts one canonical BCP 47 language/region/script tag, such as `sr-Latn-RS`; it does not set a time zone or document language. The alternate `language` field is accepted, with conflicting aliases rejected. Locale setup runs after normal credentials and before optional duress through an accepted UI adapter or a manual checkpoint.

## Common apps

Every profile in every pack installs Oblivion Wipe (`net.oblivion.wipe`, catalog ID
`oblivion-wipe`) and Find my IP (`com.maksimowiczm.findmyip`, catalog ID `findmyip`).
The `single-simple` and `fleet-custom` catalogs contain these two apps.
Oblivion Wipe's private setup and Android consent remain separate from installation.

The Oblivion VPN app (`org.bepass.oblivion`, catalog ID `oblivion`) is installed
only in the existing `testing` profile of `single-nerd` and `fleet-nerd`. Policies
without a tester profile omit it from both their profiles and app catalogs.

## Five-profile apps

`fleet-nerd` and `single-nerd` share these assignments in addition to the common apps:

| Profile | Apps |
| --- | --- |
| owner | Rethink DNS |
| contacts | Rethink DNS, Session, Telegram, Signal, Molly |
| google | Rethink DNS, Aurora Store |
| testing | Rethink DNS, Molly, Oblivion VPN |
| onion | Rethink DNS, Orbot |

[`fleet-privacy`](fleet-privacy/policy.json) copies `fleet-nerd`, and
[`single-privacy`](single-privacy/policy.json) copies `single-nerd`, with the testing
and onion profiles removed. Both privacy packs retain owner, contacts and google
with the same app assignments above except Molly; the unused Orbot and Oblivion VPN
catalog entries are removed.
`fleet-privacy` retains the fleet credential defaults and owner duress configuration
for those three profiles. `single-privacy` retains private on-device credential
entry with no initial credential references or duress configuration. It selects
Rethink DNS + Firewall (`com.celzero.bravedns`) as an always-on VPN with lockdown
for Owner, contacts and google, and disables Android's global Private DNS setting.
Configure and test Rethink separately in each profile before lockdown; the policy
does not configure an upstream VPN tunnel or proxy. The capabilities, required
attestations, locales and remaining app assignments follow the corresponding
nerd pack.

F-Droid is not installed in any profile. This catalog currently uses pinned direct
APK URLs. PXV also supports `fdroidcl` from the official repository and app-specific
authenticated F-Droid repositories; the reviewed plan installs PXV's verified
cached APK. Aurora Store is installed only in google. App accounts, permissions and
network configuration still need deployment review and acceptance.

For a pack customized with source-only app declarations, first use
`pxv policy resolve-apps --policy policy.sources.json --sdk 36 --abi arm64-v8a --output policy.pinned.json --dry-run`.
Review the intended SDK/ABIs, source and observed signer before writing the output
and passing that complete pinned file to `project init`. Supplied pins remain
constraints. See [source resolution](../docs/operators/policy-reference.md#resolving-app-sources-into-pins).

Refresh eligible F-Droid app pins in a selected starter with
`pxv policy update-apps --policy policy-packs/fleet-nerd/policy.json --sdk 36 --abi arm64-v8a --dry-run`.
Use the intended phone's actual SDK and ABI values, review the result, then replace
`--dry-run` with `--yes` to write it. Run the command separately for each starter
that should receive the update. Custom repositories require trust anchors in the
policy. Every pack declares the official F-Droid trust anchor for its pinned APK
URLs. Both nerd packs and `bete-pl` also declare trust anchors for Session and Molly, matching
their pinned direct APK URLs. See [updating app pins](../docs/operators/policy-reference.md#updating-app-pins).

The existing catalog pins date from 2026-10-19; Molly, Oblivion Wipe and Find my IP
were added on 2026-10-21:

| Catalog ID | Version (version code) | Distribution |
| --- | --- | --- |
| rethink | 0.5.8 (703) | F-Droid, arm64-v8a |
| oblivion | 8.0.0 (800) | Oblivion VPN, upstream GitHub release v8; nerd testing profiles only |
| oblivion-wipe | 1.0.7 (46) | F-Droid; every profile in every pack |
| findmyip | 4.1.2 (15) | F-Droid, universal; every profile in every pack |
| session | 1.33.7 (4555) | Session repository, universal |
| telegram | 13.0.3 (71839) | Telegram website distribution |
| signal | 8.31.2 (176601) | Signal website distribution, universal |
| molly | v8.19.2-4 (171904) | Molly repository, universal; nerd packs and bete-pl |
| aurora | 4.8.4 (76) | F-Droid, universal |
| orbot | 17.9.5-RC-4-tor-0.4.9.11 (1795300400) | Guardian Project, universal |

Rethink's APK targets physical Pixels (arm64-v8a). For an x86_64 emulator,
replace that catalog entry with an independently verified x86_64 artifact and
review a fresh policy lock. Telegram's website APK has package ID
`org.telegram.messenger.web`. Orbot's published version is a release candidate.
Telegram's download endpoint and Guardian's `orbot-latest.apk` are mutable;
new upstream bytes will fail the pinned digest check until the catalog is reviewed
and updated. PXV retains APK bytes and signer evidence in the private artifact cache
for repeat runs. F-Droid sources also retain the signed repository entry and index
used to authenticate those APKs.

### App pin provenance

Rethink and Aurora pins came from the [F-Droid repository](https://f-droid.org/repo/),
Session from its [official repository](https://fdroid.getsession.org/fdroid/repo/),
and Orbot from the [Guardian repository](https://guardianproject.info/fdroid/).
For each, `entry.jar` was verified with PXV's repository verifier against the
publisher's signing-certificate pin, then the index-v2 JSON size and SHA-256 were
checked against that authenticated entry. Package IDs, version codes, APK hashes
and APK signer hashes were taken from those verified indexes:

| Repository | Repository signer SHA-256 | Index-v2 SHA-256 |
| --- | --- | --- |
| F-Droid | `43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab` | `e7bc9d24743e9c6f9c09312abe6245ef7c2e966aec178886a545fc97880196fe` |
| Session | `db0e5297eb65cc22d6bd93c869943bdcfcb6a07dc69a48a0dd8c7ba698ec04e6` | `2f2193c2361e338d88ea52162b91ad3a5247b6fb2d0b4bf919e7e1a999fc9091` |
| Guardian | `b7c2eefd8dac7806af67dfcd92eb18126bc08312a7f2d6f3862e46013c7a6135` | `4d670392c1bcaa717d3d75b2bc93fb8a11be06439efc7313ee816fe4dedd4474` |

Telegram's downloaded APK signature was verified and its signer matched
[Telegram's published Android association](https://telegram.org/.well-known/assetlinks.json).
Signal's version and content hash came from its
[update metadata](https://updates.signal.org/android/latest.json), with the signer
checked against its [published certificate](https://signal.org/android/apk/).
Oblivion VPN's APK hash matched the publisher's
[v8 release asset digest](https://api.github.com/repos/bepass-org/oblivion/releases/tags/v8);
its signature, package ID and version code were inspected with Android Build Tools.
The catalog pins each APK content hash and signer. PXV's private artifact cache
retains the APK bytes and signing evidence. This artifact review does not claim live
phone or routing acceptance.

Oblivion Wipe and Find my IP were pinned from the official F-Droid repository on
2026-10-21. PXV's repository verifier authenticated `entry.jar` against the F-Droid
repository signer above. The index-v2 JSON's size and SHA-256 matched that signed
entry; its SHA-256 was
`900242f55ff7397aca52ffb25439f21657fbfe8cff23f80528a2725da6ce5faf`.
Both downloaded APKs matched the authenticated sizes and digests, and Android Build
Tools verified their signatures, package IDs and version codes. Oblivion Wipe's
signer matches PXV's existing `collect-oblivion` signer pin.

Molly comes from the [official Molly repository](https://molly.im/fdroid/repo/)
used by the nerd packs and `bete-pl`. Its `entry.jar` was authenticated with PXV's repository
verifier against repository signer
`3b7e93b1fe32c6e35a93d6ddfc5afbeb1239a7c6ea6af20ff33ed53cdc38b04a`.
The authenticated index-v2 SHA-256 was
`ab6d7f04c4819a3481bf5612d63f7297049de121b6068f37c33883f329d43dd9`;
its size and digest, and the APK's size, digest, signature, package ID and version
code were verified. This is the regular Molly build; Molly-FOSS uses a separate
repository and signing key. Both nerd policies and `bete-pl` retain this repository's trust
anchor for `policy update-apps`, while installing the pinned APK through its direct
URL, like the other catalog entries. The observed repository index is dated
2026-07-31, outside the retained 30-day update freshness window; repository updates
will be rejected until Molly publishes a fresh index. The pinned direct APK remains
subject to its exact content and APK signer checks.

## Fleet Nerd defaults

The `fleet-nerd` policy initializes these ordinary screen locks and locales:

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

Normal defaults initialize profiles without an existing screen lock. The recipient privately verifies or replaces each default at `normal_credentials`, then confirms each profile's locale through the accepted UI path or the manual `language:<profileId>` checkpoint. Owner duress setup follows locale setup and retains the manual `duress` checkpoint. See [initial screen locks, language and duress](../docs/operators/policy-reference.md#initial-screen-locks-language-and-duress) for credential formats, private-file conditions and the current-owner-credential procedure. This starter remains a structural template, with no certified hardening or live-device acceptance claim.

Select a pack at new-project initialization with `project init --path DIRECTORY --policy FILE`, or explicitly review an installed extension's declared policy contribution. Validate the resulting project policy and write a fresh lock before planning. Copying a file is not policy acceptance.

Forks own these manifests, assets and release qualification. Preserve the engine contract version and safety regressions when merging upstream. Secrets, recipient inventory and private helper signing keys never belong in a distributed pack. Record emulator provenance and physical EN/PL acceptance separately from offline test results.


## One-person five-profile acceptance

[`single-nerd/policy.json`](single-nerd/policy.json) keeps the Owner,
contacts, google, testing and onion layout with English Owner and Polish secondary
profiles. It requires ordinary credentials and network/backup acceptance, but has
no initial credential references or duress configuration. Enter ordinary credentials
privately on the phone. The Owner display name starts as `Owner`; match it to the
observed Owner before review.

The app catalog contains the pinned five-profile apps above. OS pins still need
to be supplied, and no VPN route is configured. Review a private copy with explicit
per-profile network and backup expectations before the full test. Installing Orbot
does not configure Tor routing, and Aurora Store does not install Google services.
Follow the [full self-service procedure](../docs/operators/acceptance.md).
