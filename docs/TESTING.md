# Developing and testing pxv

Run the commands below from the checkout root. The normal development suite uses synthetic policies, local fixture artifacts, temporary projects and real supervised test processes. It does not require a connected phone. For physical-device experiments and live acceptance, use [canary, backup and recovery testing](CANARY_BACKUP_RECOVERY.md).

Development source, test, configuration and CI links in this guide refer to the matching source checkout. Installed distributions do not contain the development workspace or test suite.

The quality orchestrator runs `check:static` for its first stage and computes metrics
once at the end, retaining before/after source identity checks. Independent `pnpm check`
runs the same static checks plus metrics. No crypto, native, coverage or helper gate
is dropped. Ordinary CI derives portable/OCI formats; manual/tag runs also exercise
the Debian/npm compatibility channels.

## Set up a development checkout

Use the exact workspace versions; `.npmrc` enforces the Node/pnpm engine requirements.

| Component           | Required setup                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Host                | Linux x86_64; supported baselines are Ubuntu 24.04 and Debian 12                                                 |
| Node.js             | 24.22.0 LTS                                                                                                      |
| pnpm                | 12.11.2                                                                                                          |
| TypeScript compiler | 7.0.2, installed by the lockfile as `@typescript/native`                                                         |
| Java                | JDK 17 or newer, including `java`, `javac`, `jar` and `keytool`                                                  |
| Cryptography        | OpenSSH with `ssh-keygen -Y` signing/verification                                                                |
| Android SDK         | Platform `android-35` and Build Tools `35.0.0`, including aapt, d8 and apksigner                                 |
| Browser/PDF tools   | Chrome or Chromium at an absolute `PXV_CHROMIUM` path; Poppler (`pdftotext`, `pdfinfo`, `pdftoppm`, `pdftohtml`) |
| Basic build tools   | Git for source identity, tar/xz and the tools described in [host dependencies](HOST_DEPENDENCIES.md)             |

Compilation uses TypeScript 7.0.2. The separately pinned TypeScript 6 API package supports type-aware linting; changing that package to match the compiler is not a setup step. TypeScript has stable releases rather than an LTS channel. Dependencies and analyzer versions are pinned in [package.json](../package.json), [runtime package](../packages/runtime/package.json) and [quality-tools.json](../tools/quality-tools.json).

Install the pinned Node runtime first. If pnpm is missing, `npm install --global pnpm@12.11.2` installs that exact package manager. Check the active tools before installing the workspace:

```sh
node --version
pnpm --version
javac -version
ssh -V
```

The supervisor is a separate TypeScript process compiled by `pnpm build` in `@pxv/runtime`. It runs through the selected Node executable with private IPC on fd 3. Koffi 3.3.3 and its exact Linux x64 platform package provide reviewed prebuilt Node-API 8 calls for locks, subreapers and pidfds. The install script is disabled; missing or incompatible prebuilds require reinstalling the frozen dependencies on supported glibc Linux, with no compilation fallback.

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export PXV_CHROMIUM=/absolute/path/to/chrome
export PXV_REQUIRE_CRYPTO=1
unset PXV_SKIP_ANDROID_CRYPTO
```

SDK/JDK and ADB precedence follows [environment selection](HOST_DEPENDENCIES.md#environment-selection), including empty-value fallback and failure on an invalid selected path. No `.env` file is loaded automatically.

If the required SDK packages are absent, install them through your SDK manager after reviewing and accepting the applicable upstream licenses:

```sh
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  'platforms;android-35' 'build-tools;35.0.0'
```

Install the workspace and helper tools, then build the executable code used by integrations:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build
```

## Use a fast edit-and-test loop

Start with the tests nearest the behavior you changed. The test runner accepts file paths and glob patterns:

```sh
pnpm test tests/contracts/policy.test.ts
pnpm test 'tests/engine/**/*.test.ts'
```

Each file runs in its own process. For Node's native name filtering or watch mode, build the integration entrypoints first and register the same esbuild hooks:

