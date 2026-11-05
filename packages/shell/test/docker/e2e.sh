#!/bin/sh
# End-to-end suites on Linux, in the image, under a headless session: the built apps driven by
# launch(). From the host: test/docker/run.sh e2e
# Native plugins that need tools the image doesn't have are removed from this copy.
set -e
mkdir -p /work
cd /src
tar -cf - --exclude=node_modules --exclude=.desktop --exclude=.svelte-kit --exclude=native/build --exclude=test/docker/results \
  packages/shell examples/notes examples/panes examples/dashboard | tar -xf - -C /work
(cd /work/packages/shell && bun install >/dev/null 2>&1)
SESSION_SH=/work/packages/shell/test/docker/session.sh . /work/packages/shell/test/docker/session.sh

prepare() {
  cd "/work/examples/$1"
  rm -rf native/go native/rust native/zig native/python native/*.swift icon.svg
  bun install >/dev/null 2>&1
}

prepare notes
# Server code that dies on demand, in this copy only (crash-recovery.test.ts).
cp /work/packages/shell/test/docker/crash-probe.ts src/lib/server/crash-probe.ts
echo "import '#lib/server/crash-probe.ts';" >> src/hooks.server.ts
bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -1
bun test --timeout 60000 tests/mcp.test.ts tests/relaunch.test.ts
bun test --timeout 60000 tests/app.test.ts -t 'host.store'
bun test --timeout 60000 /work/packages/shell/test/docker/crash-recovery.test.ts

# With an `update` config: rollback on a real app. Then a signed build, which has no test channel.
sed -i "s|defineConfig({|defineConfig({ update: { manifestUrl: 'https://updates.invalid/update.json', publicKey: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=' },|" desktop.config.ts
bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -1
bun test --timeout 60000 /work/packages/shell/test/docker/update-rollback.test.ts
CODESIGN_IDENTITY="Developer ID Application: Test" bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -1
grep -q 'testChannel: false' .desktop/stage/desktop-worker.js

prepare panes
bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -1
bun test --timeout 60000 tests/panes.test.ts
A11Y_APP=panes bun test --timeout 60000 /work/packages/shell/test/docker/a11y.test.ts

# Under vite dev, with only what's known to pass: `tests/tabs.test.ts` has two failures of its own.
prepare dashboard
bun test --timeout 60000 tests/tabs.test.ts -t 'popover route'
A11Y_APP=dashboard A11Y_SPLIT=0 bun test --timeout 60000 /work/packages/shell/test/docker/a11y.test.ts
A11Y_APP=dashboard A11Y_SPLIT=1 bun test --timeout 60000 /work/packages/shell/test/docker/a11y.test.ts

# Real updates of the Linux app folder and AppImage, and their rollback (about 2 minutes).
sh /work/packages/shell/test/docker/update.sh
