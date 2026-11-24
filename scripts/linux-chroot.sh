#!/bin/bash
# One-time setup for scripts/linux-deb.sh. Run as root in WSL Debian:
#   wsl --install -d Debian --no-launch
#   wsl -d Debian -u root -- bash /mnt/c/<path to goodink>/scripts/linux-chroot.sh
# Makes a Debian 12 (bookworm) build chroot in /srv/bookworm with Tauri's Linux build packages,
# Rust and Node, so the .deb links against Debian 12's libraries and runs on 12, 13 and newer.
set -e
export DEBIAN_FRONTEND=noninteractive
C=/srv/bookworm
apt-get update -qq
apt-get install -y -qq debootstrap rsync curl ca-certificates unzip >/dev/null
[ -x $C/bin/bash ] || debootstrap --variant=minbase bookworm $C http://deb.debian.org/debian
for d in proc sys dev dev/pts; do mountpoint -q $C/$d || mount --bind /$d $C/$d; done
cp /etc/resolv.conf $C/etc/resolv.conf
chroot $C /bin/bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential curl wget file ca-certificates pkg-config git \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
  nodejs npm xz-utils >/dev/null
[ -x /root/.cargo/bin/cargo ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null
/root/.cargo/bin/cargo --version; node --version; pkg-config --modversion webkit2gtk-4.1; ldd --version | head -1
'