```sh
pnpm build
node --import ./tools/test-hooks.mjs --test --test-name-pattern='permission drift' tests/contracts/policy.test.ts
node --import ./tools/test-hooks.mjs --test --watch tests/contracts/policy.test.ts
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

Use focused functional or integration checks at the relevant boundary: malformed input, a competing generation, owner death, a failed durable event, an incompatible signer, or a changed Android user serial. A test that only reproduces an implementation detail does not establish the resulting workflow behavior. Follow the existing temporary-fixture and cleanup patterns.

node:test resolves most workspace package imports to TypeScript source. Some integrations deliberately execute compiled CLI entrypoints, isolated workers or packaged public declarations. After changing those paths or their dependencies, rebuild before running the integration:

```sh
pnpm test tests/cli/entrypoint.test.ts tests/extensions/manager.test.ts tests/extension-sdk/consumer.test.ts
```

Re-run `pnpm build` after supervisor changes before exercising TypeScript/native integrations. A source test passing while a child still executes older `dist` output is incomplete evidence. Watch mode does not replace these builds.

Check types and the edited file's style during the loop:

```sh
pnpm typecheck
pnpm exec eslint packages/engine/src/handoff-service.ts
pnpm exec prettier --check packages/engine/src/handoff-service.ts
```

Replace the example file with the files you edited. `typecheck` builds production references and checks test and first-party JavaScript semantics, including unused locals/parameters. A node:test pass alone does not perform those compiler checks.

## Run the appropriate quality stages

| Command                | What it verifies                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`           | Compiles workspace packages and declarations                                                                                                                                      |
| `pnpm check`           | Types, typed lint, formatting, package edges/cycles, development and strict production TypeScript repository graphs, complexity, shell syntax/ShellCheck and documentation checks |
| `pnpm test`            | Runs the complete node:test suite once                                                                                                                                            |
| `pnpm test:supervisor` | Runs supervisor unit, receipt-failure and ownership integration tests                                                                                                             |
| `pnpm test:coverage`   | Runs the complete node:test suite and merges worker/subprocess coverage before checking every module/package                                                                      |
| `pnpm check:helpers`   | Compiles the Java verifier and all three Android helpers, then signs and verifies their APKs                                                                                      |
| `pnpm docs:check`      | Builds first, then checks references, static shell command examples and obsolete workflow/tooling patterns                                                                        |
| `pnpm quality`         | Runs static checks, supervisor tests, complete coverage and helper checks, then validates final metrics/source identity and writes the aggregate report                           |

For a supervisor edit, `pnpm test:supervisor` gives the focused fault result; `pnpm check` also checks TypeScript types, lint and complexity. For a helper or Java-verifier edit, run `pnpm check:helpers`; Java compilation uses `-Xlint:all -Werror`. Generated stable, preview and OCI shell launchers receive syntax and ShellCheck checks too.

The required gates remain:

- Every TS/JS production function: classic ESLint cyclomatic complexity at most 10, nesting at most 4, and at most 80 nonblank, noncomment lines.
- Every first-party Java function: cyclomatic complexity at most 10 using java-parser 3.0.1, with methods, constructors and lambdas measured independently. Invalid Java source fails the gate.
- Every TypeScript executable module and application package: at least 90% line and 85% branch coverage, including release tooling, workers and entrypoints. Application source is not excluded to make the totals pass.

Coverage percentages supplement explicit safety scenarios. Storage and execution checks include worker death, malformed records, atomic event/state failures, stale configuration, cancellation, escaped descendants, durable fences and retryable owner-scoped recovery. Extension checks cover bounded archive/input/IPC handling and external compile/bundle/package/offline execution.

## Separate focused coverage from acceptance coverage

The aggregate runner accepts file patterns for diagnostic coverage:

```sh
pnpm test:coverage 'tests/engine/**/*.test.ts'
```

This filtered run writes to the shared coverage locations and normally fails the
whole-application thresholds because other modules were not exercised. It replaces
`.quality/tests.json` and coverage evidence; rerun the unfiltered gate before relying
on those files. The runner does not support Vitest coverage flags or a separate
report directory. Do not add exclusions to hide unexecuted modules.

Use the unfiltered command for the actual gate:

```sh
PXV_REQUIRE_CRYPTO=1 PXV_CHROMIUM=/usr/bin/google-chrome pnpm test:coverage
```

The aggregate harness traces the entire runner, test processes, application workers,
supervisors and subprocesses through `NODE_V8_COVERAGE`. Executable source maps
map those V8 traces onto application TypeScript with ast-v8-to-istanbul 1.0.7 and
@babel/parser 8.0.7. Coverage therefore includes compiled child entrypoints as well
as code imported by tests. Workers flush coverage before owners finish teardown;
missing maps or persistently malformed/incomplete traces fail qualification.

Raw traces live in `.quality/v8`; merged results are written to
`.quality/coverage.json` and `coverage/coverage-final.json`. Type/comment lines are
not statements and unmatched child branch ranges do not imply coverage. Run one
aggregate quality/coverage process per checkout at a time because these evidence
locations are shared. Keep `.quality/tests.json` and source-bound report freshness
with the matching run.

## Diagnose failures without weakening the gate

The full check requires genuine SSH/JAR/APK verification. `PXV_REQUIRE_CRYPTO=1` makes that expectation explicit; skipping Android cryptography does not qualify a merge or release. Strict acceptance requires zero skipped tests, including real browser/PDF scenarios. Set `PXV_REQUIRE_CRYPTO=1`, export an absolute `PXV_CHROMIUM` executable, install Poppler, and repair missing prerequisites rather than treating a skip as a pass. Retain explicit `numSkippedTests: 0` in strict test evidence from the actual unfiltered run; a focused pass does not establish this evidence. Failure tests deliberately create process exits, malformed records and rejected operations; evaluate the test assertion and retained evidence rather than classifying every injected child failure as a suite failure.

