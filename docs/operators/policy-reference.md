# Authoring and reviewing device policies

Use this reference when preparing either a [single-device](single-device.md) or [fleet](fleet.md) project. Start from a structural policy pack, replace deployment-specific trust and configuration, validate it, and bind device work to a reviewed lock.

A policy declares the intended device and profile configuration. Validate and lock
it before preparing and approving provisioning work.

A matching `policy.lock.json` is required before planning and is checked again
before submission, refresh, execution/resume, attestation and finalization.
`policy validate` reports `policyLockStatus` as `current`, `missing`, `stale` or
`invalid`; a valid authored policy still validates successfully before locking.
Review the baseline and run `policy lock` explicitly when renewal is needed.
Executable upgrades also require a renewed lock and fresh operational reviews.
Inspection/history, cancellation, typed recovery, lifecycle recording, offline
registry/export and custody confirmation remain available without a current lock.

## Choose the policy command

| Task | Command | Result |
| --- | --- | --- |
| Fill missing version/hash/signer pins in a source draft | `policy resolve-apps` | Verifies all catalog apps and writes a complete pinned policy; existing pins remain constraints. |
| Upgrade existing pins from already trusted F-Droid repositories | `policy update-apps` | Selects compatible stable releases, retains the APK signer and never downgrades; reports unsupported sources as skipped. |
| Validate a complete authored policy | `policy validate` | Reports validation and the resolved policy digest; does not acquire missing pins or write a lock. |
| Accept the reviewed policy as the project baseline | `policy lock` | Writes a fresh policy lock after confirmation; does not provision a phone or approve a device plan. |

Both app commands inspect every authored catalog entry, including unused ones.
They edit files after confirmation and never install apps. Review the proposed
pins, source and signer; then validate, lock, and review a new device plan. Their
`--dry-run` downloads and verifies artifacts without writing a policy or creating a
device execution plan. `--yes` accepts the current write, and `--json` returns the
structured discovery result.

Choose either the project policy or standalone `--policy FILE`; do not combine
`--policy` with `--project-root`. Compatibility comes from one enrolled `--asset`
(with optional `--transport`) or an explicit `--sdk N --abi ABI[,ABI...]` pair.
Standalone files require the pair. Use the intended Android release's SDK and ABI
values; one phone's selection does not establish compatibility across a mixed fleet.

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

## Resolving app sources into pins

`policy resolve-apps` accepts a source authoring document (`PolicySourceDocument`)
with the same catalog, profiles and configuration as a normal policy. Each app
requires its `packageId` and one source; `versionCode`, `sha256` and `signerSha256`
may be omitted independently. For example, the `apps` catalog may contain:

```json
{
  "messenger": {
    "packageId": "org.example.messenger",
    "source": { "kind": "direct", "url": "https://publisher.example/app.apk" }
  },
  "store": {
    "packageId": "com.aurora.store",
    "source": { "kind": "fdroid" }
  }
}
```

### Resolve a source draft before project initialization

`project init` requires a fully pinned policy. If a new policy omits app pins,
resolve it as a standalone document first. This example uses SDK 36 and arm64;
substitute the intended phone's actual compatibility values and private file paths.

```sh
pxv policy resolve-apps --policy /absolute/private/policy.sources.json \
  --sdk 36 --abi arm64-v8a --output /absolute/private/policy.pinned.json --dry-run
pxv policy resolve-apps --policy /absolute/private/policy.sources.json \
  --sdk 36 --abi arm64-v8a --output /absolute/private/policy.pinned.json
pxv project init --path "$P" --policy /absolute/private/policy.pinned.json
pxv policy validate --project-root "$P"
```

The second command discovers again and presents its own review before confirmation.
It preserves the draft file. Initialization copies the complete policy and records
its initial lock; later edits require another explicit `policy lock`. A project
whose policy was subsequently edited to omit pins can use `resolve-apps` directly.

The resolver accepts `fdroid` as an authoring alias and writes canonical `fdroidcl`.
Inline `fdroid-repository` sources require an already trusted repository certificate
`fingerprint`. Existing `repositoryId`, legacy `url` and local `path` inputs also
work. Local paths must be contained within the project, or beside a standalone
policy. Source objects cannot be combined with legacy source fields.

Preview against an enrolled phone or an explicit SDK/ABI pair, then write after
review. Standalone files require the explicit pair; `--abi` accepts comma-separated
ABIs. `--asset` and optional `--transport` perform the same read-only identity and
compatibility observations as `update-apps`.

