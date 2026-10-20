# Build candidates, distributions, and branded products

Use [build](build.md) for compilation and [guide generation](../operators/guides-and-inserts.md) for device packets. The procedures below turn an unchanged, qualified source identity into reviewable local artifacts and, only through explicit promotion, a release.

## Release procedure

1. Freeze the source/product descriptor, assets, manifests, configuration templates and exact toolchain. Community remains MIT and local workflows remain available without activation.
2. Run `pnpm quality:setup`, run `pnpm build`, then `PXV_REQUIRE_CRYPTO=1 pnpm quality`. Retain the unchanged-source component reports, zero unexplained development/production TypeScript repository findings, native faults, genuine crypto and signed helper checks. Every TypeScript module/package must meet 90% lines/85% branches; all enforced function metrics must pass.
3. Complete the advertised policy/UI/restore/EN-PL/physical acceptance matrix. Keep pending checks visible; never replace missing live evidence with a generic emulator.
4. Build one frozen engine candidate. Inspect its public allowlist, secret-sentinel checks, dependency notices, SPDX SBOM, source digest and tool hashes.
5. Derive the advertised formats from that candidate: portable is the supported default; OCI, Debian and npm are explicit additions. Check external projects, arbitrary working directories, read-only installation roots, preview coexistence and offline extension use. Review the actual local Docker image's caller-UID behavior.
6. Create stable artifacts only with an explicitly supplied release signing key. Keep signing material outside the source/candidate. Verify signed checksums before promotion.
7. Update the canonical operator/user guides and phone-sized quickstart/private insert templates in English and Polish after implementation verification. Run `pxv guides rebuild` from the source checkout with explicit Chromium and Poppler available. Inspect every HTML and office/print PDF page, including A4 guide trim/3 mm bleed boxes and the packet's A4 sheet size, 68 × 100 mm panels and cut/fold placement, and update the guide build/QA records. Keep populated credential inserts outside public resources. Remove stale proofs and CLI transcripts. Freeze those public resources before building the final distributable candidate, and rerun source-bound quality checks after documentation changes.
8. Review the final names/URLs/support contact for the product fork. Commercial extension distribution credentials stay in external registry configuration, not images or project locks.
9. Promote only the verified artifacts through an explicit publication action. Ordinary build/preview commands never push, publish, globally install or replace stable launchers.

~~~sh
pnpm build
node packages/release/dist/cli.js --formats portable,deb,npm,oci > /tmp/pxv-preview-result.json
node tools/check-packaged-runtime.mjs /tmp/pxv-preview-result.json
node packages/release/dist/cli.js --release --signing-key /private/release-key \
  --formats portable,deb,npm,oci
node packages/release/dist/cli.js promote --artifacts ARTIFACT_DIRECTORY \
  --package PACKAGE.tgz --registry https://YOUR_REGISTRY \
  --allowed-signers /private/release-signers --signer RELEASE_ID --dry-run
~~~

Remove `--dry-run` only for an authorized publication to the configured registry. The built-in promotion path verifies real OpenSSH signatures/checksums before npm publication. Repository/OCI/package-repository publishing outside that path requires an equally explicit reviewed release process.

The SEA target is experimental and requires an explicit postject executable plus matching external resources. The portable archive is the supported binary-like distribution baseline. Do not describe the experimental launcher as a self-contained supported phone-management binary.

Candidate and release-provenance schema 2 bind Node 24.22.0, the supervisor JavaScript bundle, Koffi 3.3.3 Linux glibc x64 Node-API 8 prebuild, loader bytes and artifact hashes. Regenerate schema 1 candidates. Every supported distribution contains the supervisor, selected addon and reviewed Koffi notices; qualify installed candidate bytes on Debian 12 and Ubuntu 24.04 without workspace dist mounts. Keep host control reservations and private projects intact.

Before the first public release, replace the reserved `example.org` support email
and URL in `product.json` with maintainer-controlled identities, establish the
repository private vulnerability-reporting route, confirm ownership of the npm
scope and OCI namespace, and distribute the release signer identity through a
trusted channel. Confirm hosted CI and repository protection settings separately; local validation
cannot establish their configuration. Keep any uncompleted
live acceptance and rendered guide review pending. Do not describe local synthetic
tests as phone workflow qualification.

