#!/bin/sh
# Inside the Docker image (test/docker/run.sh notes): copy the repo's shell
# package + examples/notes, install the example's dependencies for linux, build
# it with `vite build` (→ package-linux.ts: app dir, tar.gz, AppImage), then
# drive the built app under Xvfb with launch() (test/docker/notes-linux.test.ts).
set -e
mkdir -p /work /results
cd /src
tar -cf - --exclude=node_modules --exclude=.desktop --exclude=.svelte-kit --exclude=native/build --exclude=test/docker/results \
  packages/shell examples/notes | tar -xf - -C /work
cd /work/examples/notes
echo "── bun install (linux-$(uname -m))"
bun install 2>&1 | tail -3
SESSION_SH=/work/packages/shell/test/docker/session.sh . /work/packages/shell/test/docker/session.sh
echo "── vite build"
bunx --bun vite build 2>&1 | grep -v "^\s*$" | tail -25
echo "── output"
ls -la .desktop/dist
find ".desktop/dist/Svelte Notes" -maxdepth 2 | sort
cat ".desktop/dist/Svelte Notes/"*.desktop
echo "── e2e (launch() → the built app in its WebKitGTK window)"
RESULTS=/results bun test --timeout 60000 /work/packages/shell/test/docker/notes-linux.test.ts
echo "── vite dev (launch({ dev: true }) → the WebKitGTK window on the Vite server)"
bun test --timeout 180000 /work/packages/shell/test/docker/notes-linux-dev.test.ts 2>&1 | grep -E "pass|fail|error" | tail -5
echo "── updater release artifacts (0.1.0 → 0.2.0, signed manifest, delta patch)"
bun /work/packages/shell/test/docker/release-linux.ts 2>&1 | grep -E "^(✓|✗|release|FAILED)"
