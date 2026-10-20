# Build and run pxv

Use this procedure from the repository root. Compilation produces workspace
`dist/` entry points; release packaging is a later step. A phone is not required
to install dependencies or compile the project.

## Select the pinned toolchain

Use **Node 24.22.0** and **pnpm 12.11.2**, as pinned in `.node-version`,
`package.json`, and the lockfile. The supported application target is glibc Linux
x86_64; Debian 12 and Ubuntu 24.04 are the declared qualification baselines.

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

Expected result: TypeScript project-reference compilation completes and produces
the packages’ JavaScript and declarations. Compilation uses TypeScript 7.0.2 through
`@typescript/native`; the TypeScript 6 package supplies the API used by ESLint.
Keep the exact workspace overrides and lockfile rather than installing a different
compiler under a familiar package name.

The official pinned Node distribution is the explicit upstream Rust-payload
exception. Project-managed executable/addon/WASM/development dependencies remain
subject to the dependency policy. Tests transpile through esbuild hooks instead
of Node’s embedded TypeScript parser. Rust and C/C++ compilers are not build prerequisites.

## Run compiled entry points

```sh
pnpm pxv --help
pnpm pxv version
pnpm pxv host doctor
```

`pnpm pxv` launches `packages/cli/dist/main.js`. MCP is exposed through that same
CLI’s `mcp serve` command. `packages/release/dist/cli.js` packages candidates;
it is not the device workflow CLI. Rebuild after changing source used by compiled
workers or integration entry points.

Keep live projects outside the repository. For example, initialization copies a
validated policy and creates a distinct private project without contacting a phone:

```sh
pnpm pxv project init --path /absolute/private/development-project \
  --policy policy-packs/single-simple/policy.json
pnpm pxv policy validate --project-root /absolute/private/development-project
```

The starter is structural; supply real trust/configuration and follow the
[operator path](../operators/single-device.md) before authorized device work.

## Native runtime and optional build dependencies

The TypeScript supervisor is compiled in `@pxv/runtime` and runs under the selected
Node with private IPC on fd 3. Koffi 3.3.3 and its exact Linux x64 Node-API 8 prebuild
provide kernel calls. Its install script is disabled; there is no local compilation
fallback. Host doctor loads the runtime and checks subreaper/pidfd capabilities.

Android helper builds and genuine APK tests need Java 17+, SDK platform 35,
Build Tools 35.0.0, and OpenSSH. Configure the SDK explicitly for helper builds.
Read [tool discovery and environment precedence](../operators/host-setup.md#environment-selection).
ADB services and phone connections are explicit operator actions, not build effects.

For printable guides, install/select local Chromium and Poppler, then follow
[guide generation](../operators/guides-and-inserts.md). Source compilation alone
does not render or qualify guide PDFs.

## Check a change

```sh
pnpm quality:setup
pnpm check
pnpm test
```

`quality:setup` explicitly acquires checksum-pinned analyzers. Select focused tests
during development; use [testing](testing.md) for complete crypto, helper, coverage,
process-fault, PDF, and source-identity requirements. The strict release gate uses
`PXV_REQUIRE_CRYPTO=1` and an explicitly selected Chromium.

## Build distributable candidates

```sh
pnpm build:preview
pnpm build:preview --formats portable,oci
```

Portable is the supported default. OCI is explicit; Debian/npm and experimental
SEA are optional compatibility outputs. Formats derive from a frozen candidate.
Preview builds do not publish, globally install, or replace stable launchers.
Follow [distribution](distribution.md) for signing, provenance, runtime qualification,
branding, guide assets, and promotion.

## Diagnose build failures

| Failure | Next step |
| --- | --- |
| Engine/tool version mismatch | Select the pinned Node and pnpm before installing again with the frozen lockfile. |
| Missing `dist` module or stale worker | Run `pnpm build` from the root; do not run source through an alternate TS loader. |
| Missing/incompatible native addon | Reinstall frozen dependencies on supported glibc Linux x64 and rerun doctor. |
| SDK/JDK failure | Inspect authoritative environment overrides; an invalid selected home does not fall back. |
| Missing PDF/browser checks | Install/select the documented Chromium/Poppler tools; keep unperformed checks pending. |
| Quality evidence stale after editing | Rerun the required checks for the final source; do not reuse an earlier candidate’s report. |
