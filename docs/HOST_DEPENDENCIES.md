# Host dependencies

## Supported target and developer toolchain

The application target is Linux x86_64, with Debian 12 and Ubuntu 24.04 as the declared baselines. Exact-candidate runtime evidence is required for a distribution claim; see [verification](VERIFICATION.md). Node is pinned to 24.22.0 LTS; TypeScript compiler 7.0.2 and pnpm 12.11.2 are exact workspace pins. TypeScript has stable releases rather than an LTS channel. A compatible TypeScript 6 API package supports type-aware linting while compilation uses the pinned TypeScript 7 tool.

The supervisor is a separate TypeScript process compiled by `pnpm build` in `@pxv/runtime`. It runs through the selected Node executable with private IPC on fd 3. Koffi 3.3.3 and its exact Linux x64 platform package provide reviewed prebuilt Node-API 8 calls for locks, subreapers and pidfds. The install script is disabled; missing or incompatible prebuilds require reinstalling the frozen dependencies on supported glibc Linux, with no compilation fallback.

## Operator tools

Host diagnosis validates executable paths and reported versions/capabilities for ADB, fastboot, aapt, apksigner, Java and OpenSSH signing tools. `fdroidcl` is an optional host tool and is required only for apps whose policy selects that source mode. Follow the [`fdroidcl` installation instructions](https://github.com/Hoverth/fdroidcl#quickstart) when needed. Install current reviewed official Android tools rather than assuming a distribution package is sufficient. USB device permissions must permit the caller; avoid running provisioning as root.

The reviewed container toolchain includes Platform Tools 37.0.1, Android platform 35 and Build Tools 35.0.0. The repository records exact archive SHA-256 values. Containers use a digest-pinned Debian base and immutable signed Debian snapshot packages for Java/OpenSSH and support libraries. Public archive notices remain with the tools.

A source build follows:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build
PXV_REQUIRE_CRYPTO=1 PXV_CHROMIUM=/usr/bin/google-chrome pnpm quality
pnpm pxv host doctor
```

Select an installed Chrome/Chromium by absolute `PXV_CHROMIUM` path (the example uses `/usr/bin/google-chrome`) and install Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdftohtml`) plus fonts. Strict qualification requires explicit zero `numSkippedTests` evidence from the complete run, including browser/PDF and cryptographic tests. See [testing](TESTING.md).

Source qualification also needs SDK platform 35/Build Tools 35.0.0 and Java/OpenSSH. Rust and C/C++ compiler toolchains are not required. `quality:setup` explicitly installs checksum-pinned ShellCheck in the operator cache (or `PXV_QUALITY_TOOLS`). Ordinary runtime operators do not need these developer analyzers. See [testing](TESTING.md) for per-component gates and retained evidence.

## Environment selection

pxv never automatically loads `.env` files. Export settings in the calling shell;
`.env.example` is a reference, not an input file. Docker Compose's own interpolation
and sidecar environment are separate from pxv's environment selection.

Android SDK selection is `PXV_ANDROID_HOME`, then `ANDROID_HOME`, then
`~/Android/Sdk` for host discovery only. Helper builds require an explicit
`PXV_ANDROID_HOME` or `ANDROID_HOME`; the host discovery default does not authorize
building against an implicit SDK. `ANDROID_SDK_ROOT` is not a selection input.
Java selection is `PXV_JAVA_HOME`, then `JAVA_HOME`, then executables on `PATH`.
For both home selections, an empty value falls through and a nonempty value is
used verbatim; whitespace is not trimmed into an empty value. An invalid selected
home does not select a lower-priority home. Helper builds fail against an invalid
selected SDK/JDK, and selecting a Java home is authoritative: its missing Java
executable does not fall back to `PATH`.

Host executable discovery retains its separate search sources: managed
`PXV_TOOLS_DIR` platform/build tools, the selected SDK platform tools,
`PXV_BUILD_TOOLS` (or the selected SDK's `build-tools/35.0.0`), then `PATH`.
These sources do not change the selected SDK home or grant helper builds an
implicit SDK. `PXV_TOOL_<NAME>` overrides take precedence over this search.

An explicit `PXV_TOOL_<NAME>` executable override is authoritative for that tool
(for example `PXV_TOOL_ADB`, `PXV_TOOL_APKSIGNER` or `PXV_TOOL_SSH_KEYGEN`).
An invalid selected override fails rather than silently choosing another binary.
Keep all selected paths and reviewed versions consistent with the intended SDK/JDK.

ADB client configuration accepts only `PXV_HOST_ADB_HOST`/`PXV_HOST_ADB_PORT` for
TCP endpoints, `PXV_ADB_SERVER_SOCKET` for a socket endpoint, and
`PXV_ADB_VENDOR_KEYS` for the key location. Native `ADB_SERVER_SOCKET` and
`ADB_VENDOR_KEYS` names are launch output or explicit sidecar-only settings, not
pxv configuration inputs. Configure the pxv names before starting the explicitly
owned service and preserve the same selection during recovery. Never point a
recovery attempt at a different server merely to bypass an unavailable endpoint.

## Explicit bootstrap and Android helper builds

`host bootstrap` accepts a reviewed archive descriptor, approved license ID and a new destination. It checks HTTPS source and approved digest, rejects unsafe extraction inputs and never runs as a package-install side effect. Review the descriptor's exact shape in the current CLI/module tests and review the upstream terms before accepting a license. No command silently accepts SDK manager licenses.

```sh
pxv host bootstrap --file APPROVED_ARCHIVE.json --license APPROVED_LICENSE_ID \
  --path "$HOME/.local/opt/approved-tool" --yes
pxv host build-helper --project-root "$P" --type probe --yes
```

Helper builds require an explicitly configured SDK and write private signing keys/passwords in the project build area. Pin the resulting APK content/signer in a reviewed policy before use. Do not ship those private build files in forks or candidate assets.

## ADB service ownership

Run `host adb-start --yes` explicitly before native host device work. Doctor/probe operations do not start a service. Guarded device clients require the configured server to exist; losing it creates inspection/recovery work rather than starting an unowned daemon.

For Docker direct USB, use `host docker-prepare` and `host docker-adb-start --image IMAGE`. The persistent service listens on loopback port 5038 and stores private keys outside operation workers. Host-ADB mode uses an already running host endpoint, commonly 5037. See [Docker](DOCKER.md).

An approved Platform Tools descriptor has the following shape. The license ID is an operator-reviewed identifier; replace it with the identifier of the actual accepted upstream terms. The extracted executables live below the returned destination/distribution directory.

```json
{
  "id": "platform-tools-linux",
  "url": "https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip",
  "sha256": "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
  "executables": ["platform-tools/adb", "platform-tools/fastboot"],
  "licenseId": "YOUR_REVIEWED_LICENSE_ID"
}
```

Bootstrap does not change PATH. Discover the verified extracted tools explicitly, for example set `PXV_TOOLS_DIR="$HOME/.local/opt/approved-tool/distribution"`, then run `pxv host doctor` again. PATH or the documented `PXV_TOOL_*` executable overrides can also select tools.

## TypeScript ownership runtime

`PXV_SUPERVISOR` identifies a readable JavaScript entrypoint. Host doctor invokes Node with `--build-info` to actually load Koffi and check subreaper and pidfd capabilities before any lease is acquired. Candidate qualification inspects the glibc x64 shared ELF addon, its dependencies and symbol versions, then executes installed candidate runtime bytes on Debian 12 and Ubuntu 24.04 as a non-root user with a read-only root.
