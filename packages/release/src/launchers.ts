/** @internal Generated launcher contract, also exercised independently by packaging tests. */
export function shellLauncher(previewId: string | undefined): string {
  const project = previewId
    ? `\n: "\${PXV_ROOT:=\${XDG_STATE_HOME:-\${HOME:?}/.local/state}/pxv/previews/${previewId}}"\nexport PXV_ROOT`
    : '';
  return `#!/bin/sh\nset -eu\npxv_launcher=$(readlink -f -- "$0")\npxv_dir=$(CDPATH='' cd -- "$(dirname -- "$pxv_launcher")/.." && pwd)\nexport PXV_RESOURCE_ROOT="$pxv_dir" PXV_SUPERVISOR="$pxv_dir/node_modules/@pxv/runtime/supervisor.js"${project}\nexec "$pxv_dir/bin/node" "$pxv_dir/lib/main.js" "$@"\n`;
}

export function dockerEntrypoint(): string {
  return `#!/bin/sh\nset -eu\numask 077\npxv_uid=$(id -u)\nif ! getent passwd "$pxv_uid" >/dev/null; then\n  pxv_nss=$(mktemp -d /tmp/pxv-nss.XXXXXX)\n  pxv_gid=$(id -g)\n  printf 'pxv:x:%s:%s::%s:/bin/sh\\n' "$pxv_uid" "$pxv_gid" "$HOME" > "$pxv_nss/passwd"\n  printf 'pxv:x:%s:\\n' "$pxv_gid" > "$pxv_nss/group"\n  export NSS_WRAPPER_PASSWD="$pxv_nss/passwd" NSS_WRAPPER_GROUP="$pxv_nss/group" LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libnss_wrapper.so\nfi\nexec /opt/pxv/bin/node /opt/pxv/lib/main.js "$@"\n`;
}
