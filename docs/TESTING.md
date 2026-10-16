# Developing and testing pxv

Run the commands below from the checkout root. The normal development suite uses synthetic policies, local fixture artifacts, temporary projects and real supervised test processes. It does not require a connected phone. For physical-device experiments, start with [canary, backup and recovery testing](CANARY_BACKUP_RECOVERY.md), then follow [E2E testing](E2E_TESTING.md).

Development source, test, configuration and CI links in this guide refer to the matching source checkout. Installed distributions do not contain the development workspace or test suite.

## Set up a development checkout

Use the exact workspace versions; `.npmrc` enforces the Node/pnpm engine requirements.

| Component           | Required setup                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Host                | Linux x86_64; supported baselines are Ubuntu 24.04 and Debian 12                                     |
| Node.js             | 24.22.0 LTS                                                                                          |
| pnpm                | 12.11.2                                                                                              |
| TypeScript compiler | 7.0.2, installed by the lockfile as `@typescript/native`                                             |
| Rust                | 1.99.1 with rustfmt, Clippy and `x86_64-unknown-linux-musl`                                          |
| Java                | JDK 17 or newer, including `java`, `javac`, `jar` and `keytool`                                      |
| Cryptography        | OpenSSH with `ssh-keygen -Y` signing/verification                                                    |
| Android SDK         | Platform `android-35` and Build Tools `35.0.0`, including aapt, d8 and apksigner                     |
| Basic build tools   | Git for source identity, tar/xz and the tools described in [host dependencies](HOST_DEPENDENCIES.md) |

Compilation uses TypeScript 7.0.2. The separately pinned TypeScript 6 API package supports type-aware linting; changing that package to match the compiler is not a setup step. TypeScript has stable releases rather than an LTS channel. Dependencies and analyzer versions are pinned in [package.json](../package.json), [rust-toolchain.toml](../rust-toolchain.toml) and [quality-tools.json](../tools/quality-tools.json).

Install the pinned Node runtime first. If pnpm is missing, `npm install --global pnpm@12.11.2` installs that exact package manager. Check the active tools before installing the workspace:

```sh
node --version
pnpm --version
rustc --version
cargo --version
javac -version
ssh -V
```

The expected Node/pnpm/Rust versions are `v24.22.0`, `12.11.2` and `1.99.1`. Configure an existing, reviewed Android SDK location:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PXV_REQUIRE_CRYPTO=1
unset PXV_SKIP_ANDROID_CRYPTO
```

If the required SDK packages are absent, install them through your SDK manager after reviewing and accepting the applicable upstream licenses:

```sh
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  'platforms;android-35' 'build-tools;35.0.0'
```

Install the workspace and native toolchain, then build the executable code used by integrations:

```sh
pnpm install --frozen-lockfile
rustup toolchain install 1.99.1 --profile minimal \
  --component rustfmt --component clippy --target x86_64-unknown-linux-musl
pnpm quality:setup
pnpm build:native
pnpm build
```

`rust-toolchain.toml` selects Rust for this checkout; changing your global Rust default is unnecessary. The native build uses the toolchain's bundled rust-lld and reviewed musl runtime; it does not require host musl-gcc. The output is `native/supervisor/target/x86_64-unknown-linux-musl/release/pxv-supervisor`.

Dependency installation, Rust/SDK installation and `quality:setup` are explicit setup steps that can use the network. `quality:setup` downloads and checksum-verifies Rust Code Analysis 0.0.25 and ShellCheck 0.11.0. Their cache defaults below the user's cache directory; set `PXV_QUALITY_TOOLS` to select another location and keep that setting for subsequent checks. Checks validate the installed analyzers and never install them implicitly. The [CI workflow](../.github/workflows/validate.yml) records the automated setup recipe and Node archive checksum.

## Use a fast edit-and-test loop

Start with the tests nearest the behavior you changed. Vitest accepts file/directory filters and a test-name regular expression:

```sh
pnpm exec vitest run tests/contracts/policy.test.ts
pnpm exec vitest run tests/engine
pnpm exec vitest run tests/contracts/policy.test.ts -t 'permission drift'
pnpm exec vitest list tests/contracts/policy.test.ts -t 'permission drift'
```

`list` shows the selected tests without executing their bodies. Confirm the filter selects the intended cases; an empty selection does not establish correctness. For continuous feedback while editing:

```sh
pnpm exec vitest watch tests/contracts/policy.test.ts
```

Stop watch mode with Ctrl-C. Choose the relevant test area:

| Change                                                               | Useful starting point |
| -------------------------------------------------------------------- | --------------------- |
| Schemas, selectors and policy evaluation                             | `tests/contracts`     |
| Storage, worker protocol, process ownership and project-file commits | `tests/runtime`       |
| Planning, execution, attestations, custody and recovery              | `tests/engine`        |
| Android observations/actions, artifacts, recipes and probes          | `tests/adapters`      |
| CLI, detached workers and MCP routes                                 | `tests/cli`           |
| Extension archives, registry handling and worker validation          | `tests/extensions`    |
| Public SDK declarations and external bundled consumers               | `tests/extension-sdk` |
| Candidate formats, launchers, notices and guides                     | `tests/release`       |
| Quality-gate/report behavior                                         | `tests/quality`       |

Add a regression around the actual failure or safety invariant. Exercise the relevant boundary: malformed input, a competing generation, owner death, a failed durable event, an incompatible signer, or a changed Android user serial. A test that only reproduces an implementation detail does not establish the resulting workflow behavior. Follow the existing temporary-fixture and cleanup patterns.

Vitest resolves most workspace package imports to TypeScript source. Some integrations deliberately execute compiled CLI entrypoints, isolated workers or packaged public declarations. After changing those paths or their dependencies, rebuild before running the integration:

```sh
pnpm build
pnpm exec vitest run tests/cli/entrypoint.test.ts tests/extensions/manager.test.ts \
  tests/extension-sdk/consumer.test.ts
