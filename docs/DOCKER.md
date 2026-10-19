# Docker operation

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

Preparation explicitly creates private shared control/ADB-home/extension directories. The independent direct-USB ADB service uses caller UID/GID, persistent keys and loopback port 5038. Workers only connect to that service and mount its home read-only. Stopping/cancelling a worker does not own the ADB server. The service can be stopped explicitly with `host docker-adb-stop --yes`.

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
Compose can use its explicit `PXV_HOST_ADB_HOST`/`PXV_HOST_ADB_PORT` configuration. See [host dependency configuration](HOST_DEPENDENCIES.md#environment-selection) for the authoritative endpoint, socket and key settings; native ADB names are launch output or sidecar configuration.
Workers never start or restart that host daemon. Fastboot cannot use an ADB TCP
endpoint, so `install-os` is refused in host-ADB mode. After service loss, inspect
the phone and shared reservations before resubmitting work.

A raw image defaults to `PXV_DOCKER_MODE=host-adb`, so short-lived execution stays in the foreground and flashing is refused. Direct raw `docker run` use must explicitly set `PXV_DOCKER_MODE=direct` and provide the reviewed USB permissions/mount, shared control directory and existing ADB service. The CLI and Compose direct mode set this marker explicitly.

## Command and container lifetime

`agent execute` in a CLI-created direct or host-ADB worker executes in the foreground until completion, failure or a manual checkpoint. Keep the invoking command and container running while it works. A pending result retains its run and next steps; resume explicitly after completing the checkpoint. Native host `agent execute` uses a detached durable worker instead.

A persistent MCP server container can launch detached tasks inside that container. Those processes still belong to the container: stopping or removing it interrupts them. Persistent project files retain evidence, but do not keep a stopped process running or prove cleanup. Inspect the phone, run status and shared recovery reservations before any further work. The separately owned ADB service has its own lifetime and is not stopped merely because a worker exits.

## Compose

`compose.yaml` is an alternative for explicitly managed local services. Set `PXV_IMAGE`, `PXV_PROJECT`, `PXV_UID` and `PXV_GID`; prepare the control/extension/ADB-home directories first. Profiles `adb`, `direct` and `host-adb` are independent: a read-only worker command does not implicitly start an ADB service. Bind mounts refuse to create missing host paths and image pulling is disabled.

Compose-managed services and CLI-owned services are distinct ownership records. Do not start two services on port 5038 or pretend an arbitrary existing container is the CLI-owned sidecar. Preserve shared reservations after container/host failure and use explicit recovery.

Release candidates and release provenance use schema 2. They record Node, supervisor JavaScript, Koffi version/platform/Node-API version, loader/addon hashes and artifact hashes. Schema 1 candidates must be regenerated. Portable, Debian, npm, OCI and experimental SEA formats include the supervisor bundle, Koffi loader and selected glibc x64 prebuild with reviewed notices. Existing ownership records, IPC protocol and receipts remain schema/protocol 1; policies are unversioned. Never clear host control state to regenerate a candidate. Engine integrity binds source/build bytes and the selected supervisor, addon and loader.
