#!/bin/sh
# The package as a consumer gets it: pack it, install the tarball, `kitop create` from that install,
# install the tarball in the new project, then doctor, types, build, the built app, `vite dev`.
# The examples link the shell, so they prove none of this: linked sources are not treated like a
# package in node_modules, and they bring files the tarball may not have.
# All of it outside the checkout, so nothing can resolve through the repo.
# From the host: test/docker/run.sh pack (also the end of run.sh e2e)
set -e
src=/src/packages/shell
[ -n "$DBUS_SESSION_BUS_ADDRESS" ] || SESSION_SH=$src/test/docker/session.sh . "$src/test/docker/session.sh"

T=$(mktemp -d)
mkdir "$T/shell"
(cd "$src" && tar -cf - --exclude=node_modules --exclude=native/build --exclude=test/docker/results .) | tar -xf - -C "$T/shell"
step() { echo "── $1"; }

step "bun pm pack"
(cd "$T/shell" && bun pm pack --destination "$T" --quiet >/dev/null && bun scripts/check-package.ts)
version=$(bun -p "require('$T/shell/package.json').version")
tgz=$T/kitop-shell-$version.tgz

# No credentials in the image and --dry-run uploads nothing; the token only gets it past the login
# check. This is `private` doing its job, then the one line between the package and a release.
step "publishing: refused while private, ready without that line"
cd "$T/shell"
out=$(NPM_CONFIG_TOKEN=unused bun publish --dry-run 2>&1) && { echo "bun publish accepted a private package"; exit 1; }
case "$out" in *private*) ;; *) echo "bun publish refused for another reason: $out"; exit 1 ;; esac
sed -i '/"private": true,/d' package.json
out=$(NPM_CONFIG_TOKEN=unused bun publish --dry-run 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -2
cd "$T"
rm -rf "$T/shell"

step "kitop create, from the installed tarball"
mkdir "$T/cli"
cd "$T/cli"
echo '{ "name": "cli", "private": true }' > package.json
bun add "$tgz" >/dev/null 2>&1
bunx kitop create "$T/hello"
cd "$T/hello"
grep -q "\"@kitop/shell\": \"$version\"" package.json || { echo "create did not pin @kitop/shell to $version:"; cat package.json; exit 1; }

step "bun install (the tarball in place of the version it pinned)"
sed -i "s|\"@kitop/shell\": \"$version\"|\"@kitop/shell\": \"file:$tgz\"|" package.json
cp -R "$src/test/docker/pack-app/." .
bun install 2>&1 | tail -1
[ -d node_modules/@kitop/shell ] && [ ! -L node_modules/@kitop/shell ] || { echo "@kitop/shell is not installed as a package"; exit 1; }
[ ! -e node_modules/@kitop/shell/native/build ] || { echo "the tarball ships native/build"; exit 1; }

step "kitop doctor"
bunx kitop doctor

# Sources in node_modules are checked under the app's config, and skipLibCheck doesn't cover them:
# any error here lands on every consumer. Through every entry point, not just what the sample uses.
step "types, through every export"
bun -e "
  const { exports } = await Bun.file('node_modules/@kitop/shell/package.json').json();
  const entries = Object.keys(exports).filter((k) => k !== './package.json' && !k.endsWith('.js'));
  await Bun.write('src/all-exports.ts', entries.map((k) => 'import \'@kitop/shell' + k.slice(1) + '\';').join('\n') + '\n');
"
bunx tsc --noEmit
rm src/all-exports.ts

step "vite build (libshell compiled from the installed sources)"
bunx --bun vite build 2>&1 | grep -E " error|✓ /" | tail -1
[ -f node_modules/@kitop/shell/native/build/linux-*/libshell.so ] || { echo "libshell was not built from the installed package"; exit 1; }

step "the built app"
bun test --timeout 60000 tests/

step "vite dev"
DESKTOP_TEST_DEV=1 bun test --timeout 180000 tests/

step "a website too: desktop({ adapter })"
rm -rf .desktop build site
sed -i "s/desktop({/desktop({ adapter: { name: 'pack-test', adapt: (b) => { b.writeClient('site\/client'); b.writeServer('site\/server'); } },/" vite.config.ts
grep -q pack-test vite.config.ts
mkdir -p src/routes/where
cat > src/routes/where/+page.svelte <<'PAGE'
<p>host is {host.available ? 'the desktop' : 'a website'}</p>
PAGE
bunx kitop build 2>&1 | grep -vE "gzip|^\s*$" | tail -3 | cut -c1-120
[ -d site/server ] || { echo "the project's adapter didn't build the website"; exit 1; }
[ ! -e .desktop/dist ] || { echo "the website's build packaged a desktop app"; exit 1; }
bunx kitop dev --port 4188 --strictPort >dev.log 2>&1 &
dev=$!
for i in $(seq 1 40); do curl -sf http://localhost:4188/where -o where.html && break; sleep 1; done
kill "$dev" 2>/dev/null || true
grep -q "a website" where.html 2>/dev/null || { echo "the website's page didn't render:"; cat where.html dev.log; exit 1; }
if bunx kitop dev --mac 2>/dev/null; then echo "kitop dev --mac ran on Linux"; exit 1; fi
bunx kitop build --linux 2>&1 | grep -E " error|✓ /" | tail -1
ls .desktop/dist/*.tar.gz >/dev/null

rm -rf "$T"
