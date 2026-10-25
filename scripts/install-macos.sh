#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED

# The release archive contains a complete, hash-checked runtime and app.
# No credentials are passed as shell arguments or printed by this installer.
if [ "$#" -ne 0 ]; then
  echo "This installer does not accept arguments." >&2
  exit 2
fi
if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  echo "Use the Windows package on Windows." >&2
  exit 2
fi
bundle_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
if [ ! -x "$bundle_dir/node" ] || [ ! -f "$bundle_dir/manifest.json" ]; then
  echo "Open Install.command from the complete Abilock macOS package." >&2
  exit 3
fi
exec "$bundle_dir/node" "$bundle_dir/runtime/bin/install-bundle.mjs" "$bundle_dir"