```sh
pxv policy resolve-apps --project-root "$P" --asset PHONE --dry-run
pxv policy resolve-apps --project-root "$P" --asset PHONE --yes
pxv policy resolve-apps --policy policy.sources.json \
  --sdk 36 --abi arm64-v8a --dry-run
pxv policy resolve-apps --policy policy.sources.json \
  --sdk 36 --abi arm64-v8a --output policy.pinned.json --yes --json
```

By default the input is updated in place. `--output FILE` writes a separate policy
without changing the project's configured policy path. Existing output files use
the ordinary confirmation and revision checks. `--yes` accepts the write;
`--dry-run` downloads and verifies every app without writing either file. `--json`
emits one result on stdout, with the review on stderr.

Direct sources resolve the APK currently served at the declared URL. All supplied
pins are constraints, including a supplied version. PXV verifies the APK signature,
package, version, hash and SDK/ABI compatibility before filling missing pins. If a
direct source has no signer pin, the review shows its observed certificate
fingerprint. Confirming the write establishes that first source-observed signer
pin; it does not independently establish the publisher's identity. Later resolutions
must match that signer. Use `update-apps` when you intend to upgrade existing pins.

Repository sources use the isolated host `fdroidcl`, authenticated `index-v1.jar`,
repository freshness checks and existing project freshness floors described below.
Without an explicit version, resolution selects the highest compatible version at
or below signed `suggestedVersionCode` satisfying supplied pins. Missing stable
metadata is an error unless an exact version was supplied. Explicit versions are
resolved exactly, including versions above that stable suggestion. Repository
certificate pins are never discovered automatically.

Host prerequisites are `aapt` and `apksigner` for all APKs, plus `fdroidcl` and Java
for repository sources. Resolution performs network discovery on the host; no apps
are installed. Every catalog entry, including unused entries, must resolve and the
complete output must pass normal strict policy validation. Unsupported sources,
missing candidates, incompatible APKs, conflicting identities or verification
failures abort the entire write. No incomplete entries are skipped.

Results include `resolutions` with `before`, `after`, `discovered` pin names and
newly `observedSignerSha256`, plus `unchanged`, `destination`, `written` and
`policyLockRequired`. Catalog IDs, references, unrelated configuration and authored
omissions are preserved. Fully pinned no-op inputs are verified and left byte-for-byte
unchanged. Temporary downloads are removed even on failure or interruption, and
revision checks protect input, output and project sources against concurrent edits.

Normal policy validation, project initialization and execution still require fully
pinned policies. A project whose configured policy has incomplete pins can be read
by `resolve-apps`. Resolution leaves its existing policy lock untouched. After
changing the active project policy, run `policy validate`, explicitly create a fresh
`policy lock`, and prepare and review a new plan. A separately written output must
first be adopted as the project's policy before that workflow. Local path strings
are preserved; retain their artifact layout when moving or adopting output.

## Updating app pins

`policy update-apps` refreshes trusted F-Droid repositories through the host
`fdroidcl` command, verifies each proposed APK and updates its exact version code
and SHA-256. It supports a project's configured policy and standalone authored
policy files, including starter packs. Preview a project update against an enrolled
phone, then apply the reviewed result:

```sh
pxv policy update-apps --project-root "$P" --asset PHONE --dry-run
pxv policy update-apps --project-root "$P" --asset PHONE --yes
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
```

For discovery without a connected phone, supply the intended Android SDK level
and CPU ABIs. Remote sources still require network access. Use the
same pair with `--project-root` when a phone is unavailable. Standalone files require
the pair and cannot be combined with `--project-root` or `--asset`:

```sh
pxv policy update-apps --policy policy-packs/fleet-nerd/policy.json \
  --sdk 36 --abi arm64-v8a --dry-run
pxv policy update-apps --policy policy-packs/fleet-nerd/policy.json \
  --sdk 36 --abi arm64-v8a --yes --json
```

Choose the SDK level of the intended phone; `--abi` accepts a comma-separated list.
`--asset` reads and checks the enrolled phone's identity, SDK and ABIs through its
selected transport. The command refreshes repository metadata and downloads APKs
for verification. It edits the policy after confirmation; `--yes` accepts that
write and `--dry-run` only reports verified proposed changes. `--json` emits one
result document on stdout, with progress and the pre-write review on stderr.

