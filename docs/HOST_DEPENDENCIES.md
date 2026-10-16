# Host dependencies

## Supported target and developer toolchain

The initial application target is Linux x86_64. Qualification includes Debian 12 and Ubuntu 24.04. Node is pinned to 24.22.0 LTS; TypeScript compiler 7.0.2 and pnpm 12.11.2 are exact workspace pins. TypeScript has stable releases rather than an LTS channel. A compatible TypeScript 6 API package supports type-aware linting while compilation uses the pinned TypeScript 7 tool.

Portable archives and Debian packages include Node and the compiled Linux supervisor. npm packages require the exact supported Node runtime. Developing/building the supervisor requires Rust/Cargo; ordinary operators do not need a Rust compiler. The application, packaging and guide tooling have no runtime language compatibility layer.

## Operator tools

Host diagnosis validates executable paths and reported versions/capabilities for ADB, fastboot, aapt, apksigner, Java and OpenSSH signing tools. Install current reviewed official Android tools rather than assuming a distribution package is sufficient. USB device permissions must permit the caller; avoid running provisioning as root.

The reviewed container toolchain includes Platform Tools 37.0.1, Android platform 35 and Build Tools 35.0.0. The repository records exact archive SHA-256 values. Containers use a digest-pinned Debian base and immutable signed Debian snapshot packages for Java/OpenSSH and support libraries. Public archive notices remain with the tools.

A source build follows:

~~~sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm pxv host doctor
~~~

Source qualification also needs the pinned rustfmt/Clippy components, SDK platform 35/Build Tools 35.0.0 and Java/OpenSSH. `quality:setup` explicitly installs checksum-pinned Rust Code Analysis and ShellCheck in the operator cache (or `PXV_QUALITY_TOOLS`). Ordinary runtime operators do not need these developer analyzers. See [testing](TESTING.md) for per-component gates and retained evidence.

## Explicit bootstrap and Android helper builds

`host bootstrap` accepts a reviewed archive descriptor, approved license ID and a new destination. It checks HTTPS source and approved digest, rejects unsafe extraction inputs and never runs as a package-install side effect. Review the descriptor's exact shape in the current CLI/module tests and review the upstream terms before accepting a license. No command silently accepts SDK manager licenses.

~~~sh
pxv host bootstrap --file APPROVED_ARCHIVE.json --license APPROVED_LICENSE_ID \
  --path "$HOME/.local/opt/approved-tool" --yes
pxv host build-helper --project-root "$P" --type probe --yes
~~~

Helper builds require an explicitly configured SDK and write private signing keys/passwords in the project build area. Pin the resulting APK content/signer in a reviewed policy before use. Do not ship those private build files in forks or candidate assets.

## ADB service ownership

Run `host adb-start --yes` explicitly before native host device work. Doctor/probe operations do not start a service. Guarded device clients require the configured server to exist; losing it creates inspection/recovery work rather than starting an unowned daemon.

For Docker direct USB, use `host docker-prepare` and `host docker-adb-start --image IMAGE`. The persistent service listens on loopback port 5038 and stores private keys outside operation workers. Host-ADB mode uses an already running host endpoint, commonly 5037. See [Docker](DOCKER.md).

An approved Platform Tools descriptor has the following shape. The license ID is an operator-reviewed identifier; replace it with the identifier of the actual accepted upstream terms. The extracted executables live below the returned destination/distribution directory.

~~~json
{
  "id": "platform-tools-linux",
  "url": "https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip",
  "sha256": "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
  "executables": [
    "platform-tools/adb",
    "platform-tools/fastboot"
  ],
  "licenseId": "YOUR_REVIEWED_LICENSE_ID"
}
~~~

Bootstrap does not change PATH. Discover the verified extracted tools explicitly, for example set `PXV_TOOLS_DIR="$HOME/.local/opt/approved-tool/distribution"`, then run `pxv host doctor` again. PATH or the documented `PXV_TOOL_*` executable overrides can also select tools.

## Static native ownership runtime

The source build pins Rust 1.99.1 and the x86_64-unknown-linux-musl target. pnpm build:native uses the toolchain's bundled rust-lld and reviewed musl 1.2.5 runtime; no host musl-gcc is required. The output is native/supervisor/target/x86_64-unknown-linux-musl/release/pxv-supervisor. Global RUSTFLAGS do not override the reviewed static flags. pnpm test:native runs the Rust tests for this target.

Release creation rejects a supervisor with an ELF shared interpreter or dynamic library dependencies, and verifies its static-musl build metadata. Host doctor actually executes the exact version check rather than only finding a file. CI additionally creates a real native lease, executes a synthetic mutation and checks its durable receipt inside the Debian 12 image as UID 1000 with a read-only root. A successful version or project-init command alone cannot prove native ownership compatibility.

Runtime notices, exact Rust-std archive provenance and the musl archive/sysroot digest are retained in resources/third-party/native-runtime.json and each candidate's notices/SBOM.
