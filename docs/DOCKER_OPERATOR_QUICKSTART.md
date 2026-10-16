# Docker direct-USB quickstart

Use an explicitly built local image and a dedicated isolated project. Install Docker/USB permissions as a host administrator before provisioning; the toolkit does not grant itself host privileges.

~~~sh
pnpm build:preview --formats oci
pxv host docker-prepare --yes
pxv host docker-adb-start --image YOUR_UNIQUE_IMAGE --yes
pxv host doctor --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
pxv device inspect --project-root "$P" --asset lab-01 \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
pxv device provision --project-root "$P" --asset lab-01 --operator 'Operator' \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
~~~

Replace the image placeholder with the builder's unique local tag. The CLI resolves it to an immutable local ID. The first host commands explicitly prepare private control/key directories and start the independently owned ADB service. Workers use port 5038; they do not start a daemon inside the native mutation group.

Connect the Pixel directly over USB, compare its enrolled identity and accept its host-key prompt on the phone. The container runs as the caller and needs access to the USB device through host permissions and the USB bus mount. A group number is host-specific; Compose's optional USB group must match the host rather than being treated as a universal constant.

OS installation still requires a reviewed OS policy, exact serial and explicit erasure authorization. Follow physical unlock/relock prompts; container access does not bypass them. Use `--dry-run` to inspect a plan before a real workflow.

After interrupted work, inspect shared recovery reservations and the phone before retrying. Stop only the service owned by this operator with `host docker-adb-stop --yes`. See [Docker architecture and Compose](DOCKER.md).
