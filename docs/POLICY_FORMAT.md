# Policy format

A policy declares the intended device and profile configuration. Validate and lock
it before preparing and approving provisioning work.

Define an `apps` catalog once, reference catalog IDs from
each profile's `apps` list, and place all `global` Android settings in the top-level
`deviceSettings` list. Profile `settings` accept only `secure` and `system` entries.
Other profile fields, including permissions, VPN settings and pinned recipes, keep
their existing meaning. Permissions and VPN fields still use Android package IDs.

```json
{
  "id": "personal",
  "name": "Personal devices",
  "capabilities": [],
  "requiredAttestations": ["recipient_acceptance", "operator_signoff"],
  "repositories": [],
  "apps": {},
  "deviceSettings": [{ "namespace": "global", "key": "airplane_mode_on", "value": "0" }],
  "profiles": [
    {
      "id": "owner",
      "name": "Owner",
      "kind": "owner",
      "apps": [],
      "settings": [],
      "permissions": [],
      "vpn": { "packageId": null, "alwaysOn": false, "lockdown": false }
    }
  ]
}
```

Catalog values pin `packageId`, `versionCode`, the APK `sha256`, and the APK signing
certificate `signerSha256`. A new `source` object supports three acquisition methods:

```json
[
  { "source": { "kind": "direct", "url": "https://publisher.example/app.apk", "redirectHosts": ["cdn.publisher.example"] } },
  { "source": { "kind": "fdroidcl" } },
  { "source": { "kind": "fdroid-repository", "url": "https://apps.example/fdroid/repo", "fingerprint": "<verified repository signer SHA-256>" } }
]
```

