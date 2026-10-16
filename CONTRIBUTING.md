# Contributing

Use the exact versions in `.node-version`, `package.json`, `pnpm-lock.yaml` and `rust-toolchain.toml`. Install pnpm 12.11.2 under Node 24.22.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
```

Android cryptographic tests require Java 17+, OpenSSH, SDK platform 35 and Build Tools 35.0.0. Set `ANDROID_HOME` or the explicit host tool overrides. `PXV_REQUIRE_CRYPTO=1` requires genuine APK checks. `PXV_SKIP_ANDROID_CRYPTO=1` is an explicit local diagnostic opt-out, never release acceptance.

The TypeScript 7 compiler is installed as `@typescript/native`; `typescript` points to the official TypeScript 6 compatibility package solely for ESLint's JavaScript API. All application compilation uses `tsc` 7.0.2. Production and test sources enable unused-local/parameter checks, strict typing, exact optional properties and checked indexed access. First-party JavaScript tools/configuration are typechecked and linted for undefined names.

The runtime is a TypeScript workspace with contracts, runtime, adapters, engine, CLI/MCP, SDK, extensions and release tooling. Its native supervisor is Rust 1.99.1 for `x86_64-unknown-linux-musl`; Java 17+, Android SDK platform 35 and Build Tools 35.0.0 support the Android helpers. Preserve the pinned versions in `.node-version`, `package.json`, `pnpm-lock.yaml` and `rust-toolchain.toml` when contributing or creating a product fork.

TS/JS functions must stay at classic cyclomatic complexity 10 or below, nesting 4 or below, and at most 80 nonblank, noncomment lines. Rustfmt and Clippy deny warnings. Pinned Rust Code Analysis checks Rust/Java cyclomatic complexity 10 and reports native cognitive metrics where supported; Java cognitive metrics are explicitly unavailable. ShellCheck and syntax checks cover source and generated launchers. All Java helpers compile with warnings enforced and verified APK signatures.

Package boundaries are checked by `tools/check-boundaries.mjs`: interfaces depend on application services; domain contracts do not import storage, subprocesses or device adapters. Inject concrete adapters. Preserve complete action, observation and recovery contracts when adding a feature. Measurable requirements belong in the shared observation service used by both attestation and finalization.

Tests must cover safety scenarios, not only happy paths or code structure. Every application module and package requires 90% lines and 85% branches, including worker and release entrypoints. `pnpm test:coverage` merges actual Node worker/subprocess evidence into executable source maps; unmatched branch ranges stay uncovered. Keep the language-independent regressions in `tests/acceptance/` and native fault tests. Never replace real crypto or process fault tests with mocks. Controller tests may mock already-tested ports to validate dispatch, consent and error behavior.

Knip checks development and strict production graphs with explicit worker/executable entries. Preserve documented public contracts and existing façade port types; explain narrow public/test seams in source. Remove unused internal code instead of adding broad exclusions. The aggregate report rejects failed stages, stale evidence and source edits during verification; retain `.quality/report.json` and `.quality/report.md` for the exact candidate.

Use disposable external projects and dedicated test phones. Do not commit `.env`, private registry credentials, ADB keys, signing keys, inventories, state, backups or recipient material. Do not run destructive actions on an unidentified target. Record emulator provenance separately from physical acceptance. Never test destructive duress activation.

Follow [development testing](docs/TESTING.md) for checkout setup, targeted tests, watch mode, rebuild requirements and complete coverage. Before a physical visit, follow the separate [canary, backup and recovery runbook](docs/CANARY_BACKUP_RECOVERY.md); it distinguishes disposable phones from protected reference and primary master devices.

Build local candidates with `pnpm build:preview --formats portable,deb,npm,oci`. Ordinary builds never publish or replace stable installations. Stable promotion requires signatures and retained package/live evidence. Update all affected English and Polish guides after behavior is verified, then follow the [guide rebuild](guides/README.md) through explicit Chromium/Poppler and inspect every rendered page. Freeze those resources before final packaging and retain a fresh source-bound quality report.

White-label forks retain upstream engine/API versions and safety tests. Keep private extensions out of Community sources; extensions submit typed actions to core services. See [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md) and [publication](docs/PUBLICATION_CHECKLIST.md).

For a brand-labeled fork, use the versioned input format in `config/templates/white-label.example.json` and run `pnpm whitelabel:scaffold -- --config FILE`. The generator creates the fork's `product.json`, guide theme, brand-specific starter policy and empty project/device templates without changing the `product.json` schema or Community's `reference-five` default. Review [white-label forks](docs/WHITE_LABEL.md) for policy selection, the generated starter and master-device roles. Do not check in tenant inventories, credentials, private logo inputs or backup content.

Rebuild the eight EN/PL guide sources and their office/print outputs from the source checkout with `pxv guides rebuild [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]`. The command builds the renderer first; Poppler is still required for PDF quality evidence. Review every page image before distributing the sixteen PDFs. See [guide rebuild and branding](guides/README.md).
