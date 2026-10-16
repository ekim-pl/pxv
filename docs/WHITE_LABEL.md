# White-label forks

For an ordered, gated rollout checklist, see the [white-label branded rollout plan](WHITE_LABEL_BRAND_PLAN.md).

A branded product is a separately owned fork with its own `product.json`, policy pack, public assets, guide theme, support details, source reviews and release evidence. The fork may use PXV's engine and public contracts, but branding does not qualify its policies or transfer responsibility for a customer's devices and data.

## Current technical stack

- Node.js 24.22.0 and pnpm 12.11.2, pinned by `.node-version`, `package.json` and `pnpm-lock.yaml`.
- TypeScript 7.0.2 through `@typescript/native`; the official TypeScript 6 compatibility package supplies ESLint's JavaScript API.
- A layered workspace for contracts, runtime, adapters, engine, CLI/MCP, SDK, extensions and release tooling.
- A Rust 1.99.1 native process supervisor targeting `x86_64-unknown-linux-musl`.
- Java 17+, Android SDK platform 35 and Build Tools 35.0.0 for Android helpers.
- Chromium and Poppler for guide rendering and page-level PDF review.

Read [host dependencies](HOST_DEPENDENCIES.md) and [development testing](TESTING.md) for the pinned setup and quality gate. A product fork retains the upstream engine/API markers until it deliberately maintains a compatible divergence. Keep the shared ownership, review, recovery and host-control services; a second brand must not create a separate control domain for the same phones.

## Create a branded fork and starter