```

Re-run `pnpm build:native` after supervisor changes before exercising TypeScript/native integrations. A source test passing while a child still executes older `dist` output is incomplete evidence. Watch mode does not replace these builds.

Check types and the edited file's style during the loop:

```sh
pnpm typecheck
pnpm exec eslint packages/engine/src/handoff-service.ts
pnpm exec prettier --check packages/engine/src/handoff-service.ts
```

Replace the example file with the files you edited. `typecheck` builds production references and checks test and first-party JavaScript semantics, including unused locals/parameters. A Vitest pass alone does not perform those compiler checks.

## Run the appropriate quality stages

| Command              | What it verifies                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`         | Compiles workspace packages and declarations                                                                                                                                     |
| `pnpm check`         | Types, typed lint, formatting, package edges/cycles, development and strict production Knip graphs, complexity, Rustfmt/Clippy, shell syntax/ShellCheck and documentation checks |
| `pnpm test`          | Runs the complete Vitest suite once                                                                                                                                              |
| `pnpm test:native`   | Runs Rust fault tests on the static musl target                                                                                                                                  |
| `pnpm test:coverage` | Runs the complete Vitest suite and merges worker/subprocess coverage before checking every module/package                                                                        |
| `pnpm check:helpers` | Compiles the Java verifier and all three Android helpers, then signs and verifies their APKs                                                                                     |
| `pnpm docs:check`    | Checks documentation references and obsolete workflow/tooling patterns                                                                                                           |
| `pnpm quality`       | Runs `check`, native tests, complete coverage and helper checks, then validates final metrics/source identity and writes the aggregate report                                    |

For a native-only edit, `pnpm test:native` gives the focused fault result; `pnpm check` also requires rustfmt and Clippy with warnings denied. For a helper or Java-verifier edit, run `pnpm check:helpers`; Java compilation uses `-Xlint:all -Werror`. Generated stable, preview and OCI shell launchers receive syntax and ShellCheck checks too.

The required gates remain:

- Every TS/JS production function: classic ESLint cyclomatic complexity at most 10, nesting at most 4, and at most 80 nonblank, noncomment lines.
- Every first-party Rust/Java function: cyclomatic complexity at most 10 using the pinned Rust Code Analysis analyzer. Rust cognitive complexity is reported separately; the pinned analyzer does not provide Java cognitive complexity.
- Every TypeScript executable module and application package: at least 90% line and 85% branch coverage, including release tooling, workers and entrypoints. Application source is not excluded to make the totals pass.

Coverage percentages supplement explicit safety scenarios. Required regressions include reused Android user IDs with a changed serial, permission drift before finalization, child cleanup ownership, inherited secret sentinels, an exact asset named `all`, and capability-based emulator provenance. Storage and execution checks include worker death, malformed records, atomic event/state failures, stale configuration, cancellation, escaped descendants, durable fences and retryable owner-scoped recovery. Extension checks cover bounded archive/input/IPC handling and external compile/bundle/package/offline execution.

## Separate focused coverage from acceptance coverage

To inspect a component during development, send its diagnostic report to a separate directory:

```sh
pnpm exec vitest run tests/engine --coverage \
  --coverage.reportsDirectory=/tmp/pxv-engine-coverage \
  --coverage.reporter=json --coverage.reporter=text-summary
```

This is a filtered diagnostic run. The configured coverage include still spans application source, so untouched modules can show zero coverage. Direct Vitest coverage also lacks the aggregate harness's complete worker/subprocess merge. Do not present its totals as the full quality result or add exclusions to hide unexecuted modules.

Use the unfiltered command for the actual gate:

```sh
PXV_REQUIRE_CRYPTO=1 pnpm test:coverage
```

