#!/bin/sh
# Compiles native/windows + native/portable into shell.dll inside the
# svelte-desktop-windows image. Usage (from build-windows.sh):
#   docker run --rm -v <packages/shell/native>:/src svelte-desktop-windows sh /src/docker/windows/build.sh x64|arm64
set -eu
ARCH=${1:-x64}
case "$ARCH" in
  x64) TRIPLE=x86_64-w64-mingw32 ;;
  arm64) TRIPLE=aarch64-w64-mingw32 ;;
  *) echo "unknown arch $ARCH (x64|arm64)" >&2; exit 2 ;;
esac
OUT=/src/build/windows-$ARCH
OBJ=/tmp/obj-$ARCH
SHIM=/tmp/shim
rm -rf "$OBJ" && mkdir -p "$OBJ" "$OUT" "$SHIM"
# WebView2.h includes "EventToken.h"; mingw-w64 ships it lowercase (case-sensitive FS).
echo '#include <eventtoken.h>' > "$SHIM/EventToken.h"

CXX="$TRIPLE-clang++"
CXXFLAGS="-std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers -Wno-cast-function-type \
  -ffunction-sections -fdata-sections -DUNICODE -D_UNICODE -DNOMINMAX -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -DNTDDI_VERSION=0x0A00000B \
  -I$WEBVIEW2_INCLUDE -I$SHIM -I/src/windows -I/src/portable"
LIBS="-lole32 -loleaut32 -luuid -lshell32 -lshlwapi -luser32 -lgdi32 -ladvapi32 -ldwmapi -lwindowscodecs -lwtsapi32 -lversion"

echo "== $TRIPLE ($($CXX --version | head -1))"
echo "   WebView2 SDK $(cat /opt/webview2/VERSION)"
SOURCES="/src/portable/core.cc $(ls /src/windows/*.cc)"
for src in $SOURCES; do
  obj="$OBJ/$(basename "$src" .cc).o"
  echo "   cc $(echo "$src" | sed 's#^/src/##')"
  $CXX $CXXFLAGS -c "$src" -o "$obj" > "$obj.log" 2>&1 &
done
wait
failed=0
for src in $SOURCES; do
  obj="$OBJ/$(basename "$src" .cc).o"
  if [ -s "$obj.log" ]; then cat "$obj.log" >&2; fi
  test -f "$obj" || { echo "compile failed: $src" >&2; failed=1; }
done
[ "$failed" = 0 ] || exit 1

# Static libc++/libunwind (no extra DLLs to ship); the UCRT is part of Windows 10+.
$CXX -shared -o "$OUT/shell.dll" "$OBJ"/*.o -static -Wl,--gc-sections -s $LIBS
echo "   -> build/windows-$ARCH/shell.dll ($(wc -c < "$OUT/shell.dll") bytes)"
