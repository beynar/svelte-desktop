#!/bin/sh
# Static + Wine checks of the Windows build (no Windows machine needed):
#   1. exports of shell.dll (llvm-objdump)
#   2. smoke.exe under Wine: loads shell.dll, drives the dispatcher (no WebView2)
#   3. optional: the NSIS installer of a packaged app, silent install + uninstall
# Usage: native/docker/windows/wine-smoke.sh [path/to/App-setup.exe]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
native=$(cd "$here/../.." && pwd)
docker build -q -t svelte-desktop-windows "$here" >/dev/null
docker build -q --platform linux/amd64 -f "$here/Dockerfile.wine" -t svelte-desktop-wine "$here" >/dev/null
echo "== exports of build/windows-x64/shell.dll"
docker run --rm -v "$native":/src svelte-desktop-windows sh -c \
  'llvm-objdump -p /src/build/windows-x64/shell.dll | sed -n "/Export Table/,\$p" | grep -o "shell_[a-z_]*" | sort | tr "\n" " "; echo;
   cd /src/build/windows-x64 && x86_64-w64-mingw32-clang++ -std=c++17 -O1 -Wall -static /src/docker/windows/smoke.cc -o smoke.exe'
echo "== smoke.exe under Wine"
docker run --rm --platform linux/amd64 -v "$native/build/windows-x64":/w -w /w svelte-desktop-wine \
  sh -c 'xvfb-run -a sh -c "wineboot -i >/dev/null 2>&1; wine smoke.exe" 2>&1' | grep -E '^(ok|FAIL)|SMOKE'
if [ $# -ge 1 ]; then
  setup=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
  echo "== NSIS installer under Wine: $(basename "$setup")"
  docker run --rm --platform linux/amd64 -v "$(dirname "$setup")":/d svelte-desktop-wine sh -c "
    wineboot -i >/dev/null 2>&1
    wine '/d/$(basename "$setup")' /S; wineserver -w
    dir=\$(ls -d \"\$WINEPREFIX/drive_c/users/\$(whoami)/AppData/Local/Programs/\"*/ 2>/dev/null | head -1)
    echo \"installed: \$dir\"; ls -la \"\$dir\" \"\$dir/addons\" 2>/dev/null
    echo '-- HKCU uninstall + classes'
    wine reg query 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' /s 2>/dev/null | tr -d '\r' | grep -E 'HKEY|DisplayName|DisplayVersion|UninstallString|InstallLocation|EstimatedSize'
    wine reg query 'HKCU\\Software\\Classes' /s 2>/dev/null | tr -d '\r' | grep -iE 'URL Protocol|shell.open.command|OpenWithProgids|HKEY_CURRENT_USER.Software.Classes.[a-z.]*\$' | head -20
    ls \"\$WINEPREFIX/drive_c/users/\$(whoami)/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/\" | grep -i lnk
    echo '-- silent uninstall'
    wine \"\$dir/Uninstall.exe\" /S; wineserver -w; sleep 2
    ls \"\$dir\" 2>/dev/null && echo 'still present' || echo 'removed'
    wine reg query 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' /s 2>/dev/null | tr -d '\r' | grep -c DisplayName || true
  "
fi
