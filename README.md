# pxv Community 0.1.0

A local toolkit for provisioning and managing small fleets of Google Pixel phones with reviewed, project-specific policies. Community is free under the [MIT license](LICENSE). Commercial features are trusted extensions from private repositories and authenticated npm-compatible registries. There is no runtime activation service.

This release replaces the Python implementation with TypeScript. Existing projects are detected and refused without modification; create a new project. Old approvals are never reused.

## Build and check

Linux x86_64 is the initial platform. Use exactly **Node 24.22.0 LTS**, **pnpm 12.11.2**, **TypeScript 7.0.2**, and the pinned Rust toolchain in `rust-toolchain.toml`.

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
```

The compiler is TypeScript 7.0.2. A separate TypeScript 6.0.2 package supplies the JavaScript compiler API required by typed ESLint rules; it does not compile the application. SQLite uses Node's built-in API in a dedicated worker. Runtime updates require process, storage and concurrency regression checks.

`quality:setup` explicitly downloads checksum-pinned Rust Code Analysis and ShellCheck into the operator's cache; `PXV_QUALITY_TOOLS` selects another directory. `quality` runs production/test/tool typechecks, lint, dependency and cycle checks, native faults, merged worker/subprocess coverage and all Android helper builds/signature checks. It writes source-bound JSON and readable reports under `.quality/`. See [testing](docs/TESTING.md) for prerequisites and individual gates.

Use [development testing](docs/TESTING.md) for focused test/watch loops and coverage diagnosis. The separate [canary, backup and recovery runbook](docs/CANARY_BACKUP_RECOVERY.md) covers physical trials, protected reference/master phones, primary phones with real data, disposable rebuilds and operator-state backups.

For one person's multi-profile phone, the [two personal recovery scripts](scripts/examples/README.md) assist GrapheneOS installation, supervised Seedvault backup and same-device/replacement restoration. Read the [adapter qualification and recovery limits](docs/SEEDVAULT_AUTOMATION.md) first; no production Seedvault UI adapter is currently qualified by the repository.

## Start a project

Host execution needs supported Android platform tools, SDK Build Tools 35.0.0, Java 17 or newer, and OpenSSH signature verification. Portable and Debian distributions bundle Node and the supervisor. The Docker image also includes its Android and Java tools. See [host setup](docs/HOST_DEPENDENCIES.md).

```sh
pnpm pxv host doctor
pnpm pxv host adb-start --yes
pnpm pxv project init --path /absolute/path/to/fleet \
  --policy policy-packs/simple/policy.json
pnpm pxv inventory enroll --project-root /absolute/path/to/fleet \
  --asset phone-001 --serial ACTUAL_SERIAL --model 'Pixel 8a' --codename akita --yes
pnpm pxv device plan --project-root /absolute/path/to/fleet --asset phone-001
```

Starter packs demonstrate one, five and arbitrary profiles. They are structural templates, not certified hardening policies. Select authenticated application versions/signers, OS pins, settings, network requirements and acceptance steps before deployment. Configuration rejects unknown fields, duplicate YAML keys and ambiguous selectors. Asset `all` is a literal name; fleet selection requires `--all`.

Use `guide project --project-root DIRECTORY --locale en|pl` for policy-derived checks and `device guided --asset ID` for a guided provisioning run. Review the printed plan before running `device provision`, `device deploy`, `device create-users` or the destructive `device install-os`. Interactive commands ask for confirmation; `--yes` records explicit noninteractive authorization. For agent execution, retain the exact `reviewSummary` as a file and submit it with `agent execute --plan ID --review-file FILE --operator NAME`. Runs survive the submitting client and expose cursor-based events.

Recipient credentials, accounts, MFA and recovery material are entered privately on the phone. Unsupported UI automation pauses with a manual checkpoint. Complete the requested step, record the applicable check, and use `agent resume --run ID --yes`. If a manual checkpoint outlasts its review window, `agent refresh --run ID` prepares a new exact review of the remaining work without replaying completed setup. Language changes follow normal credentials; optional duress setup follows language. Never activate destructive duress as a test.

[Operator guide](docs/OPERATOR_GUIDE.md) · [Recipient guide](docs/USER_GUIDE.md) · [Command reference](docs/COMMAND_REFERENCE.md) · [Architecture](docs/ARCHITECTURE.md)

## Host and Docker

Host and container workers share a per-operator control directory, device leases and durable recovery reservations. Do not run different workstations against the same phone concurrently.

```sh
pnpm pxv host docker-prepare --yes
pnpm pxv host docker-adb-start --image EXPLICIT_LOCAL_IMAGE --yes
pnpm pxv device inspect --project-root /absolute/path/to/fleet --asset phone-001 \
  --execution docker --image EXPLICIT_LOCAL_IMAGE --docker-mode direct
