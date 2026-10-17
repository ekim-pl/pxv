# White-label forks

A branded product is a separately maintained source fork with its own identity,
policy, support contacts, public assets and release evidence. Branding does not
qualify a deployment. Retain MIT attribution, third-party notices, upstream API
markers and the shared review/ownership/recovery boundaries.

## Scaffold a reviewable fork

Start from [the versioned example](../config/templates/white-label.example.json).
Choose the product/command/package/image names, real support contacts, approved
artwork/font, profile layout and policy owner. Example Acme identities are placeholders.
Use the pinned [host toolchain](HOST_DEPENDENCIES.md), then run:

```sh
pnpm install --frozen-lockfile
pnpm build:native
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

`starter.policyTemplate` selects `simple` (one owner) or `reference-five` (five profile
structures). Generated policies use the supported version 2 authoring format.
Neither template supplies deployment-specific OS trust, app pins, VPN accounts,
backup coverage or acceptance. Customize the [policy](POLICY_FORMAT.md) before
locking and reviewing it.

`starter.defaultLocale` is a canonical BCP 47 tag applied to generated profiles,
including the owner. Edit individual profiles afterward as needed. It controls
profile language rather than time zone or the English/Polish documentation language.
The legacy `starter.language` alias is accepted only when consistent with it.

Keep `product.json.name` and `guides/assets/brand.json.brandName` aligned. Theme input
uses three six-digit hex colors and a CSS-safe font family. Optional local `.ttf` or
`.otf` fonts and `.svg`, `.png`, `.jpg` or `.webp` logos are copied into public assets;
use only approved nonprivate material. See [the guide build](../guides/README.md).

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
must not become a fleet seed. See [device roles and recovery](CANARY_BACKUP_RECOVERY.md).

Community disables extensions and experimental Seedvault through `product.features`.
A fork can explicitly enable a reviewed optional system; descriptor changes alter
reviewed identity and need fresh locks/plans. Legacy descriptors without `features`
retain compatibility behavior. Trusted extensions and recovery still require their
own [extension](EXTENSIONS.md) and [Seedvault](SEEDVAULT_AUTOMATION.md) qualification.

## Verify and distribute

Run the complete strict quality gate for the exact fork source. Rebuild the operator
and user guides in English and Polish with `pxv guides rebuild`, inspect generated
HTML/PDF pages and retain accurate QA records. Freeze public resources before final packaging.

```sh
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm build:preview
```

Ordinary preview builds do not publish or replace installations. Add optional formats
explicitly and follow the [publication checklist](PUBLICATION_CHECKLIST.md) for
signature, exact-artifact and live acceptance requirements. Keep extension sources,
registry authentication, customer inventories, credentials and backup data outside
Community sources and release artifacts.
