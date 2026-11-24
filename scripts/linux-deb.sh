#!/usr/bin/env bash
# Builds the Debian package (.deb, x86_64) from Windows (Git Bash), in a Debian 12 build chroot
# inside WSL Debian, so it runs on Debian 12 (bookworm), 13 (trixie) and newer.
#   scripts/linux-deb.sh   -> builds/linux/goodink_<version>_amd64.deb
#
# One-time setup (as in AGENTS.md → Linux): `wsl --install -d Debian`, then debootstrap bookworm
# into /srv/bookworm and install the build packages (scripts/linux-chroot.sh does both).
# The renderer is built on Windows (npm run build:web) and copied in; ONNX Runtime for the
# on-device math reader is downloaded once, checksum-pinned, and shipped in /usr/lib/goodink.
set -euo pipefail
cd "$(dirname "$0")/.."

ORT_VERSION=1.22.0
# libonnxruntime.so from Microsoft's signed NuGet package (byte-identical to the one in its Maven jar)
ORT_SO_SHA256=3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673
CHROOT=/srv/bookworm
SRC=/root/goodink
export MSYS_NO_PATHCONV=1
# commands go in on stdin: wsl.exe cuts a multi-line command line at its first line break
wslrun() { wsl -d Debian -u root -- bash -s <<< "$1"; }

# this checkout as WSL sees it (/c/Users/... -> /mnt/c/Users/...)
HERE="$(pwd | sed 's#^/\([a-z]\)/#/mnt/\1/#')"

echo "== renderer (Windows)"
npm run build:web >/dev/null

echo "== ONNX Runtime $ORT_VERSION for Linux"
mkdir -p src-tauri/linux
if [ ! -f src-tauri/linux/libonnxruntime.so ]; then
  wslrun "set -e; cd /tmp && curl -sSfLo ort.nupkg https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$ORT_VERSION/microsoft.ml.onnxruntime.$ORT_VERSION.nupkg && rm -rf ortn && mkdir ortn && cd ortn && unzip -q ../ort.nupkg runtimes/linux-x64/native/libonnxruntime.so && cp runtimes/linux-x64/native/libonnxruntime.so '$HERE/src-tauri/linux/libonnxruntime.so'"
fi
echo "$ORT_SO_SHA256  src-tauri/linux/libonnxruntime.so" | sha256sum -c - >/dev/null || { echo "ONNX Runtime checksum mismatch"; rm -f src-tauri/linux/libonnxruntime.so; exit 1; }

echo "== sources into the build chroot"
wslrun "set -e; C=$CHROOT; for d in proc sys dev dev/pts; do mountpoint -q \$C/\$d || mount --bind /\$d \$C/\$d; done
  mkdir -p \$C$SRC
  rsync -a --delete --exclude node_modules --exclude src-tauri/target --exclude builds --exclude construct \
    --exclude /goodink --exclude download --exclude src-tauri/gen/android --exclude .git '$HERE/' \$C$SRC/"

echo "== build (Debian 12)"
VERSION="$(node -p "require('./package.json').version")"
CLI="$(node -p "require('./node_modules/@tauri-apps/cli/package.json').version")"
wslrun "env -i HOME=/root TERM=dumb /usr/sbin/chroot $CHROOT /bin/bash $SRC/scripts/linux-build-inner.sh $CLI"

mkdir -p builds/linux
DEB="goodink_${VERSION}_amd64.deb"
wslrun "cp $CHROOT/root/target/release/bundle/deb/$DEB '$HERE/builds/linux/$DEB'"
echo "== builds/linux/$DEB ($(du -h "builds/linux/$DEB" | cut -f1))"