pnpm pxv host docker-adb-stop --yes
```

Direct USB mode uses an explicitly started persistent ADB sidecar on loopback port 5038 and private keys. Host-ADB mode connects to an existing host server on 5037. Fastboot requires direct USB. Workers use the caller's UID/GID and read-only installed extensions. See [Docker workflows](docs/DOCKER.md).

## Forks and extensions

White-label products are separate forks. One [product descriptor](product.json) selects the command, package, Debian package, image, assets, starter policy and support identity. Replace example support addresses before distribution. Preserve the upstream engine/API markers and shared safety tests.

Extensions install only through explicit commands, with exact versions and SHA-512 integrity recorded in the project configuration. Local tarballs support private previews. Installation rejects lifecycle scripts and runtime dependencies; installed bundles execute offline. Extensions are trusted code, and worker isolation is fault isolation rather than a sandbox.

```sh
pnpm pxv extension install --project-root /absolute/path/to/fleet --file ./extension.tgz --yes
pnpm pxv policy lock --project-root /absolute/path/to/fleet --yes
```

Declared extension guides are available with `extension guide --extension ID --contribution PATH`. Select a validated policy explicitly with `extension policy --extension ID --contribution PATH --yes`. Integration adapters and commands produce typed actions for core planning, approval and recovery; `extension adapter` prepares their review. Public authoring packages are `@pxv/extension-sdk` and `@pxv/contracts`. See [extension workflows](docs/EXTENSIONS.md).

## Local distributions

```sh
pnpm build
pnpm build:preview --formats portable,deb,npm,oci
```

Each build freezes one immutable candidate and derives the selected formats from it. Dirty previews record their source digest, use unique output directories and versions, and have a separate command/Debian identity. Preview launchers default to a separate project. The build never publishes, pushes or installs globally. OCI builds also load a unique local image unless `--no-oci-load` is supplied. `sea` is experimental; the portable archive is the supported standalone baseline.

Artifacts carry checksums, source/toolchain provenance, an SBOM and notices. Stable builds require signing; registry promotion is a separate explicit command. Use the release builder's npm artifact, not a raw workspace CLI tarball. See [publication](docs/PUBLICATION_CHECKLIST.md).

## Evidence and limitations

Offline tests include real cryptographic verification, native crash/fence tests, extension failures, external SDK consumers, two fork identities, and package execution outside the checkout. Every TypeScript application module and package, including release code and workers, must reach 90% lines and 85% branches. TS/JS functions are limited to classic cyclomatic complexity 10, nesting 4 and 80 nonblank, noncomment lines; Rust/Java functions also have a complexity limit of 10.

Physical and GrapheneOS emulator acceptance are tracked separately in [verification](docs/VERIFICATION.md). Passing offline tests does not certify a policy pack, UI adapter, networking configuration or restore. Maintenance creates fresh evidence and renewed handoff; retirement records confirmed erasure and custody without silently wiping a device. Headwind integration and custom OS source builds remain later workflows.
