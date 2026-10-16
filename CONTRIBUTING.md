# Contributing

Use the exact versions in `.node-version`, `package.json`, `pnpm-lock.yaml` and `rust-toolchain.toml`. Install pnpm 12.11.2 under Node 24.22.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm build:native
pnpm check
pnpm test:coverage
pnpm test:native
```

Android cryptographic tests require Java 17+, OpenSSH, SDK platform 35 and Build Tools 35.0.0. Set `ANDROID_HOME` or the explicit host tool overrides. `PXV_REQUIRE_CRYPTO=1` requires genuine APK checks. `PXV_SKIP_ANDROID_CRYPTO=1` is an explicit local diagnostic opt-out, never release acceptance.

The TypeScript 7 compiler is installed as `@typescript/native`; `typescript` points to the official TypeScript 6 compatibility package solely for ESLint's JavaScript API. All application compilation uses `tsc` 7.0.2. Strict typing, exact optional properties, checked indexed access, exhaustive unions and typed lint are required.

Package boundaries are checked by `tools/check-boundaries.mjs`: interfaces depend on application services; domain contracts do not import storage, subprocesses or device adapters. Inject concrete adapters. Preserve complete action, observation and recovery contracts when adding a feature. Measurable requirements belong in the shared observation service used by both attestation and finalization.

Tests must cover safety scenarios, not only happy paths or code structure. Required application coverage is 90% lines and 85% branches. Keep the language-independent regressions in `tests/acceptance/` and native fault tests. Never replace real crypto or process fault tests with mocks. Controller tests may mock already-tested ports to validate dispatch, consent and error behavior.

Use disposable external projects and dedicated test phones. Do not commit `.env`, private registry credentials, ADB keys, signing keys, inventories, state, backups or recipient material. Do not run destructive actions on an unidentified target. Record emulator provenance separately from physical acceptance. Never test destructive duress activation.

Build local candidates with `pnpm build:preview --formats portable,deb,npm,oci`. Ordinary builds never publish or replace stable installations. Stable promotion requires signatures and retained package/live evidence. Update all affected English and Polish guides after behavior is settled, then run `pnpm docs:build` and inspect the rendered proofs.

White-label forks retain upstream engine/API versions and safety tests. Keep private extensions out of Community sources; extensions submit typed actions to core services. See [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md) and [publication](docs/PUBLICATION_CHECKLIST.md).
