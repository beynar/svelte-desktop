#!/bin/sh
# A real update on Linux (test/docker/run.sh update, and the end of e2e.sh): examples/notes built as
# 0.1.0, 0.2.0 and a 0.3.0 that crashes, as the app folder and as an AppImage, published with
# `release fetch-previous`, `merge` and `make-manifest`. update-linux.test.ts then drives them.
# Built as root; run as a normal user, or nothing would ever be read-only.
set -e
W=/tmp/update
PORT=47991
case "$(uname -m)" in aarch64 | arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
rm -rf "$W" /tmp/upd
mkdir -p "$W" /work
chmod 755 "$W"

# On its own copy: e2e.sh edits examples/notes in place.
cd /src
tar -cf - --exclude=node_modules --exclude=.desktop --exclude=.svelte-kit --exclude=native/build --exclude=test/docker/results \
  packages/shell | tar -xf - -C /work
(cd /work/packages/shell && bun install >/dev/null 2>&1)
rm -rf /work/examples/notes-update
mkdir -p /work/examples/notes-update
tar -cf - --exclude=node_modules --exclude=.desktop --exclude=.svelte-kit -C examples/notes . | tar -xf - -C /work/examples/notes-update
cd /work/examples/notes-update
rm -rf native/go native/rust native/zig native/python native/*.swift icon.svg
bun install >/dev/null 2>&1

CLI="bun /work/packages/shell/scripts/updater-cli.ts"
$CLI keygen --out "$W/updater.key" >"$W/updater.pub" 2>/dev/null
PUB=$(cat "$W/updater.pub")
sed -i "s|defineConfig({|defineConfig({ update: { manifestUrl: 'http://127.0.0.1:$PORT/update.json', publicKey: '$PUB' },|" desktop.config.ts

# build <version> <dir>: the build, and what a user would have got from it.
build() {
  sed -i "s|\"version\": \"[^\"]*\"|\"version\": \"$1\"|" package.json
  bunx --bun vite build 2>&1 | grep -E " error|✓ /|AppImage" | tail -2
  mkdir -p "$W/$2"
  cp -a ".desktop/dist/Svelte Notes" "$W/$2/folder"
  cp .desktop/dist/*-"$1"-linux-*.AppImage "$W/$2/app.AppImage" 2>/dev/null || echo "no AppImage for $1"
}
# publish <version> <dir>: what CI does, the unsigned manifest of this build signed by `release merge`.
publish() {
  mkdir -p "$W/$2"
  $CLI merge .desktop/dist/release/update.unsigned.json --key "$W/updater.key" --out "$W/$2/update.json"
  $CLI verify "$W/$2/update.json" --public-key "$PUB"
  cp -a ".desktop/dist/release/$1" "$W/$2/"
}

build 0.1.0 a
publish 0.1.0 feed-a

# The next build finds the previous release the way CI does: from the published feed.
rm -rf .desktop/dist/release
bun -e "Bun.serve({ hostname: '127.0.0.1', port: $PORT, fetch: (r) => new Response(Bun.file('$W/feed-a' + decodeURIComponent(new URL(r.url).pathname))) })" &
FEED=$!
sleep 1
$CLI fetch-previous "http://127.0.0.1:$PORT/update.json" --platform "linux-$ARCH" --public-key "$PUB"
kill "$FEED"
ls .desktop/dist/release/0.1.0/*-linux-"$ARCH".tar.zst >/dev/null

build 0.2.0 b
publish 0.2.0 feed-b
ls "$W"/feed-b/0.2.0/*.sdpatch >/dev/null

# Dies in the app's code before any page. Not while `vite build` loads the server: only compiled.
sed -i "1i if (Bun.main.startsWith('/\$bunfs/')) process.abort();" src/hooks.server.ts
build 0.3.0 c
# This one through make-manifest, with both kinds.
mkdir -p "$W/feed-c"
cp .desktop/dist/release/0.3.0/*.tar.zst "$W/feed-c/"
IMAGE_ARTIFACT=
[ -f "$W/c/app.AppImage" ] && IMAGE_ARTIFACT="--artifact appimage-$ARCH=$(echo "$W"/feed-c/*-appimage-"$ARCH".tar.zst)"
# shellcheck disable=SC2086 # empty, or two words
$CLI make-manifest --name dev.kitop.notes --version 0.3.0 --channel stable \
  --artifact "linux-$ARCH=$(echo "$W"/feed-c/*-linux-"$ARCH".tar.zst)" $IMAGE_ARTIFACT \
  --key "$W/updater.key" --out "$W/feed-c/update.json"

# What a system package looks like: owned by root.
rm -rf "/opt/Svelte Notes" /opt/notes.AppImage
cp -a "$W/a/folder" "/opt/Svelte Notes"
[ -f "$W/a/app.AppImage" ] && cp "$W/a/app.AppImage" /opt/notes.AppImage

id kit >/dev/null 2>&1 || useradd -m kit
rm -f "$W/updater.key"
chmod -R a+rX "$W" /work
ulimit -c 0
cd /work/examples/notes-update
unset DBUS_SESSION_BUS_ADDRESS
export HOME=/home/kit USER=kit XDG_RUNTIME_DIR=/tmp/runtime-kit DISPLAY=:98
export NO_AT_BRIDGE=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
setpriv --reuid=kit --regid=kit --init-groups sh -c '
  set -e
  mkdir -p -m 700 "$XDG_RUNTIME_DIR"
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X98 ] && break; sleep 0.1; done
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
  openbox >/dev/null 2>&1 &
  sleep 0.5
  bun test --timeout 180000 /work/packages/shell/test/docker/update-linux.test.ts
  # Read-only installs and another filesystem: as a normal user, /dev/shm at hand.
  cd /work/packages/shell && bun test src/updater/linux.test.ts
  pkill -u kit Xvfb || true
'
