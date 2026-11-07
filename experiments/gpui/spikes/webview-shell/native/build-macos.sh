#!/bin/sh
# Builds libshell.dylib = webview/webview (WKWebView backend) + thread-safe shims.
# WEBVIEW_SRC defaults to a shallow clone of https://github.com/webview/webview.
set -e
cd "$(dirname "$0")"
WEBVIEW_SRC=${WEBVIEW_SRC:-/tmp/research/webview/src}
clang++ -std=c++14 -Os -dynamiclib -DWEBVIEW_BUILD_SHARED -DWEBVIEW_SHARED \
  -I"$WEBVIEW_SRC/core/include" "$WEBVIEW_SRC/core/src/webview.cc" shell.cc \
  -framework WebKit -framework Cocoa -Wl,-dead_strip -o libshell.dylib
strip -x libshell.dylib
ls -la libshell.dylib