Fork the repository, retain MIT attribution and third-party notices, and prepare a versioned JSON file from [the example](../config/templates/white-label.example.json). The input contains a product identity and support contact, three guide colors, a font family, optional logo/font files, and an optional starter-policy choice.

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
pnpm build
pnpm whitelabel:scaffold -- --config ./brand/acme.json
```

The scaffold command validates the input and generated objects against the existing contract schemas. It writes:

- `product.json` with the brand name, command/package/image identities, support contact, optional logo asset, and a new `defaultPolicy` path.
- `guides/assets/brand.json` plus copied optional logo and font files for both guide languages and print modes.
- `policy-packs/<product-id>/policy.json`, based on `simple` by default or `reference-five` when explicitly selected.
- `config/templates/project.json`, `config/templates/pxv.project.json` and a blank inventory template.
- `starter/pxv.project.json`, `starter/policy.json` and `starter/inventory.json` for review and local use.

`--output-dir DIR` can send all generated files to a separate review directory. The checked-in Community product remains `pxv Community`, continues to use `policy-packs/reference-five/policy.json`, and is not changed until the scaffold command is explicitly run in that checkout. The scaffold never reads or writes the deprecated `config/manifest.yaml` and does not alter the strict `product.json` schema.

The generated `simple` policy has one owner profile, no app pins, no extra permissions, no settings or VPN, and an empty device inventory. The optional `reference-five` template has five profile structures. Neither defines an organization's app trust, OS release, permissions, network controls, privacy notices, retention, legal basis or recovery promise. Review and customize those requirements before onboarding a user.

The generated project template has a starter ID for documentation. For each real project, use `pxv project init --path NEW_DIRECTORY --policy policy-packs/<product-id>/policy.json` so PXV creates a new project identity, database and empty inventory. Then enroll only the observed target phone. Do not copy a reference phone's project marker, approvals, history, credentials or device identity into another project.

Product identity, guide theme and device policy are separate inputs with aligned display names. Keep `product.json.name` and `guides/assets/brand.json.brandName` equal. Use three six-digit hex colors and a CSS-safe font family. Provide a local `.ttf` or `.otf` file for consistent cross-host font embedding; otherwise the chosen font must already be installed on the render host. Provide an optional `.svg`, `.png`, `.jpg` or `.webp` logo path relative to the JSON file. The generator copies it into the public guide assets. Do not use credentials, customer marks without approval, or private files as assets.

The generated policy has no device-specific configuration. Choose profile names and `starter.defaultLocale` in the input as appropriate; then review a product-specific policy for exact operating-system identity, trusted application package/version/signer, settings, permissions, network, backup and manual checks. PXV rejects unresolved or malformed declarations, but a valid schema is not evidence that a policy is suitable for deployment.

`starter.defaultLocale` accepts one BCP 47 language tag with optional region or script, such as `de-DE` or `sr-Latn-RS`, and applies it to every generated profile, including the owner. Tags are canonicalized. The legacy `starter.language` alias is accepted; if both fields are present they must resolve to the same canonical tag. Generated profiles use only `defaultLocale`. After generation, edit each profile independently, for example owner `en-US`, work `pl-PL` and travel `de-DE`, then validate and lock the policy. Locale setup uses an accepted UI adapter or a manual step after normal credentials and before optional duress. These values do not set a time zone or the EN/PL language of guides and handoff documents.

## Treat master phones by role

Record a master as a **reference phone**, a **primary phone with real owner data**, or both. The roles have different reuse and access boundaries:

| Role | Reusable material | Backup scope and access |
| --- | --- | --- |
| Reference | Reviewed policy, public assets/configuration, exact software identities, and sanitized or synthetic test data after coverage review | A reference backup may become a fleet seed only after checking its data and testing the selected restore path; restrict write and seed access to named operators |
| Primary | The same owner's personal or business information for recovery | Private to that owner and authorized recovery operators; restore only for the same owner or an approved replacement, never as a seed for unrelated users |
| Both | Reference configuration plus real primary data on one device | Treat the whole backup as primary/private. Make a reusable sanitized reference seed from a separate device or independently validated template dataset; keep destinations, permissions and records separate |

Use the existing host-only `pxv seedvault inspect`, `backup`, `restore` and `report` operations for one exact enrolled phone at a time. Inspect first, prepare and review the operation, approve it in the same command or through the supported request workflow, then inspect the run and per-profile report. Backup and restore requests can use `--file REQUEST.json` and a reviewed `--seedvault-adapter FILE`; `--dry-run` prepares a plan without executing it. The workflow retains the plan, explicit review, run and result evidence. A production Seedvault UI adapter still needs exact-build qualification; see [Seedvault limits](SEEDVAULT_AUTOMATION.md) and the [canary and recovery runbook](CANARY_BACKUP_RECOVERY.md).

When both roles apply, keep separate role labels, destination generations, access lists, retention and restore authorization. Do not convert a primary backup into a fleet source by changing its folder name. The backup report must describe which profiles, apps, file sets and unsupported categories were observed. It must not imply universal restore coverage. App-specific exclusions, hardware-backed keys, service logins, MFA, passkeys, eSIMs and account-side data may need separate owner-controlled recovery.

Project state and phone data are different. Do not clone `pxv.sqlite3`, project IDs, previous approvals, physical phone IDs, credentials, signing keys or device-specific evidence. Give every target a fresh project and observed inventory identity, prepare a new plan and collect new checks. Restoring app data is supported only to the extent of the exact OS, app and transport's demonstrated behavior.

## Build and verify the fork

Run the complete quality gate for the exact fork sources and keep its report with that candidate. Use an isolated project and disposable canary first; retain product identity, policy lock, artifact hashes, emulator provenance, physical acceptance and recovery evidence separately.

```sh
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm build:preview --formats portable,deb,npm,oci
```

After reviewing product identity and initial policy, run the new fork's own build. An ordinary preview does not publish or replace stable installations. See [publication](PUBLICATION_CHECKLIST.md) for signed artifacts, frozen inputs and release evidence.

## Generate and review branded guides

Guide content remains generic Markdown in `guides/source/markdown`. There are four guide types (product, operator, user and business fleet), each in English and Polish. `guides/assets/brand.json` supplies the name, primary/secondary/accent colors, font family, and optional logo/font assets. Cover photos are replaceable public assets under `guides/assets/photos`.

From the fork's source checkout, use `pxv guides rebuild` or the existing `guides/rebuild.sh` wrapper. The CLI builds the TypeScript renderer first, then creates eight accessible HTML editions and sixteen PDFs: A4 office and full-color print for each edition. Print PDFs use an A4 `TrimBox`, a 3 mm bleed area on selected opening pages, and full-color page backgrounds. Office PDFs use A4 pages, a lighter layout and page numbers. Review every page image and the QA manifest before distribution. The pipeline makes no PDF/X, ICC profile or commercial print-proof claim.

```sh
pxv guides rebuild --chromium /usr/bin/google-chrome
```

See [guide sources, branding and rebuild QA](../guides/README.md). Keep PDFs as generated release artifacts rather than source files. Rebuild after changing the Markdown, brand JSON, colors, fonts, logos or photos.

## Commercial boundary

Community includes its local workflow for free. Keep commercial extension sources in private repositories and distribute exact-version packages through an authenticated private registry. Extensions are trusted code; registry access controls distribution, not runtime activation. Keep customer inventories, backup repositories, recipient data and credentials outside source and release assets.
