#!/bin/sh
# What a real update needs on macOS or Windows, with no certificates and no bucket: examples/notes
# built as 0.1.0 and 0.2.0, published with the commands of the release workflow in the docs
# (`release fetch-previous`, then `merge`, into a folder standing in for the bucket). The test is
# examples/notes/tests/update-real.test.ts. It edits this checkout: for CI (update-test.yml).
#   build.sh <work dir> <darwin-arm64 | windows-x64>
set -e
W=$1
PLATFORM=$2
PORT=47992
mkdir -p "$W"
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
CLI="bun $ROOT/packages/shell/scripts/updater-cli.ts"
case "$PLATFORM" in windows-*) export KITOP_TARGET=windows ;; esac

cd "$ROOT/examples/notes"
rm -rf native/go native/rust native/zig native/python native/*.swift icon.svg
$CLI keygen --out "$W/updater.key" >"$W/updater.pub" 2>/dev/null
PUB=$(cat "$W/updater.pub")
bun -e "
  const f = 'desktop.config.ts';
  const s = await Bun.file(f).text();
  await Bun.write(f, s.replace('defineConfig({', \"defineConfig({ update: { manifestUrl: 'http://127.0.0.1:$PORT/update.json', publicKey: '$PUB' },\"));
"
grep -q "$PORT/update.json" desktop.config.ts

build() {
  bun -e "
    const f = await Bun.file('package.json').json();
    f.version = '$1';
    await Bun.write('package.json', JSON.stringify(f, null, '\t') + '\n');
  "
  bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -2
  mkdir -p "$W/$2"
  case "$PLATFORM" in
    windows-*) cp -R ".desktop/dist/Svelte Notes-windows-x64" "$W/$2/app" ;;
    *) ditto ".desktop/dist/Svelte Notes.app" "$W/$2/app.app" ;;
  esac
}
publish() {
  mkdir -p "$W/$2"
  $CLI merge .desktop/dist/release/update.unsigned.json --key "$W/updater.key" --out "$W/$2/update.json"
  $CLI verify "$W/$2/update.json" --public-key "$PUB"
  cp -R ".desktop/dist/release/$1" "$W/$2/"
}

build 0.1.0 a
publish 0.1.0 feed-a

# The next build finds the previous release the way a release does: from the published feed.
rm -rf .desktop/dist/release
bun -e "Bun.serve({ hostname: '127.0.0.1', port: $PORT, fetch: (r) => new Response(Bun.file('$W/feed-a' + decodeURIComponent(new URL(r.url).pathname))) }); await Bun.sleep(600000);" &
FEED=$!
sleep 1
$CLI fetch-previous "http://127.0.0.1:$PORT/update.json" --platform "$PLATFORM" --public-key "$PUB"
kill "$FEED"

build 0.2.0 b
publish 0.2.0 feed-b
ls "$W"/feed-b/0.2.0/
rm -f "$W/updater.key"
