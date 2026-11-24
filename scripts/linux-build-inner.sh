#!/bin/bash
# Runs inside the Debian 12 build chroot (started by scripts/linux-deb.sh): builds the .deb from the
# synced sources with the renderer already built. Usage: linux-build-inner.sh <tauri-cli-version>
set -euo pipefail
export PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_TARGET_DIR=/root/target
# every core: dependencies already build in parallel; split goodink's own crate and use thin LTO so
# the last step (one core for minutes with the release profile's codegen-units = 1 / lto = true)
# runs in parallel too
export CARGO_BUILD_JOBS="$(nproc)"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_LTO=thin
CLI="$1"
mkdir -p /root/cli
if ! grep -qs "\"version\": \"$CLI\"" /root/cli/node_modules/@tauri-apps/cli/package.json; then
  (cd /root/cli && npm i -s --no-audit --no-fund "@tauri-apps/cli@$CLI" >/dev/null)
fi
cd /root/goodink
/root/cli/node_modules/.bin/tauri build --bundles deb --config '{"build":{"beforeBuildCommand":""}}'
