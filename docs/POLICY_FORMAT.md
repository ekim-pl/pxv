# Policy format and migration

Existing `schemaVersion: 1` policies and retained policy locks remain readable. Their
normalized content and digest are unchanged. Conflicting `global` values in legacy
profiles are rejected because Android applies them to the whole phone.

Use `schemaVersion: 2` to define an `apps` catalog once, reference catalog IDs from
each profile's `apps` list, and place all `global` Android settings in the top-level
`deviceSettings` list. Profile `settings` accept only `secure` and `system` entries.
Other profile fields, including permissions, VPN settings and pinned recipes, keep
their existing meaning. Permissions and VPN fields still use Android package IDs.

```json
{
  "schemaVersion": 2,
  "id": "personal",
  "version": "0.1.0",
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

Catalog values are the existing pinned artifact objects: `packageId`, `versionCode`,
`sha256`, `signerSha256`, and an approved path, URL or repository source. App versions
remain shared between Android users; conflicting catalog versions are rejected.

For mixed Pixel models, v2 `os` is a map keyed by codename. Each value is a complete
existing OS pin (`codename`, `release`, official `url` and `signatureUrl`,
`signerPrincipal`, `namespace`, and `publicKey`). The map key must equal that pin's
codename. Selection never falls back to another model's image. An enrolled model
without a pin cannot be flashed or pass pinned OS verification.

Convert explicitly, keeping the original policy and historical lock untouched:

```sh
pxv policy convert --project-root /path/to/project --output /path/to/project/policy.v2.json
```

The output must be a new file; conversion refuses existing files and symlinks. Review
the output, update `policyFile` in `pxv.project.json` to `policy.v2.json`, and run
`pxv policy validate` and `pxv policy lock`. Prepare and approve a fresh plan before
execution. Conversion does not activate the file or migrate approved runs. Normalized
v2 policies retain a format marker in their digest, so v1 approvals cannot authorize
the converted policy.

The engine still uses its stable v1 action and observation contracts. It expands app
references, assigns device settings to the owner once, and retains model-specific
image pins internally. `project init --policy FILE` preserves the chosen authoring
format in the new project.

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

Per-profile settings, permission grants and VPN policy remain explicit. Configure
device-wide `global` settings only in `deviceSettings`; conflicting legacy global
values fail validation. See [network policy](NETWORK_POLICIES.md) for always-on VPN,
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

The optional personal backup/recovery tools accept both policy formats and compare
the normalized policy with its current lock. For a new setup using multiple model
pins, supply `--codename CODE`; a single model pin remains the default. Backup-only
work and retained masters bind the model to the enrolled device's canonical serial
or the recorded master codename. These tools retain their existing private file,
artifact digest, and product/build identity checks.
