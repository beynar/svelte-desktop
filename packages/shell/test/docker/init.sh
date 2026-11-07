#!/bin/sh
# `kitop init` on an app that exists already, from the packed tarball, as the tutorial has it
# (website/docs/convert-sveltekit-app.mdx): SvelteKit's demo app from `sv create`, with adapter-node.
# Its website is built and served by Node before and after, and must answer the same; then the desktop
# app is built and launched. And a static site, with adapter-static, built by Node.
# Nothing of the shell may reach a website but its `host`, which says it isn't the desktop.
# From the host: test/docker/run.sh init, or at the end of pack.sh with its tarball.
set -e
src=/src/packages/shell
NODE=/opt/node/bin
[ -n "$DBUS_SESSION_BUS_ADDRESS" ] || SESSION_SH=$src/test/docker/session.sh . "$src/test/docker/session.sh"
T=$(mktemp -d)
step() { echo "── $1"; }
tgz=$1
if [ -z "$tgz" ]; then
  mkdir "$T/shell"
  (cd "$src" && tar -cf - --exclude=node_modules --exclude=native/build --exclude=test/docker/results .) | tar -xf - -C "$T/shell"
  (cd "$T/shell" && bun pm pack --destination "$T" --quiet >/dev/null)
  tgz=$(ls "$T"/kitop-shell-*.tgz)
fi
adapter=$(bun -p "require('$src/package.json').peerDependencies['@sveltejs/adapter-bun']")
# Under Node: `vite build` and the server, with no Bun on the PATH it could fall back on.
node_only() { env PATH="$NODE:/usr/bin:/bin" "$@"; }
pages() { bun "$src/test/docker/init-pages.ts" "$@"; }
# The built website, on Node. Started as itself, so that stopping it stops the server and not a shell.
serve() { PORT=4190 env PATH="$NODE:/usr/bin:/bin" node build >"$T/node.log" 2>&1 & server=$!; }
stop() { kill $server; wait $server 2>/dev/null || true; }
# Quiet, but for its end when it fails.
quiet() { "$@" >"$T/out.log" 2>&1 || { tail -40 "$T/out.log"; return 1; }; }

step "sv create: SvelteKit's demo app, with adapter-node"
cd "$T"
quiet node_only sv create --template demo --types ts --add sveltekit-adapter="adapter:node" --no-install app
cd app
bun install 2>&1 | tail -1
git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm "sv create"

step "the website, before: built and served by Node"
quiet node_only npx vite build
serve
pages http://localhost:4190 / /about /sverdle /sverdle/how-to-play >"$T/before.txt"
stop

step "install the packages, then kitop init"
bun add -d "$tgz" "@sveltejs/adapter-bun@$adapter" @types/bun 2>&1 | tail -1
git add -A && git -c user.name=t -c user.email=t@t commit -qm "packages"
bunx kitop init
changed=$(git status --porcelain | tr '\n' ' ')
[ "$changed" = " M .gitignore  M package.json  M vite.config.ts ?? desktop.config.ts ?? tests/ " ] || { echo "init changed something else: $changed"; git status; exit 1; }
# Its options and its adapter where they were: without the plugin, the config it had.
[ "$(git show HEAD:vite.config.ts | tr -d ' \t\n,')" = "$(sed -e '/@kitop\/shell\/vite/d' -e 's/desktop()//' vite.config.ts | tr -d ' \t\n,')" ] || { echo "init changed vite.config.ts beyond desktop():"; git diff vite.config.ts; exit 1; }
grep -q "bridge: { allow: \[\] }" desktop.config.ts || { echo "init wrote no bridge.allow:"; cat desktop.config.ts; exit 1; }

step "the website, after: Node builds and serves the same pages"
rm -rf build
quiet node_only npx vite build
serve
pages http://localhost:4190 / /about /sverdle /sverdle/how-to-play >"$T/after.txt"
stop
diff "$T/before.txt" "$T/after.txt" || { echo "the website's pages changed with init"; exit 1; }
[ ! -e .desktop/dist ] || { echo "the website's build packaged a desktop app"; exit 1; }

