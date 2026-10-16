#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
exec "${PXV_NODE:-node}" "$repo_root/tools/personal-recovery.mjs" create "$@"