The harness writes raw Node worker/subprocess traces to `.quality/v8`, source-maps them onto the executable Vitest maps, and reports the merged result in `.quality/coverage.json` and `coverage/coverage-final.json`. Type/comment lines never become statements, and unmatched child branch ranges never imply coverage. Do not override the aggregate command's coverage output directory: the merge expects the configured `coverage/coverage-final.json` path. Run one aggregate quality/coverage process per checkout at a time because these output locations are shared.

## Diagnose failures without weakening the gate

| Symptom                                                   | Next check                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Engine or runtime version rejected                        | Check the active Node/pnpm/Rust versions and PATH against the pins above                                        |
| Missing or incompatible analyzer                          | Run `pnpm quality:setup` explicitly; check `PXV_QUALITY_TOOLS` is consistent across setup and checks            |
| Native supervisor missing or stale                        | Run `pnpm build:native`; retain the static musl target and reviewed flags                                       |
| APK crypto/helper setup failure                           | Check `ANDROID_HOME`, platform 35, Build Tools 35.0.0 and JDK/OpenSSH availability; keep `PXV_REQUIRE_CRYPTO=1` |
| Compiled child behavior differs from source               | Run `pnpm build`, then repeat the selected integration                                                          |
| No tests selected                                         | List the file/test filter and check the current test names                                                      |
| Low coverage in a filtered run                            | Inspect the selected component, then run unfiltered `pnpm test:coverage` for acceptance                         |
| Type/lint/dead-code failure despite green tests           | Run `pnpm typecheck` and `pnpm check`; fix the reported contract, boundary or unused code                       |
| Aggregate report says source changed or evidence is stale | Stop edits/watch processes that write source, then rerun the complete aggregate against the final bytes         |

The full check requires genuine SSH/JAR/APK verification. `PXV_REQUIRE_CRYPTO=1` makes that expectation explicit; skipping Android cryptography does not qualify a merge or release. Repair missing prerequisites rather than treating a skip as a pass. Failure tests deliberately create process exits, malformed records and rejected operations; evaluate the test assertion and retained evidence rather than classifying every injected child failure as a suite failure.

Keep developer fixture data synthetic. Do not copy recipient credentials, real device serials, private registry tokens, production backups, ADB keys or signing keys into test fixtures, snapshots, logs or candidate resources. Tests should allocate their own temporary project/control directories and remove their generated material. Inspect a leaked test worker or temporary directory before removing only the resources owned by that test. Never clear a real operator's recovery reservation to make a development test proceed. Real-device visits continue to use shared host ownership across projects; follow the [canary and recovery procedure](CANARY_BACKUP_RECOVERY.md).

## Finish a change with retained evidence

Once implementation, tests and documentation are ready, stop editing source and run:

```sh
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
```

A dirty checkout is supported: the report binds the actual tracked/unignored source bytes as well as the Git revision. A clean working tree is not a substitute for running the checks. Any later source edit makes the earlier source-bound report historical; rerun the final gate for the new bytes.

Read `.quality/report.md` and retain `.quality/report.json`. The aggregate records actual tool versions separately from declared dependency pins, current test totals, per-function complexity, per-module/package coverage and dependency findings. Individual reports are `.quality/metrics.json`, `coverage.json`, `deadcode.json`, `helpers.json` and `tests.json`. Failed runs retain a failed report and distinguish old files from evidence regenerated by completed stages. Do not accept an old `passed` file merely because it exists.

## Verify distributions separately

A source-suite pass does not establish that the derived packages execute. Follow the [publication checklist](PUBLICATION_CHECKLIST.md) for immutable candidate creation and exact-artifact verification. Docker/buildx and Debian packaging tools are additional prerequisites for all-format builds. A local preview command is:

```sh
pnpm build:preview --formats portable,deb,npm,oci
```

This creates uniquely named previews and does not publish, push, install globally or replace stable launchers. Test portable execution from an arbitrary working directory/read-only installation, offline npm installation with lifecycle scripts disabled, actual Debian installation inside a disposable container, and an OCI read-only root under an arbitrary UID. Verify checksums/signatures, notices, SBOM and source/toolchain provenance. Keep test signing material outside the source/candidate.

The supervisor must be static Linux x86_64 with the reviewed musl target. Release validation rejects dynamic ELF binaries, including ones that happen to run on a newer build host. Distribution acceptance includes a real synthetic native lease, owned child execution, a cleanup-proven durable receipt and zero remaining reservations on both the host and Debian 12 runtime. `tools/check-native-baseline.mjs` provides that synthetic check; CI mounts it and the compiled runtime into the container. Printing a version or initializing a project alone does not prove native ownership compatibility.

These tests can qualify code and package behavior without a phone. They do not establish GrapheneOS image provenance, live Docker USB/host-ADB transport behavior, localized UI support, cross-user isolation, routing/failure recovery, backup restoration or recipient custody. Retain separate live evidence through [E2E testing](E2E_TESTING.md) and the [canary, backup and recovery guide](CANARY_BACKUP_RECOVERY.md).
