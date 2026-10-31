#!/bin/sh
# Builds the Windows backend (native/windows + native/portable) into
# native/build/windows-<arch>/shell.dll with the llvm-mingw cross toolchain in
# Docker (native/docker/windows). Works from macOS/Linux, arm64 or x64 hosts.
#
#   native/build-windows.sh            # x64
#   native/build-windows.sh x64 arm64  # both
set -eu
cd "$(dirname "$0")"
IMAGE=${SVELTE_DESKTOP_WINDOWS_IMAGE:-svelte-desktop-windows}
command -v docker >/dev/null 2>&1 || { echo "build-windows.sh: docker is required" >&2; exit 1; }
docker build -q -t "$IMAGE" docker/windows >/dev/null
[ $# -eq 0 ] && set -- x64
for arch in "$@"; do
  docker run --rm -v "$PWD":/src "$IMAGE" sh /src/docker/windows/build.sh "$arch"
done
