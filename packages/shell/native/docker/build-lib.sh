#!/bin/sh
# Builds native/build/linux-<arch>/libshell.so from a non-Linux host, in the
# Docker image (native/docker/Dockerfile). Usage: native/docker/build-lib.sh [arm64|x64]
set -e
here=$(cd "$(dirname "$0")" && pwd)
shell=$(cd "$here/../.." && pwd)
# One image per architecture: an arm64 image doesn't run for an x64 target, and a Mac builds both.
case "${1:-$(uname -m)}" in arm64|aarch64) PLATFORM=linux/arm64 TAG=arm64 ;; *) PLATFORM=linux/amd64 TAG=x64 ;; esac
IMAGE=${IMAGE:-kitop-linux:$TAG}
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build --platform "$PLATFORM" -t "$IMAGE" "$here"
docker run --rm --platform "$PLATFORM" -v "$shell":/shell -w /shell "$IMAGE" native/build-linux.sh