step "the website's own host, and none of the desktop's files or imports"
mkdir -p src/routes/where
cat > src/routes/where/+page.svelte <<'PAGE'
<script lang="ts">
  import { onMount } from 'svelte';
  let hydrated = $state('no');
  onMount(() => (hydrated = String(host.available)));
</script>
<p>host is {host.available ? 'the desktop' : 'a website'}</p>
<p id="hydrated">{hydrated}</p>
PAGE
cat > src/routes/where/+page.desktop.svelte <<'PAGE'
<script lang="ts">
  import { mark } from '#lib/desktop-only';
</script>
<p>INIT_DESKTOP_PAGE {mark} host is {host.available ? 'the desktop' : 'a website'}</p>
PAGE
echo "export const mark = 'INIT_DESKTOP_DEP';" > src/lib/desktop-only.ts
rm -rf build
quiet node_only npx vite build
serve
pages http://localhost:4190 /where >"$T/where.txt"
stop
grep -q "host is a website" "$T/where.txt" || { echo "the website's host said otherwise:"; cat "$T/where.txt" "$T/node.log"; exit 1; }
grep -rq "needs the desktop app" build/client || { echo "the website's pages have no host"; exit 1; }
for marker in INIT_DESKTOP_PAGE INIT_DESKTOP_DEP desktop:hydrated __desktopView tabs:view-ready com.example.app; do
  if grep -rq "$marker" build; then echo "$marker is in the website's build"; exit 1; fi
done
# Of the shell, the server has its `host` and nothing else.
shell=$(grep -ho '"[^"]*@kitop/shell/[^"]*"' build/server/*.map build/server/chunks/*.map 2>/dev/null | sort -u | tr '\n' ' ')
[ "$shell" = '"../../node_modules/@kitop/shell/src/host/website.js" ' ] || { echo "the website's server has more of the shell: $shell"; exit 1; }

step "kitop doctor, then the desktop app: built and launched"
bunx kitop doctor
quiet bunx kitop build --linux
grep -E "✓ /" "$T/out.log" | tail -1
cat > tests/converted.test.ts <<'TEST'
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
beforeAll(async () => (app = await launch()));
afterAll(() => app?.close());
const get = (path: string) => app.eval<{ status: number; text: string }>(`fetch('${path}').then(async (r) => ({ status: r.status, text: await r.text() }))`);

test('its pages, with their server code, on Bun in the app', async () => {
  await app.waitFor(() => document.title === 'Home');
  for (const path of ['/about', '/sverdle', '/sverdle/how-to-play']) expect((await get(path)).status).toBe(200);
  expect((await get('/sverdle')).text).toContain('How to play');
});
test("the desktop's own file, and host says it's the desktop", async () => {
  const where = await get('/where');
  expect(where.text).toContain('INIT_DESKTOP_PAGE INIT_DESKTOP_DEP host is the desktop');
  expect(await app.eval('host.available')).toBe(true);
});
test('pages call nothing native until bridge.allow says so', async () => {
  expect(await app.eval("host.clipboard.readText().catch((e) => e.code)")).toBe('denied');
});
TEST
bun test --timeout 60000 tests/

step "a static site: adapter-static, built by Node"
cd "$T"
quiet node_only sv create --template minimal --types ts --add sveltekit-adapter="adapter:static" --no-install site
cd site
# What a static site has, and sv leaves to it.
echo "export const prerender = true;" > src/routes/+layout.ts
bun install 2>&1 | tail -1
bun add -d "$tgz" "@sveltejs/adapter-bun@$adapter" @types/bun 2>&1 | tail -1
bunx kitop init >/dev/null
mkdir -p src/routes/where
echo "<p>host is {host.available ? 'the desktop' : 'a website'}</p>" > src/routes/where/+page.svelte
echo "<p>INIT_DESKTOP_PAGE</p>" > src/routes/where/+page.desktop.svelte
quiet node_only npx vite build
grep -q "host is a website" build/where.html || { echo "the static page didn't render:"; ls build; exit 1; }
if grep -rq INIT_DESKTOP_PAGE build; then echo "a .desktop file is in the static site"; exit 1; fi
[ ! -e .desktop/dist ] || { echo "the static site's build packaged a desktop app"; exit 1; }
echo "static site: $(find build -type f | wc -l) files"

rm -rf "$T"
