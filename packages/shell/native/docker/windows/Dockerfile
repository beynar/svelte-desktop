# Cross toolchain for the Windows backend (native/windows) and the Windows
# packager: llvm-mingw (clang + lld + mingw-w64 UCRT headers/libs, x86_64 and
# aarch64 targets), the WebView2 SDK headers from NuGet, NSIS and osslsigncode.
# Runs on linux/arm64 and linux/amd64 hosts (llvm-mingw ships both host builds).
#
#   docker build -t svelte-desktop-windows native/docker/windows
FROM debian:bookworm-slim

ARG LLVM_MINGW=20261020
ARG WEBVIEW2_SDK=1.0.4314.35

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip make file nsis osslsigncode python3 \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$(uname -m)" in aarch64|arm64) host=aarch64 ;; x86_64|amd64) host=x86_64 ;; *) echo "unsupported host $(uname -m)"; exit 1 ;; esac; \
    curl -fsSL "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW}/llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-${host}.tar.xz" \
      | tar -xJ -C /opt; \
    mv /opt/llvm-mingw-* /opt/llvm-mingw; \
    /opt/llvm-mingw/bin/x86_64-w64-mingw32-clang --version | head -1

# WebView2 SDK: only the two headers (WebView2.h, WebView2EnvironmentOptions.h).
# No WebView2Loader.dll: the shell uses webview/webview's built-in loader.
RUN set -eu; \
    curl -fsSL -o /tmp/wv2.zip "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WEBVIEW2_SDK}"; \
    mkdir -p /opt/webview2/include /tmp/wv2; \
    unzip -q /tmp/wv2.zip 'build/native/include/*' -d /tmp/wv2; \
    cp /tmp/wv2/build/native/include/WebView2.h /tmp/wv2/build/native/include/WebView2EnvironmentOptions.h /opt/webview2/include/; \
    echo "${WEBVIEW2_SDK}" > /opt/webview2/VERSION; \
    rm -rf /tmp/wv2 /tmp/wv2.zip

ENV PATH=/opt/llvm-mingw/bin:$PATH \
    WEBVIEW2_INCLUDE=/opt/webview2/include

WORKDIR /src
