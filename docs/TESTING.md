# Automated testing

Use the pinned Node/pnpm/compiler environment. Build native ownership before running integrations:

~~~sh
pnpm install --frozen-lockfile
pnpm build:native
pnpm check
pnpm test
pnpm test:native
pnpm test:coverage
~~~

Strict TypeScript enables checked indexed access and exact optional fields. Type-aware linting, formatting, workspace boundary checks and cycle detection accompany tests. Application package targets are at least 90% line and 85% branch coverage; a percentage never replaces scenario coverage. Dedicated storage/extension workers run in separate isolates and are exercised through integration tests.

Important regressions include reused Android user IDs with a different serial, permission drift before finalization, child probe cleanup isolation, inherited environment secret sentinels, an exact asset named all, and capability-based emulator provenance. Process tests use actual native children, owner death, escaped descendants, timeouts, cancellation, durable fences and inherited recovery.

Storage tests cover missing read-only databases, retained malformed JSON, concurrent idempotent submissions, atomic run creation, monotonic compare-and-set floors, event cursors and idempotent native receipt ingestion. Cryptographic tests use real OpenSSH/JAR/APK verification and cover wrong signers/tampering. Extension tests cover exact versions/integrity, offline invocation, missing/incompatible bundles, authentication redaction and unsafe archive handling.

Packaging tests execute archives from another working directory, install npm tarballs offline without lifecycle scripts, inspect Debian control metadata, exercise two fork identities, scan secret sentinels and verify real release signatures. OCI validation additionally tests caller UID and read-only filesystems with a persistent independent ADB service.

Live tests are distinct. Use [E2E testing](E2E_TESTING.md) and retain exact artifact/build/device evidence. Do not translate an offline green result into GrapheneOS, physical hardware, restore or localized UI acceptance.

## Native baseline regression

The supervisor must be static Linux x86_64 with the reviewed musl target. Release tests reject dynamic ELF binaries even when those binaries run on the newer build host. ELF tests cover malformed bounds, shared interpreters and DT_NEEDED/RPATH/RUNPATH entries while allowing self-contained static PIE. CI runs tools/check-native-baseline.mjs on the host and in the Debian 12 OCI runtime: a real lease, child execution, cleanup-proven receipt and zero remaining reservations are required. Merely printing --version is insufficient distribution acceptance.
