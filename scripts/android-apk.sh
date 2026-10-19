#!/usr/bin/env bash
# Builds the Android APK on Windows (Git Bash).
#   scripts/android-apk.sh            release APK for arm64 tablets, signed  -> builds/android/
#   scripts/android-apk.sh x86_64 debug   debug APK for the x86_64 emulator
#
# `tauri android build` compiles everything but then symlinks the Rust library into jniLibs, which
# Windows refuses without Developer Mode. So: let it compile (that last step fails), copy the
# library in, and run Gradle without its Rust task. Release builds are signed with a key kept
# outside the repo (%LOCALAPPDATA%\goodink-android\release.keystore, made on first use; back it up:
# updates to an installed app must be signed with the same key).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=${1:-aarch64}
PROFILE=${2:-release}
case $TARGET in
  aarch64) ARCH=arm64; ABI=arm64-v8a ;;
  x86_64) ARCH=x86_64; ABI=x86_64 ;;
  armv7) ARCH=arm; ABI=armeabi-v7a ;;
  *) echo "unknown target $TARGET (aarch64, x86_64, armv7)"; exit 2 ;;
esac

ANDROID_ROOT="$LOCALAPPDATA/Android"
export JAVA_HOME="$(cygpath -w "$(ls -d "$ANDROID_ROOT"/jdk-17* | head -1)")"
export ANDROID_HOME="$(cygpath -w "$ANDROID_ROOT/Sdk")"
NDK_DIR="$(ls -d "$ANDROID_ROOT"/Sdk/ndk/* | sort -V | tail -1)"
export NDK_HOME="$(cygpath -w "$NDK_DIR")"
BUILD_TOOLS="$(ls -d "$ANDROID_ROOT"/Sdk/build-tools/* | sort -V | tail -1)"

flag=$([ "$PROFILE" = debug ] && echo --debug || true)
echo "== compiling ($TARGET, $PROFILE)"
# fails at the symlink step on Windows without Developer Mode; everything before it is what we need
npx tauri android build $flag --target "$TARGET" --apk || true

SO="src-tauri/target/$TARGET-linux-android/$PROFILE/libgoodink_lib.so"
[ -f "$SO" ] || { echo "the Rust library was not built: $SO"; exit 1; }
# a stale library would silently ship old code
if [ -n "$(find src-tauri/src dist/renderer -newer "$SO" -type f 2>/dev/null | head -1)" ]; then
  echo "the Rust library is older than the sources: the compile step failed"; exit 1
fi
mkdir -p "src-tauri/gen/android/app/src/main/jniLibs/$ABI"
cp "$SO" "src-tauri/gen/android/app/src/main/jniLibs/$ABI/"

A="$(tr '[:lower:]' '[:upper:]' <<< "${ARCH:0:1}")${ARCH:1}"
P="$(tr '[:lower:]' '[:upper:]' <<< "${PROFILE:0:1}")${PROFILE:1}"
echo "== packaging (assemble$A$P)"
(cd src-tauri/gen/android && ./gradlew.bat "assemble$A$P" -x "rustBuild$A$P")

APK_DIR="src-tauri/gen/android/app/build/outputs/apk/$ARCH/$PROFILE"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p builds/android
if [ "$PROFILE" = debug ]; then
  cp "$APK_DIR"/*.apk "builds/android/goodink-$VERSION-$ARCH-debug.apk"
  echo "== builds/android/goodink-$VERSION-$ARCH-debug.apk"
  exit 0
fi

KEYS="$LOCALAPPDATA/goodink-android"
STORE="$KEYS/release.keystore"
if [ ! -f "$STORE" ]; then
  echo "== making the release signing key in $KEYS (back this folder up)"
  mkdir -p "$KEYS"
  node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))" > "$KEYS/password.txt"
  "$JAVA_HOME/bin/keytool.exe" -genkeypair -keystore "$(cygpath -w "$STORE")" -alias goodink -keyalg RSA -keysize 4096 -validity 10000 \
    -storepass:file "$(cygpath -w "$KEYS/password.txt")" -dname "CN=goodink" >/dev/null
fi
UNSIGNED="$(ls "$APK_DIR"/*-unsigned.apk 2>/dev/null | head -1 || ls "$APK_DIR"/*.apk | head -1)"
ALIGNED="$APK_DIR/aligned.apk"
OUT="builds/android/goodink-$VERSION-$ARCH.apk"
"$BUILD_TOOLS/zipalign.exe" -f -p 4 "$UNSIGNED" "$ALIGNED"
"$BUILD_TOOLS/apksigner.bat" sign --ks "$(cygpath -w "$STORE")" --ks-pass "file:$(cygpath -w "$KEYS/password.txt")" --ks-key-alias goodink --out "$OUT" "$ALIGNED"
"$BUILD_TOOLS/apksigner.bat" verify "$OUT"
echo "== $OUT ($(du -h "$OUT" | cut -f1))"
