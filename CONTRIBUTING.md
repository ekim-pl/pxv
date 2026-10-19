# Contributing

Use the exact versions in `.node-version`, `package.json`, `pnpm-lock.yaml` and
`packages/runtime/package.json`: Node 24.22.0, pnpm 12.11.2.
Compilation uses TypeScript 7 through `@typescript/native`; TypeScript 6 supplies
ESLint's JavaScript API. See [host setup](docs/HOST_DEPENDENCIES.md) and
[development testing](docs/TESTING.md) for Android/Java/OpenSSH prerequisites.

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build
PXV_REQUIRE_CRYPTO=1 PXV_CHROMIUM=/usr/bin/google-chrome pnpm quality
```

`PXV_REQUIRE_CRYPTO=1` requires genuine APK verification. The explicit local
`PXV_SKIP_ANDROID_CRYPTO=1` diagnostic opt-out is not release acceptance. Do not
replace cryptographic/process fault tests with mocks.

## Change and verify behavior

Keep interfaces calling application services and inject concrete storage/device
ports. Contracts must not import SQLite, subprocesses or adapters. Preserve stable
physical/user identity, exact reviews, native leases, owner-scoped cleanup and durable
recovery state. Measurable requirements belong in the shared observation service
used by attestation and finalization. Read [architecture](docs/ARCHITECTURE.md).

Use focused tests during development and rebuild compiled workers before integration
checks. Every executable TypeScript module/package must meet 90% lines and 85%
branches. TS/JS functions must stay at cyclomatic complexity 10, nesting 4 and 80
nonblank/noncomment lines or below. Java/JavaScript complexity, Java warnings,
ShellCheck, syntax, boundaries and development/production reachability are also gated.
Remove unused internals rather than adding broad exclusions.

Keep regressions meaningful: changed Android user serials, finalization drift,
interrupted ownership, stale contexts, child cleanup and private-data exclusion.
Retain language-independent acceptance fixtures. The complete quality run includes
native faults, merged worker/subprocess coverage and signed helper checks; source
edits during verification invalidate its report. Preserve the exact candidate's
`.quality/report.json` and `.quality/report.md`.

Use synthetic fixtures, private external projects and dedicated authorized phones.
Do not commit credentials, live inventories, ADB/signing keys, state, backups or
recipient material. Never test destructive duress activation. Physical and emulator
acceptance remain separate from passing offline tests; follow the [canary and
recovery runbook](docs/CANARY_BACKUP_RECOVERY.md).

## Documentation and distribution

Update the canonical operator and user guides in English and Polish when behavior
changes. Link focused references through [the documentation index](docs/README.md);
remove obsolete pages instead of retaining competing instructions. Rebuild rendered
editions as described in [guides](guides/README.md), inspect every generated page,
and retain truthful QA records. Do not reuse stale build manifests or physical
acceptance claims.

Build local candidates with `pnpm build:preview`; add explicit formats when needed.
Ordinary builds never publish, install globally or replace stable launchers. Freeze
public resources before final packaging, rerun source-bound quality and follow the
[publication checklist](docs/PUBLICATION_CHECKLIST.md).

Brand forks retain MIT attribution, upstream API markers and safety tests. Use the
[white-label instructions](docs/WHITE_LABEL.md) for the optional scaffold. Keep private
extension sources and customer data outside Community/release assets; trusted
extensions still submit typed actions through normal review and recovery.
