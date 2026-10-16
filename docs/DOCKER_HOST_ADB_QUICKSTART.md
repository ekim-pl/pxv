# Docker with an existing host ADB server

Host-ADB mode is useful when the host already owns USB access and the ADB daemon. Start and authorize that host service explicitly. A worker connects to the existing endpoint and does not mount the USB bus or start/restart the daemon.

~~~sh
pxv host adb-start --yes
pxv host docker-prepare --yes
pxv device inspect --project-root "$P" --asset lab-01 \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode host-adb
pxv device provision --project-root "$P" --asset lab-01 --operator 'Operator' \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode host-adb
~~~

Use a previously built image; ordinary worker execution does not pull or publish one. The CLI Docker wrapper fixes host-ADB to 127.0.0.1:5037. Native/Compose endpoint configuration can use PXV_HOST_ADB_HOST/PXV_HOST_ADB_PORT where supported; it does not change the CLI Docker endpoint. Do not expose an unauthenticated ADB server on a public interface to work around connectivity.

The worker uses the same caller UID/GID, project, policy/extension lock and common recovery directory as native execution. Extensions are mounted read-only and registry authentication stays outside the container. Debugging trust remains a physical phone decision.

Fastboot cannot travel through an ADB TCP server. `device install-os` is refused in host-ADB mode. Use [direct USB](DOCKER_OPERATOR_QUICKSTART.md) for reviewed flashing.

If the host service disappears during a guarded operation, inspect the phone and recovery evidence. Do not silently start another daemon and replay the mutation. A report based on stored evidence is not a fresh inspection.
