#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$ROOT/guides/source/rebuild.mjs" "$@"
