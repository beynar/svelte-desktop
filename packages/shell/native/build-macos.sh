#!/bin/sh
# Builds libshell.dylib: vendored webview/webview (WKWebView backend) + shell_macos.mm
# + the platform dispatcher (platform_core.mm) and its service modules (platform_*.mm).
# Usage: native/build-macos.sh [arm64|x86_64]   (default: host arch)
set -e
cd "$(dirname "$0")"
ARCH=${1:-$(uname -m)}
OUT=${OUT:-build/darwin-$ARCH}
mkdir -p "$OUT/obj"
FLAGS="-arch $ARCH -mmacosx-version-min=12.0 -Os -fvisibility=hidden -DWEBVIEW_BUILD_SHARED -DWEBVIEW_SHARED -Ivendor/webview/include"
[ "$OUT/obj/webview.o" -nt vendor/webview/webview.cc ] || clang++ $FLAGS -std=c++17 -c vendor/webview/webview.cc -o "$OUT/obj/webview.o"
OBJS="$OUT/obj/webview.o"
for src in shell_macos.mm platform_*.mm; do
  obj="$OUT/obj/${src%.mm}.o"
  clang++ $FLAGS -std=c++17 -fobjc-arc -Wall -Wno-unused-function -c "$src" -o "$obj" &
  OBJS="$OBJS $obj"
done
wait
for o in $OBJS; do [ -f "$o" ] || { echo "missing $o (compile failed)"; exit 1; }; done
clang++ -arch "$ARCH" -mmacosx-version-min=12.0 -dynamiclib $OBJS \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers -framework Carbon \
  -framework IOKit -framework Security -framework LocalAuthentication -framework UserNotifications \
  -framework ServiceManagement -framework AVFoundation -framework CoreLocation -framework ApplicationServices -framework ScreenCaptureKit \
  -Wl,-dead_strip -install_name @rpath/libshell.dylib -o "$OUT/libshell.dylib"
strip -x "$OUT/libshell.dylib"
ls -la "$OUT/libshell.dylib"
