#!/bin/sh
# Builds native/build/linux-<arch>/libshell.so from a non-Linux host, in the
# Docker image (native/docker/Dockerfile). Usage: native/docker/build-lib.sh [arm64|x64]
set -e
here=$(cd "$(dirname "$0")" && pwd)
shell=$(cd "$here/../.." && pwd)
case "${1:-$(uname -m)}" in arm64|aarch64) PLATFORM=linux/arm64 ;; *) PLATFORM=linux/amd64 ;; esac
IMAGE=${IMAGE:-svelte-desktop-linux}
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build --platform "$PLATFORM" -t "$IMAGE" "$here"
docker run --rm --platform "$PLATFORM" -v "$shell":/shell -w /shell "$IMAGE" native/build-linux.sh
