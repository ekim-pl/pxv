# Operator host setup and transports

Complete host diagnosis before enrolling a phone. Continue with the [single-device](single-device.md) or [fleet](fleet.md) path once the required tools, device permissions, and explicitly owned ADB service are ready. For source compilation, use [developer build instructions](../developers/build.md).

## Supported target and developer toolchain

The application target is Linux x86_64, with Debian 12 and Ubuntu 24.04 as the declared baselines. Exact-candidate runtime evidence is required for a distribution claim; see [verification](acceptance.md). Node is pinned to 24.22.0 LTS; TypeScript compiler 7.0.2 and pnpm 12.11.2 are exact workspace pins. TypeScript has stable releases rather than an LTS channel. A compatible TypeScript 6 API package supports type-aware linting while compilation uses the pinned TypeScript 7 tool.

The supervisor is a separate TypeScript process compiled by `pnpm build` in `@pxv/runtime`. It runs through the selected Node executable with private IPC on fd 3. Koffi 3.3.3 and its exact Linux x64 platform package provide reviewed prebuilt Node-API 8 calls for locks, subreapers and pidfds. The install script is disabled; missing or incompatible prebuilds require reinstalling the frozen dependencies on supported glibc Linux, with no compilation fallback.

## Operator tools

Host diagnosis validates executable paths and reported versions/capabilities for ADB, fastboot, aapt, apksigner, Java and OpenSSH signing tools. `fdroidcl` is an optional host tool and is required for apps whose policy selects that source mode and for `policy update-apps`. Follow the [`fdroidcl` installation instructions](https://github.com/Hoverth/fdroidcl#quickstart) when needed. Install current reviewed official Android tools rather than assuming a distribution package is sufficient. USB device permissions must permit the caller; avoid running provisioning as root.

`pxv policy update-apps` also requires `fdroidcl` and Java for trusted repository
discovery, and `aapt` plus `apksigner` to verify proposed updates. ADB is required
when using `--asset`; discovery without a connected phone uses explicit `--sdk`
and `--abi` values and still needs network access. The updater runs fdroidcl with
isolated configuration and cache directories and blocks its incidental ADB
subprocesses. Repositories must publish `index-v1.jar`, and its signed
`suggestedVersionCode` determines stable releases. See
[updating app pins](policy-reference.md#updating-app-pins).

The reviewed container toolchain includes Platform Tools 37.0.1, Android platform 35 and Build Tools 35.0.0. The repository records exact archive SHA-256 values. Containers use a digest-pinned Debian base and immutable signed Debian snapshot packages for Java/OpenSSH and support libraries. Public archive notices remain with the tools.

A source build follows:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build
PXV_REQUIRE_CRYPTO=1 PXV_CHROMIUM=/usr/bin/google-chrome pnpm quality
pnpm pxv host doctor
```

Select an installed Chrome/Chromium by absolute `PXV_CHROMIUM` path (the example uses `/usr/bin/google-chrome`) and install Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdftohtml`) plus fonts. Strict qualification requires explicit zero `numSkippedTests` evidence from the complete run, including browser/PDF and cryptographic tests. See [testing](../developers/testing.md).

Source qualification also needs SDK platform 35/Build Tools 35.0.0 and Java/OpenSSH. Rust and C/C++ compiler toolchains are not required. `quality:setup` explicitly installs checksum-pinned ShellCheck in the operator cache (or `PXV_QUALITY_TOOLS`). Ordinary runtime operators do not need these developer analyzers. See [testing](../developers/testing.md) for per-component gates and retained evidence.

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

For Docker direct USB, use `host docker-prepare` and `host docker-adb-start --image IMAGE`. The persistent service listens on loopback port 5038 and stores private keys outside operation workers. Host-ADB mode uses an already running host endpoint, commonly 5037. See [Docker]().

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

## Docker operation

Docker workers run the same frozen engine candidate, policy lock, project state, installed extension bytes and host device reservations as native execution. Container installation does not enroll, contact or modify a phone. Image publication is a separate explicit action.

## Build and select an image

```sh
pnpm build:preview --formats oci
```

The builder uses a digest-pinned BuildKit container, a digest-pinned Debian base, immutable Debian snapshot packages and checksum-approved Google SDK archives. It exports an attested OCI archive and a unique local Docker image tag. Classic Docker cannot directly load every OCI archive, so the build also uses a cached Docker exporter. `--no-oci-load` requests only the portable OCI archive. It never pushes an image.

A generated `oci-context` contains only a frozen candidate, Dockerfile and entrypoint. The builder generates the Dockerfile from the release code and builds only that context. Source configs, secrets, credentials, private helper keys and live state are outside the allowlist. Do not replace this context with a checkout-wide COPY.

## Prepare outside device workflows

```sh
export PXV_IMAGE=YOUR_UNIQUE_IMAGE
export PXV_PROJECT=/absolute/path/to/existing/isolated-project
export PXV_UID="$(id -u)"
export PXV_GID="$(id -g)"
pxv host docker-prepare --yes
pxv host docker-adb-start --image "$PXV_IMAGE" --yes
docker compose --file compose.yaml --profile direct run --rm direct host doctor
```

Run this sequence from the checkout root containing `compose.yaml`, with an existing initialized project at the absolute `PXV_PROJECT` path. The Compose doctor uses the existing independent ADB service started above; a worker does not start that service.

Preparation explicitly creates private shared control/ADB-home/extension directories. The independent direct-USB ADB service uses caller UID/GID and supplementary groups, persistent keys and loopback port 5038. Direct workers receive the same supplementary groups. If an existing owned sidecar lacks required groups, stop it, explicitly remove that container and start it again; the CLI does not silently replace it. Workers only connect to that service and mount its home read-only. Stopping/cancelling a worker does not own the ADB server. The service can be stopped explicitly with `host docker-adb-stop --yes`.

## Select transport

| Mode     | Device connection                        | Required service                           | OS installation                              |
| -------- | ---------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| direct   | USB bus mount, caller USB permissions    | Independent reviewed-image service on 5038 | Direct fastboot allowed with an exact serial |
| host-adb | Existing host ADB endpoint, no USB mount | Host service normally on 5037              | Refused; use direct USB                      |

```sh
pxv device inspect --project-root "$P" --asset lab-01 \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
pxv device provision --project-root "$P" --asset lab-01 --operator 'Operator' \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct --dry-run
```

The CLI resolves the explicit local image to an immutable ID. It mounts an external project, the common control root and installed extensions; workers do not receive a registry token. Run native and Docker work as the same operator UID and use the same control directory. Do not mount a project on several workstations concurrently.

Direct workers need caller USB permissions and the reviewed USB bus mount. Match
the phone's enrolled identity and accept its ADB authorization on the phone. For
OS installation, retain the exact signed codename-specific image and attend the
physical unlock/relock prompts. The container does not bypass erasure approval.

For an existing host ADB server, start it explicitly and select host-ADB mode:

```sh
pxv host adb-start --yes
pxv host docker-prepare --yes
pxv device inspect --project-root "$P" --asset lab-01 \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode host-adb
```

The CLI wrapper fixes this endpoint to loopback port 5037 and mounts no USB bus.
Compose can use its explicit `PXV_HOST_ADB_HOST`/`PXV_HOST_ADB_PORT` configuration. See [host dependency configuration](#environment-selection) for the authoritative endpoint, socket and key settings; native ADB names are launch output or sidecar configuration.
Workers never start or restart that host daemon. Fastboot cannot use an ADB TCP
endpoint, so `install-os` is refused in host-ADB mode. After service loss, inspect
the phone and shared reservations before resubmitting work.

A raw image defaults to `PXV_DOCKER_MODE=host-adb`, so short-lived execution stays in the foreground and flashing is refused. Direct raw `docker run` use must explicitly set `PXV_DOCKER_MODE=direct` and provide the reviewed USB permissions/mount, shared control directory and existing ADB service. The CLI and Compose direct mode set this marker explicitly.

## Host paths and terminal I/O

The CLI wrapper mounts the project at its canonical host path and retains `/project`
as an alias for existing saved plans. Recovery accepts that alias only after
verifying it is the same mounted project; reviewed evidence is never rewritten. New executions use the canonical project path.
Compose retains its existing `/project` layout. Saved review bytes are never rewritten.
Explicit file flags (including review files, inventory imports, policy files,
emulator evidence and extension invocation inputs) resolve from the caller’s working directory.
External input files are bound read-only at their canonical absolute paths. Explicit
handoff output and new-project directories are created privately when missing and
mounted writable, so their results persist on the host. File contents and embedded
paths are not rewritten. Runtime/control mount collisions, unsafe bind paths and
symlink leaf inputs/outputs are refused.

Attached workers inherit stdin, stdout and stderr; prompts and progress stream
immediately. Interactive terminals receive a TTY unless `--json` is selected.
For JSON automation, supply the command’s required explicit confirmations. Interrupts
are forwarded to Docker and the wrapper waits for worker shutdown before returning.
The first interrupt or execution timeout starts a 90-second grace period. Each
wrapper-created worker has a unique name and worker ownership labels, separate
from the ADB sidecar. After grace expires, the wrapper verifies ownership and
force-stops only that container's immutable ID, then terminates a stuck attached
client process group. Docker control commands have 10-second deadlines and client
reaping has a further 5-second deadline. Shutdown deadlines use a monotonic clock.
Normal exit codes are preserved; timeout returns `124`, SIGINT `130`, and SIGTERM
`143`. Cleanup diagnostics use stderr, including under `--json`.

If the daemon is unavailable, ownership differs or startup cancellation cannot be
confirmed, the wrapper reports the unique worker name and inspection instructions.
Returning an interruption status does not certify cleanup. Inspect that worker,
the run and retained recovery obligations before continuing. The wrapper does not
clear native fences or stop the separately owned ADB sidecar.

`mcp serve` does not accept `--execution docker`. For persistent container MCP,
configure raw `docker run -i` with the reviewed image, project/control/extension mounts
and host-ADB endpoint described above, followed by `mcp serve` (and explicitly
`--allow-mutations` when authorized). Do not allocate a TTY: stdout is the MCP protocol.

## Command and container lifetime

`agent execute` in a CLI-created direct or host-ADB worker executes in the foreground until completion, failure or a manual checkpoint. Keep the invoking command and container running while it works. A pending result retains its run and next steps; resume explicitly after completing the checkpoint. Native host `agent execute` uses a detached durable worker instead.

A persistent MCP server container can launch detached tasks inside that container. Those processes still belong to the container: stopping or removing it interrupts them. Persistent project files retain evidence, but do not keep a stopped process running or prove cleanup. Inspect the phone, run status and shared recovery reservations before any further work. The separately owned ADB service has its own lifetime and is not stopped merely because a worker exits.

## Compose

`compose.yaml` is an alternative for explicitly managed local services. Set `PXV_IMAGE`, `PXV_PROJECT`, `PXV_UID` and `PXV_GID`; prepare the control/extension/ADB-home directories first. Profiles `adb`, `direct` and `host-adb` are independent: a read-only worker command does not implicitly start an ADB service. Bind mounts refuse to create missing host paths and image pulling is disabled.

Compose-managed services and CLI-owned services are distinct ownership records. Do not start two services on port 5038 or pretend an arbitrary existing container is the CLI-owned sidecar. Preserve shared reservations after container/host failure and use explicit recovery.

Release candidates and release provenance use schema 2. They record Node, supervisor JavaScript, Koffi version/platform/Node-API version, loader/addon hashes and artifact hashes. Schema 1 candidates must be regenerated. Portable, Debian, npm, OCI and experimental SEA formats include the supervisor bundle, Koffi loader and selected glibc x64 prebuild with reviewed notices. Existing ownership records, IPC protocol and receipts remain schema/protocol 1; policies are unversioned. Never clear host control state to regenerate a candidate. Engine integrity binds source/build bytes and the selected supervisor, addon and loader.

Extension installation and updates require native host execution, including when
requested through MCP. Run them outside Docker against the shared extension store;
then lock/review the changed project before container execution. Docker and raw
container install/update calls are rejected before archive acquisition. Workers
retain read-only extension mounts for inspection, invocation and declared
contributions; explicit removal changes only the project lock.

## Troubleshooting before device work

| Symptom | Next step |
| --- | --- |
| Tool missing or wrong version | Inspect doctor output and the selected executable overrides; rerun doctor after correcting them. |
| USB permission denied | Fix the ordinary operator account’s device permissions and reconnect; provisioning should not run as root. |
| Unauthorized ADB device | Privately unlock the exact phone and approve the intended host key. |
| Existing server unavailable | Restore the configured owned service; retain recovery state and do not switch endpoints to bypass it. |
| Host-ADB OS installation refused | Use the separately prepared direct-USB path for the reviewed destructive phase. |
| Interrupted worker or cleanup uncertainty | Follow [inspected recovery](recovery-and-maintenance.md#recover-an-interrupted-pxv-operation). |