These examples show the `source` member shape; package identity and APK pins are
omitted. `direct` downloads that URL and checks both APK pins. `fdroidcl` uses the
host `fdroidcl` command with an isolated
configuration to select the exact package and version from its default official
F-Droid repository; PXV authenticates that repository's signed index and checks the
APK pins independently because [`fdroidcl` relies on HTTPS for its own index
verification](https://github.com/Hoverth/fdroidcl#caveats). PXV then installs the
cached, reviewed APK through its normal plan. The official source mode uses PXV's
pinned F-Droid repository signing certificate. `fdroid-repository` authenticates an
app-specific F-Droid repository using its URL and repository signer fingerprint,
then checks the APK pins. Its `maxAgeDays` defaults to 30 and may be set from 1 to
365. Optional `redirectHosts` can allow named download hosts for direct and
app-specific repository sources.

The APK's Android signature is embedded in the APK bytes. PXV caches the APK with a
`signature.json` record of its verified package, version, content hash, signer and
`apksigner` result. F-Droid sources also cache the signed `entry.jar` and the index
it authenticates (or the signed `index-v1.jar`) under
`state/artifacts/repository-signatures/`; cached repository signatures are checked
again before execution. Existing `path`, top-level `url`, and `repositoryId` entries
remain accepted for policies that already use them. App versions remain shared
between Android users; conflicting catalog versions are rejected.

For mixed Pixel models, `os` is a map keyed by codename. Each value is a complete
existing OS pin (`codename`, `release`, official `url` and `signatureUrl`,
`signerPrincipal`, `namespace`, and `publicKey`). The map key must equal that pin's
codename. Selection never falls back to another model's image. An enrolled model
without a pin cannot be flashed or pass pinned OS verification.

The engine expands app references, assigns device settings to the owner once, and
retains model-specific image pins internally. `project init --policy FILE` validates
and copies the authored policy into the new project. After a policy change, run
`pxv policy validate` and `pxv policy lock`, then prepare and approve a fresh plan
before execution.

Authored input uses the public `PolicyDocument` interface; the expanded engine
model uses `ExecutionPolicy`. Each form has its own validator and serializer.
Policies have no version fields; their content identifies the reviewed configuration.
The resolved digest covers normalized execution semantics: an unused catalog app
does not affect it, while a change to referenced apps or other normalized fields
does. Review actual changes instead of treating every authoring byte as a new
execution identity.

## Profiles, apps and configuration

Exactly one profile has `kind: owner`; other profile IDs and display names are
deployment choices. The Android owner is user zero. PXV binds secondary users by
numeric user ID, serial number and name because Android may reuse a deleted user's
numeric ID. A policy profile ID is also separate from a Session messenger account ID.

An app catalog entry fixes one package ID, version code, SHA-256 content digest and
signing-certificate digest. Its `path` is contained within the private project, or
its reviewed URL/repository supplies the bytes. Use the same app ID in several
profiles rather than copying the artifact definition. An Android package update can
affect every user where it is installed; review the cross-profile effects shown in
the plan. Do not invent hashes or trust a download solely because it uses HTTPS.
For an APK with a verified signing-key rotation lineage, `signerSha256` identifies
the current certificate (the unbounded SDK range in Android `apksigner` output),
not a historical compatibility certificate. Multiple independent signers are rejected.

Per-profile settings, permission grants and VPN policy remain explicit. Configure
device-wide `global` settings only in `deviceSettings`; profile settings cannot use
that namespace. See [network policy](NETWORK_POLICIES.md) for always-on VPN,
lockdown and helper-based egress checks.

Recipes bind the exact app version, signer and OS fingerprint, with explicit
postconditions. The normal CLI has no UI adapter. Unsupported configuration or
private imports therefore produce named assisted checkpoints. App installation and
configuration/consent precede VPN lockdown and required network checks. Never place
account passwords or wipe keys into public recipe text, policies or operator notes.

## Initial screen locks, language and duress

Profiles may declare `defaultCredential` and `defaultLocale`. Only the owner may
declare device-wide `defaultDuress`. This is a partial profile fragment to merge
into an otherwise complete profile:

```json
{
  "defaultCredential": { "type": "password", "secretRef": "owner-initial" },
  "defaultLocale": "en-US",
  "defaultDuress": {
    "ownerCredentialRef": "owner-current",
    "pinRef": "duress-pin",
    "passwordRef": "duress-password"
  }
}
```

Supply private values in `secrets/credentials/<assetId>.json` within the project:

```json
{
  "schemaVersion": 1,
  "values": {
    "owner-initial": "<replace privately>",
    "owner-current": "<replace privately>",
    "duress-pin": "<replace privately with digits>",
    "duress-password": "<replace privately>"
  }
}
```

These placeholders are not usable credentials. Use current-user ownership, file
mode `0600`, private directories and no symlinks. The strict input is limited to
64 KiB. PIN values need 4-128 digits; password values need 4-128 printable ASCII
characters. Both duress values must differ from every ordinary profile credential.
`owner-current` must match the owner's actual unlock credential when duress setup
runs. If the owner changes their initial password at the normal-credential
checkpoint, update this private reference before resuming duress setup.

The order is: initialize eligible empty screen locks, private `normal_credentials`
confirmation, profile language confirmation, then optional owner duress setup and
`duress` confirmation. Previously accepted defaults for the same stable Android
user are not reapplied. Never test destructive activation. Initial command
acceptance does not prove what credential the phone currently uses.

`defaultLocale` accepts one canonical BCP 47 language tag such as `en-US`, `pl-PL`
or `sr-Latn-RS`. It does not set a time zone or the guide language. The historical
`language` alias is readable; if both fields are supplied they must agree. The CLI
normally pauses at `language:<profileId>` for private manual confirmation.

The [encrypted registry](PHONE_REGISTRY.md) is the separate ongoing support record.
It does not automatically consume or synchronize these initialization files, and
its retained current values require explicit confirmation. Follow the
[security boundaries](../SECURITY.md) for both kinds of private input.

## Optional backup tools

The optional personal backup/recovery tools validate policies and compare
the normalized policy with its current lock. For a new setup using multiple model
pins, supply `--codename CODE`; a single model pin remains the default. Backup-only
work and retained masters bind the model to the enrolled device's canonical serial
or the recorded master codename. These tools retain their existing private file,
artifact digest, and product/build identity checks.
