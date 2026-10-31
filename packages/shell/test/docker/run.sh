#!/bin/sh
# Host entry point for the Linux backend (Docker; tested on macOS with Docker 29, linux/arm64).
#   test/docker/run.sh image      build the image (native/docker/Dockerfile)
#   test/docker/run.sh lib        build native/build/linux-<arch>/libshell.so
#   test/docker/run.sh platform   native platform suites under Xvfb   [suite...]
#   test/docker/run.sh notes      build examples/notes for Linux and drive it with launch()
#   test/docker/run.sh shell      interactive shell in the image (repo at /src)
set -e
here=$(cd "$(dirname "$0")" && pwd)
shell=$(cd "$here/../.." && pwd)      # packages/shell
repo=$(cd "$shell/../.." && pwd)      # repository root
IMAGE=${IMAGE:-svelte-desktop-linux}
cmd=${1:-platform}; [ $# -gt 0 ] && shift
[ "$cmd" = image ] || docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$shell/native/docker"
case "$cmd" in
  image) docker build -t "$IMAGE" "$shell/native/docker" ;;
  lib) docker run --rm -v "$shell":/shell -w /shell "$IMAGE" native/build-linux.sh ;;
  platform) docker run --rm --init -v "$shell":/shell -w /shell "$IMAGE" test/run-platform-linux.sh "$@" ;;
  notes) mkdir -p "$here/results"; docker run --rm --init -v "$repo":/src:ro -v "$here/results":/results "$IMAGE" sh /src/packages/shell/test/docker/notes.sh "$@" ;;
  shell) docker run --rm -it --init -v "$repo":/src:ro "$IMAGE" bash ;;
  *) echo "unknown command $cmd"; exit 2 ;;
esac
