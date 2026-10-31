#!/bin/sh
# Builds libshell.so for Linux: the portable core (portable/core.cc: dispatcher,
# bridge protocol, permissions, plugin host) + the GTK 3 / WebKitGTK 4.1 backend
# (linux/*.cc). Needs: g++, pkg-config, libgtk-3-dev, libwebkit2gtk-4.1-dev,
# libsecret-1-dev (headers only: libnotify, appindicator and libsecret are
# dlopen()ed at runtime, so the .so only hard-depends on GTK and WebKitGTK).
# Usage: native/build-linux.sh            → native/build/linux-<arm64|x86_64>/libshell.so
# On macOS use native/docker/build-lib.sh (same script inside the Docker image).
set -e
cd "$(dirname "$0")"
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64|amd64) ARCH=x86_64 ;; *) ARCH=$(uname -m) ;; esac
OUT=${OUT:-build/linux-$ARCH}
mkdir -p "$OUT/obj"
CXX=${CXX:-g++}
PKGS="gtk+-3.0 webkit2gtk-4.1 x11"
CFLAGS="-std=c++17 -fPIC -O2 -fvisibility=hidden -Wall -Wno-deprecated-declarations -Wno-unused-function $(pkg-config --cflags $PKGS libsecret-1)"
OBJS=""
pids=""
# core.cc relies on <cstring>/<cstdio> arriving transitively (true with libc++); force them for libstdc++.
$CXX $CFLAGS -c portable/core.cc -o "$OUT/obj/core.o" & pids="$pids $!"
OBJS="$OUT/obj/core.o"
for src in linux/*.cc; do
  obj="$OUT/obj/$(basename "${src%.cc}").o"
  $CXX $CFLAGS -c "$src" -o "$obj" & pids="$pids $!"
  OBJS="$OBJS $obj"
done
fail=0
for p in $pids; do wait "$p" || fail=1; done
[ "$fail" = 0 ] || { echo "compile failed"; exit 1; }
$CXX -shared -Wl,-z,defs -Wl,--as-needed -Wl,-soname,libshell.so $OBJS $(pkg-config --libs $PKGS) -ldl -o "$OUT/libshell.so"
strip --strip-unneeded "$OUT/libshell.so"
ls -la "$OUT/libshell.so"