Run `pnpm audit --json` with registry access before promotion and retain the report
alongside the source-bound quality evidence. CI retains `.quality/advisories.json`, the complete source test reports, the packaged
runtime matrix and checksum/provenance records, including files under the hidden
`.quality` directory. Java parser dependencies use exact
Lodash overrides for published security fixes; keep those pins reviewed when
upgrading the parser. An unavailable advisory service is not a clean audit.

## Branded products

A branded product is a separately maintained source fork with its own identity,
policy, support contacts, public assets and release evidence. Branding does not
qualify a deployment. Retain MIT attribution, third-party notices, upstream API
markers and the shared review/ownership/recovery boundaries.

## Scaffold a reviewable fork

Start from [the versioned example](../../config/templates/white-label.example.json).
Choose the product/command/package/image names, real support contacts, approved
artwork/font, profile layout and policy owner. Example Acme identities are placeholders.
Use the pinned [host toolchain](../operators/host-setup.md), then run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm whitelabel:scaffold -- --config ./brand/acme.json --output-dir /tmp/acme-review
```

The optional scaffold validates and writes a product descriptor, guide theme,
brand-specific starter policy, empty project/inventory templates and a `starter`
directory. `--output-dir` allows review before applying files to the fork. Omitting
it writes to the source checkout. Inspect generated files before distributing them.

New descriptors explicitly set `features.extensions` and `features.seedvault` to
`false`. Opt into either reviewed system with boolean `product.features` entries
in the scaffold configuration, for example `"features": { "extensions": true }`.
An omitted feature stays disabled in newly generated products. Existing product
descriptors without `features` retain their compatibility behavior when read.

`starter.policyTemplate` selects `single-simple` (one owner) or `fleet-nerd` (five profile
structures). Generated policies use the supported authoring format.
Neither template supplies deployment-specific OS trust, app pins, VPN accounts,
backup coverage or acceptance. Customize the [policy](../operators/policy-reference.md) before
locking and reviewing it.

`starter.defaultLocale` is a canonical BCP 47 tag applied to generated profiles,
including the owner. Edit individual profiles afterward as needed. It controls
profile language rather than time zone or the English/Polish documentation language.
The `starter.language` field is accepted only when consistent with it.

Keep `product.json.name` and `guides/assets/brand.json.brandName` aligned. Theme input
uses three six-digit hex colors and a CSS-safe font family. Optional local `.ttf` or
`.otf` fonts and `.svg`, `.png`, `.jpg` or `.webp` logos are copied into public assets;
use only approved nonprivate material. See [the guide build](../../guides/README.md).

## Create real projects

Use the fork's built command to initialize each independent project, rather than
copying generated starter state or another phone's database:

```sh
pxv project init --path /absolute/private/project \
  --policy policy-packs/acme/policy.json
```

A project can contain one phone or a fleet. Enroll each target's observed physical
identity and collect its own reviews/checks. Do not clone project UUIDs, approvals,
credentials or device evidence from a reference phone. A private primary-phone backup
must not become a fleet seed. See [device roles and recovery](../operators/recovery-and-maintenance.md).

Community disables extensions and experimental Seedvault through `product.features`.
A fork can explicitly enable a reviewed optional system; descriptor changes alter
reviewed identity and need fresh locks/plans. Legacy descriptors without `features`
retain compatibility behavior. Trusted extensions and recovery still require their
own [extension](extension-reference.md) and [Seedvault](../operators/recovery-and-maintenance.md) qualification.

## Verify and distribute

Run the complete strict quality gate for the exact fork source. Rebuild the operator
and user guides in English and Polish with `pxv guides rebuild`, inspect generated
HTML/PDF pages and retain accurate QA records. Freeze public resources before final packaging.

```sh
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm build:preview
```

Ordinary preview builds do not publish or replace installations. Add optional formats
explicitly and follow the [publication checklist]() for
signature, exact-artifact and live acceptance requirements. Keep extension sources,
registry authentication, customer inventories, credentials and backup data outside
Community sources and release artifacts.

Release candidates and release provenance use schema 2. They record Node, supervisor JavaScript, Koffi version/platform/Node-API version, loader/addon hashes and artifact hashes. Schema 1 candidates must be regenerated. Portable, Debian, npm, OCI and experimental SEA formats include the supervisor bundle, Koffi loader and selected glibc x64 prebuild with reviewed notices. Existing ownership records, IPC protocol and receipts remain schema/protocol 1; policies are unversioned. Never clear host control state to regenerate a candidate. Engine integrity binds source/build bytes and the selected supervisor, addon and loader.
