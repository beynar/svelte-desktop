#!/bin/sh
# End-to-end auto-update: build v0.1.0 (installed to a temp dir) and v0.2.0
# (release/ = tar.zst + ed25519-signed update.json), serve release/ locally,
# run v0.1.0 → it downloads, verifies, swaps itself and relaunches as v0.2.0.
set -e
cd "$(dirname "$0")/.."
W=/tmp/upd; rm -rf $W; mkdir -p $W/install
bun ../../packages/shell/scripts/updater-cli.ts keygen --out $W/updater.key >/dev/null
PUB=$(cat $W/updater.key.pub)
cp desktop.config.ts $W/desktop.config.bak
trap 'cp $W/desktop.config.bak desktop.config.ts; pkill -f "upd/install/Svelte Notes.app" 2>/dev/null; kill $SPID 2>/dev/null; true' EXIT
build() {
  sed "s|	appName: 'Svelte Notes',|	appName: 'Svelte Notes',\n	version: '$1',\n	update: { manifestUrl: 'http://127.0.0.1:47811/update.json', publicKey: '$PUB', privateKey: '$W/updater.key', baseUrl: 'http://127.0.0.1:47811' },|" $W/desktop.config.bak > desktop.config.ts
  bunx --bun vite build >/dev/null 2>&1
}
build 0.1.0 && cp -R ".desktop/dist/Svelte Notes.app" $W/install/
build 0.2.0
cat > $W/serve.ts <<'TS'
const seen: string[] = [];
Bun.serve({ port: 47811, hostname: "127.0.0.1", fetch(req) { const p = decodeURIComponent(new URL(req.url).pathname); seen.push(p); Bun.write("/tmp/upd/served.log", seen.join("\n")); return new Response(Bun.file(process.argv[2] + p)); } });
TS
bun $W/serve.ts "$PWD/.desktop/dist/release" & SPID=$!
sleep 0.5
NOTES_UPDATE_PROBE=1 "$W/install/Svelte Notes.app/Contents/MacOS/SvelteNotes" >/dev/null 2>&1 &
for i in $(seq 1 60); do sleep 0.5; grep -q "started 0.2.0" $W/probe.log 2>/dev/null && break; done
V=$(plutil -extract CFBundleShortVersionString raw "$W/install/Svelte Notes.app"/Contents/Info.plist)
codesign --verify --deep --strict "$W/install/Svelte Notes.app"
DELTA=$(grep -c '\.sdpatch$' $W/served.log || true); FULL=$(grep -c '\.tar\.zst$' $W/served.log || true)
PATCH_SIZE=$(ls -l .desktop/dist/release/0.2.0/*.sdpatch 2>/dev/null | awk '{print $5}')
[ "$V" = "0.2.0" ] && grep -q "started 0.2.0" $W/probe.log && [ ! -e "$W/install/Svelte Notes.app".old ] && [ "$DELTA" -ge 1 ] && [ "$FULL" = 0 ] \
  && echo "update e2e: OK (0.1.0 → 0.2.0 via a ${PATCH_SIZE}-byte delta patch, relaunched, signature valid, backup cleaned)" \
  || { echo "update e2e: FAILED (version $V, delta requests $DELTA, full requests $FULL)"; cat $W/probe.log $W/served.log; exit 1; }