Trusted sources are official F-Droid, inline `fdroid-repository` sources, and shared
`repositoryId` references. Direct URLs beneath an unambiguous trusted repository
root can be refreshed while retaining their existing source representation. Custom
repository signing-certificate pins must already appear in the policy. Publisher
downloads and local APKs without a trusted repository mapping are reported as
skipped. Consequently, the current starter packs can refresh Rethink and Aurora;
Session and Orbot need repository trust anchors in their policy before this command
can refresh their direct URLs. Other publisher downloads need their own release
review.

Each repository must expose `index-v1.jar` for `fdroidcl`. PXV independently
authenticates the downloaded JAR, checks its timestamp against the configured
freshness window and any existing project freshness floor, and reads its signed
`suggestedVersionCode`. The highest compatible version at or below that value is
eligible as stable. Missing stable metadata or compatible builds produce a skip
reason. Stability is never guessed from version names. Discovery leaves execution
freshness floors unchanged.

The v1 verifier accepts the protocol's legacy SHA-1 JAR signatures only inside its
separate verification process, with the exact repository certificate pin and all
other Java JAR algorithm restrictions retained. Host Java security settings remain
unchanged. Full v1 index JSON is bounded to 128 MiB; APK hashes and repository/APK
certificate fingerprints use SHA-256.

The updater preserves the existing APK signer and prevents downgrades. Signing-key
changes, conflicting APK identities, replacement bytes for an existing pinned
version, or verification failures stop the entire write. Every new APK must match
the authenticated repository's content hash, package ID, version code and signer,
and pass APK compatibility inspection. Temporary client state is isolated from the
host's fdroidcl configuration and removed after completion or cancellation.

All authored catalog entries are considered, including unused entries. Catalog IDs,
profile references and unrelated policy configuration are preserved. No-op runs
leave the original file bytes intact. Revision checks preserve concurrent edits
while a download or confirmation is pending. The result lists `updates` with
`before`/`after` pins, `unchanged` IDs, `skipped` reasons, `written` and
`policyLockRequired`. Inspect every `skipped` reason; a successful command does
not mean every app was upgraded. Publisher APK updates require separate release
and signer review; `resolve-apps` will reject changed bytes against existing pins.
Project writes leave the previous lock in place for explicit
replacement; validate and lock the policy and review a fresh plan before execution.

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

Per-profile settings, permission grants and VPN policy remain explicit. A non-null VPN package requires `alwaysOn: true`; disabling always-on requires `packageId: null`. Lockdown requires always-on VPN. Probe endpoints support exact HTTPS query strings, and expected egress CIDRs must have valid prefixes and no host bits or IPv6 zone scopes. Invalid combinations are rejected during validation. Configure
device-wide `global` settings only in `deviceSettings`; profile settings cannot use
that namespace. See [network policy]() for always-on VPN,
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

The [encrypted registry](registry.md) is the separate ongoing support record.
It does not automatically consume or synchronize these initialization files, and
its retained current values require explicit confirmation. Follow the
[security boundaries](../../SECURITY.md) for both kinds of private input.

## Optional backup tools

The optional personal backup/recovery tools validate policies and compare
the normalized policy with its current lock. For a new setup using multiple model
pins, supply `--codename CODE`; a single model pin remains the default. Backup-only
work and retained masters bind the model to the enrolled device's canonical serial
or the recorded master codename. These tools retain their existing private file,
artifact digest, and product/build identity checks.

## Executable Android constraints

Profile names contain 1–80 characters and exclude control characters, `:` and `}`.
Setting keys match `[A-Za-z][A-Za-z0-9_.:-]{0,127}`; values contain at most 4096
characters and exclude NUL, CR and LF. Runtime permission names match
`android.permission.[A-Z0-9_]+`. These constraints apply to authored policies,
expanded policies and contributed actions; retained observation parsing stays
separate. Errors identify the affected field before artifact acquisition or device
changes.

The secure keys `always_on_vpn_app` and `always_on_vpn_lockdown` are reserved for
the witnessed VPN workflow. Remove them from `settings` and use the `vpn` block,
even when their values match. Policies, contributed actions and the adapter reject
these declarations before device commands; retained observations remain readable.

