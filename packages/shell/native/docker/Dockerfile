# Linux build + test image for the GTK3 / WebKitGTK 4.1 backend of libshell.
#   docker build -t svelte-desktop-linux packages/shell/native/docker
# Provides: compilers + GTK/WebKitGTK/appindicator/libnotify/libsecret headers,
# Xvfb + openbox (EWMH window manager) + dunst (notification daemon) + D-Bus +
# gnome-keyring (headless tests), Bun, appimagetool.
FROM ubuntu:24.04
ARG TARGETARCH
ARG BUN_VERSION=1.4.4
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config ca-certificates curl unzip git file xz-utils \
      libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libnotify-dev libsecret-1-dev \
      xvfb xauth dbus dbus-x11 at-spi2-core gnome-keyring libglib2.0-bin xdg-utils \
      fonts-dejavu-core adwaita-icon-theme librsvg2-common desktop-file-utils squashfs-tools \
      openbox dunst xdotool \
    && rm -rf /var/lib/apt/lists/*
# Bun (release zip from GitHub)
RUN set -e; case "$TARGETARCH" in arm64) A=aarch64 ;; *) A=x64 ;; esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${A}.zip"; \
    unzip -q /tmp/bun.zip -d /tmp/bun && mv /tmp/bun/bun-linux-${A}/bun /usr/local/bin/bun && ln -s bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun /tmp/bun.zip; bun --version
# appimagetool, unpacked (no FUSE in containers) + its type2 runtime (offline builds)
RUN set -e; case "$TARGETARCH" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac; \
    curl -fsSL -o /tmp/appimagetool "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${A}.AppImage"; \
    chmod +x /tmp/appimagetool; cd /opt && /tmp/appimagetool --appimage-extract >/dev/null && mv squashfs-root appimagetool && rm /tmp/appimagetool; \
    ln -s /opt/appimagetool/AppRun /usr/local/bin/appimagetool; \
    curl -fsSL -o /opt/appimage-runtime "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${A}"; \
    appimagetool --version || true
ENV APPIMAGE_RUNTIME=/opt/appimage-runtime NO_AT_BRIDGE=1
WORKDIR /work