Keep developer fixture data synthetic. Do not copy recipient credentials, real device serials, private registry tokens, production backups, ADB keys or signing keys into test fixtures, snapshots, logs or candidate resources. Tests should allocate their own temporary project/control directories and remove their generated material. Inspect a leaked test worker or temporary directory before removing only the resources owned by that test. Never clear a real operator's recovery reservation to make a development test proceed. Real-device visits continue to use shared host ownership across projects; follow the [canary and recovery procedure](CANARY_BACKUP_RECOVERY.md).

## Finish a change with retained evidence

Once implementation, tests and documentation are ready, stop editing source and run:

```sh
pnpm build
PXV_REQUIRE_CRYPTO=1 PXV_CHROMIUM=/usr/bin/google-chrome pnpm quality
```

A dirty checkout is supported: the report binds the actual tracked/unignored source bytes as well as the Git revision. A clean working tree is not a substitute for running the checks. Any later source edit makes the earlier source-bound report historical; rerun the final gate for the new bytes.

Read `.quality/report.md` and retain `.quality/report.json`. The aggregate records actual tool versions separately from declared dependency pins, current test totals, per-function complexity, per-module/package coverage and dependency findings. Individual reports are `.quality/metrics.json`, `coverage.json`, `deadcode.json`, `helpers.json` and `tests.json`. Failed runs retain a failed report and distinguish old files from evidence regenerated by completed stages. Do not accept an old `passed` file merely because it exists.

## Verify distributions separately

A source-suite pass does not establish that the derived packages execute. Follow the [publication checklist](PUBLICATION_CHECKLIST.md) for immutable candidate creation and exact-artifact verification. Docker/buildx and Debian packaging tools are additional prerequisites for all-format builds. A local preview command is:

```sh
pnpm build:preview --formats portable,deb,npm,oci
```

This creates uniquely named previews and does not publish, push, install globally or replace stable launchers. Test portable execution from an arbitrary working directory/read-only installation, offline npm installation with lifecycle scripts disabled, actual Debian installation inside a disposable container, and an OCI read-only root under an arbitrary UID. Verify checksums/signatures, notices, SBOM and source/toolchain provenance. Keep test signing material outside the source/candidate.

The supervisor uses the reviewed Koffi Linux glibc x64 prebuild. Release validation checks ELF identity, dependencies and symbol versions, then executes the installed runtime and addon on Debian 12 and Ubuntu 24.04. `tools/check-native-baseline.mjs` accepts an explicit packaged-runtime module path. After building, run `node tools/check-packaged-runtime.mjs BUILD_RESULT.json` with the JSON printed by the release CLI to exercise every selected supported format on both baselines; Docker and a locally loaded OCI image are required. CI uses candidate bytes as a non-root user with a read-only root; it does not mount workspace dist code.

These tests can qualify code and package behavior without a phone. They do not establish GrapheneOS image provenance, live Docker USB/host-ADB transport behavior, localized UI support, cross-user isolation, routing/failure recovery, backup restoration or recipient custody. Retain separate live evidence through the [canary, backup and recovery guide](CANARY_BACKUP_RECOVERY.md), using the [verification boundaries](VERIFICATION.md).

Coverage uses ast-v8-to-istanbul 1.0.7 with @babel/parser 8.0.7 and executable source maps. `NODE_V8_COVERAGE` traces include test processes, workers, supervisors and subprocesses. Missing maps fail the gate; the default module and package thresholds are 90% line and 85% branch coverage. `.quality/tests.json`, `coverage/coverage-final.json` and source-bound report freshness retain their consumer contracts.

The repository graph uses the TypeScript compiler API with explicit SDK, CLI, worker, supervisor and tool entries. Development and production checks reject unreachable files, unused exports/dependencies, missing dependencies, unresolved imports and stale documented exemptions. Java complexity uses java-parser 3.0.1; parser failures fail qualification. Methods, constructors and lambdas have separate cyclomatic measurements capped at 10.

Dependency checks retain the importing package's ownership: a sibling package's declaration cannot satisfy a missing dependency, and runtime imports cannot rely on development-only declarations in the production graph. Type-only imports can use development declarations. CommonJS loads and resolution calls, including aliased `createRequire` loaders, are checked alongside ESM imports. The reviewed `requireContexts` in `tools/repository-graph.json` describe code that intentionally locates the runtime's own dependencies; implicit compiler/tool dependencies are scoped to their declaring manifest. Test-only exports have exact production exemptions that become stale if the finding disappears. Types referenced by consumed public signatures remain available without treating local function calls as export consumers.

Supervisor execution and cleanup deadlines use a monotonic clock, so host wall-clock adjustments cannot extend commands or prematurely exhaust cleanup.

pxv supports Linux only. The dependency audit detects PE and Mach-O payloads solely to reject foreign native artifacts, even if their hashes appear in the review catalog. Linux native binaries and WASM still require a matching hash and documented review.