Each provisioning run includes a witnessed `vpn_settings` checkpoint for every
profile. Saved VPN configuration is read back; PXV does not enable live enforcement
by writing secure settings. See [VPN verification](). Probe
endpoints reject empty user-info (`https://@host`) and empty fragments (`https://host/#`)
as well as populated credentials/fragments and raw whitespace or controls. Accepted
query strings, including `%23` and `@` in parameter values, remain byte-exact.

## Network policies and evidence

Network configuration belongs to a specific profile and application UID. The policy can declare a VPN package, always-on state, lockdown and a signed helper probe. Profile isolation is not proof that every app follows a particular route.

The adapter reads saved VPN configuration and package/user identity. Saved secure settings do not prove live always-on or lockdown enforcement. A network probe installs a content/signer-pinned helper, binds its Android user serial, tests reviewed HTTPS endpoints and expected egress CIDRs, performs requested failure checks and removes only its owned helper/resources. The evidence scope is `probe-app-uid-https-only`.

Provisioning installs apps and completes their reviewed configuration before a
`vpn_settings` checkpoint for **every profile**, including already-matching and
disabled VPN configurations. A changed VPN without a matching app recipe may first
pause at `app_setup` for private account setup and Android consent.

At `vpn_settings`, open Android's VPN Settings in the exact profile named by the
pause. Configure or witness the selected package, Always-on VPN and Block connections
without VPN toggles. Record `device attest --check vpn_settings --asset ASSET
--operator OPERATOR`, then resume the run. Each profile needs its own confirmation;
a receipt for another profile or an old plan cannot substitute. Only the active
profile's reviewed VPN transition is permitted during this checkpoint.

PXV verifies saved configuration without writing the secure VPN settings. The proof
is labeled `operator-witnessed-settings`, not an automated live-enforcement
measurement. Finalization requires the profile's bound witness proof as well as
policy-required network probes and human checks. A new provisioning run requires
new confirmations; missing proofs in retained state require newly reviewed
provisioning. Review refresh preserves validated completed proofs and requires a
fresh confirmation for unfinished work.

The ordinary `settings` list rejects secure keys `always_on_vpn_app` and
`always_on_vpn_lockdown`. Remove those declarations and express the requested state
in `vpn`; matching duplicate declarations are also rejected. Historical observations
remain readable, but affected retained execution plans require a fresh review.

A proof checksum alone is insufficient. Readiness, finalization and review refresh
validate the retained source plan, completed VPN action, derived run identity,
consumed receipt and exact attestation audit snapshot. Carried proofs must follow
the committed refresh chain. Missing or changed provenance blocks acceptance and
remains available for inspection; it is never repaired by rewriting evidence.
Expired source execution approval does not invalidate a completed proof. Execution
approval expiry and the 15-minute acceptance-measurement window remain separate.

Configure expected routes and endpoint responses from the deployment's actual service, not a copied sample. A passing helper probe cannot establish the routing of every browser, system component, DNS resolver, tethered client or background app. Test representative actual apps and failure/reconnection behavior, then record the policy's named human checks.

When a probe succeeds or fails, its child cleanup scope must not release provisioning's parent resources, such as keep-awake. An interrupted probe leaves recoverable helper obligations. Never uninstall a package from a recreated user solely because its numeric Android user ID/name match an old record.

VPN/account credentials are entered privately by the recipient or approved owner.
Authorized retention uses the separate [encrypted registry](registry.md);
registry values do not automatically configure the VPN. Keep secrets out of policy
manifests, recipe text, source control, notes and screenshots. A file staged for a
specific recipe must be declared and digest-bound; staged data is private project
material and must be removed through owned cleanup.

After OS, app, VPN or policy changes, repeat live checks. A stale attestation or a diagram of the intended route is not measured evidence. Unsupported UI flows remain manual. The operator owns deciding whether the specific pack's app and failure coverage is sufficient for its promised behavior.

## Configuration validation

A VPN package selects Android’s always-on VPN: `alwaysOn` must be true exactly when
`packageId` is non-null. To disable always-on VPN, set `packageId` to null and both
booleans to false. Lockdown requires always-on VPN. Invalid combinations fail policy
validation before provisioning changes the phone.

Probe endpoints are exact reviewed HTTPS URLs. Query strings are supported and
passed unchanged to the helper; credentials, fragments and redirects are refused.
Do not place private credentials in query parameters. Expected egress ranges must
be valid IPv4/IPv6 CIDRs with bounded prefixes and no host bits or IPv6 zone scopes.
Malformed ranges fail policy validation before artifact acquisition or phone changes.
