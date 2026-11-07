# AGENTS.md: the GPUI project

An earlier project, kept for reference, in `experiments/gpui`: it isn't kitop, and kitop uses none of it. Paths below are relative to this folder, which has its own `package.json`, workspaces and `bun.lock`. Its documentation stays at the repository root, in `documentation` (`bun run dev` here serves it). `.agent` here is its work log. `results/` is what its probes write, and isn't kept in git.

## The GPUI project

SvelteKit-shaped app rendered natively through GPUI (Zed's renderer). Bun
hosts JS; compiled Svelte drives a fake-DOM bridge (`gdom`) whose mutations
become an imperative op stream consumed by a Rust renderer via NAPI-RS. No
Chromium, no webview, no DOM.

## Monorepo layout (bun workspaces)

```
packages/
  gpuix/        @svelte-desktop/gpuix — renderer + runtime
    native/     Rust crate → libsgfx.dylib (GPUI, AppKit, platform services)
      src/platform*/   brokered platform ops (window/menu/tray/events/…)
      patches/         gpui-fork.patch — our diffs against the pinned zed fork
    src/        gdom.ts (fake DOM), native.ts (op stream/sink emit),
                nkit/ (native component kit, .svelte), native-css/ (parse+register)
    scripts/    package-app.ts (.app bundler)
    gen/        emitted: nkit components
  platform/     @svelte-desktop/platform — the platform API product
    src/        index.ts (namespaces: app, windows, screen, clipboard, shell,
                dialog, theme, system, power, secureStorage, notifications,
                deepLink, menu, tray, shortcuts, capture, diagnostics,
                capabilities, updater), bus.ts (transport + bus internals),
                sibling modules store.ts, windowState.ts, stores.svelte.ts,
                dpi.ts, native-api.test.ts
    spec/       native-api.yaml — wire contract
    gen/        emitted: stores.js (compiled rune module)
  svelte/       @svelte-desktop/svelte — SvelteKit-shaped runtime
    kit/        router, loads, actions, remote fns (runtime.svelte.js, Shell.svelte, index.js)
    app-compat/ the $app/server shim
    params/     route param matcher (hex.ts)
    build.ts    monorepo compile orchestrator: every package's src → its gen/
    build-app.ts    app-targeted sibling: app/src → app/gen-app
    remote.svelte.js, svelte-client.js (svelte client-entry shim)
    gen/        emitted: kit/, remote.js
  vite/         @svelte-desktop/vite — vite plugin + adapter + dev CLI:
                configureServer boots the native window on `vite dev`,
                `vite build` emits .svelte-native/app.js; runtime/ holds the
                $app/* shims, test/fixtures the e2e app
  tests/        @svelte-desktop/tests — all harness content (private)
    cases/ routes/ dashboard/ shadcn/ bench/ patches/ (quickgui patch)
    conformance*.ts, kit-conformance.ts, smoke-pages.ts,
    mission-*.ts, probe-*.ts, qg-backend.ts (JS backend + stylesheet mirror),
    hooks.ts, server.ts, kit-app.ts (test fixtures)
    gen/        emitted: cases, routes+manifest, dashboard, shadcn, vendor
experiments/    abandoned spikes — shell/ (Electrobun), native-core/ (bun:ffi),
                native-codegen/. Not part of the workspace build.
app/            live SvelteKit demo — vite.config.ts loads svelteNative()
                → `vite dev` boots the native GPUI window (module-runner
                hmr — in-place updates, no restart); generated output
                lives in .svelte-native/ (app.js + dev.json)
documentation/    blume docs project — blume.config.ts + mdx/mdx content
                (architecture, platform-api.mdx, api-plan.mdx, roadmap);
                .blume/ + dist/ generate here
.agent/         STATE.md + JOURNAL.md — running work log (update when you
                land something notable)
results/        probe evidence dirs (run-*)
```

## Commands

```sh
bun install                       # workspace install (isolated linker)
bun run gen                       # all packages' src → gen/ (packages/svelte/build.ts)
bun run test                      # 84 platform tests + all conformance suites
bun run test:unit                 # standalone bun:test files (packages/tests/*.test.ts + packages/platform + packages/gpuix globs)
bun run demo                      # gen + native showcase window
cd app && bun run dev             # native app loop — vite dev + plugin → GPUI window
cd app && bun run build           # vite build + bun --compile → dist/SvelteNotes.app (runnable)
bun packages/tests/mission-platform.ts   # live platform-API probe
cd packages/gpuix/native && cargo build --release   # Rust rebuild
bun build --compile packages/tests/mission-startup.ts --outfile /tmp/bin  # 110MB binary; opens the window, mounts, exits
```

**`bun run dev` at the root starts the docs server** (`blume dev`), not the
native app loop. The native app is `cd app && bun run dev` (vite dev +
svelteNative plugin → native window).

Editing the vendored gpui checkout does **not** trigger rebuilds — cargo
treats git checkouts as immutable and `cargo clean -p` removes 0 files for
them. Force the rebuild by deleting artifacts first:

```sh
rm -rf packages/gpuix/native/target/release/deps/*gpui_macos* \
  packages/gpuix/native/target/release/.fingerprint/gpui_macos-*
cargo build --release --manifest-path packages/gpuix/native/Cargo.toml
```

After `cargo build --release` **and** after `bun install`, redeploy the
binding — `bun install` restores the published package:

```sh
cp packages/gpuix/native/target/release/libsgfx.dylib \
  node_modules/.bun/@gpuix+native@0.8.0/node_modules/@gpuix/native/gpuix-native.darwin-arm64.node
```

All workspace `@gpuix/native` symlinks resolve to that one file (also keep
the `sgfx.darwin-arm64.node` sibling name and the copy in
`packages/vite/test/fixtures/app/node_modules/@gpuix/native/`).

**`cp` invalidates the Mach-O signature at fault time** — a copied `.node`
verifies statically but the kernel rejects its pages on load:
`SIGKILL (Code Signature Invalid)` / `EXC_BAD_ACCESS Invalid Page`. Re-sign
ad-hoc after every `cp` deploy:

```sh
codesign --force --deep --sign - node_modules/.bun/@gpuix+native@0.8.0/node_modules/@gpuix/native/*.node \
  packages/vite/test/fixtures/app/node_modules/@gpuix/native/*.node
```

## Import model — read before touching imports

- **Cross-package source imports use package specifiers**, never deep
  relatives: `@svelte-desktop/gpuix/gdom`, `@svelte-desktop/platform/windowState`,
  `@svelte-desktop/svelte/build.ts`. Exports maps are `./*` → `./src/*` (gpuix,
  platform) or `./*` → `./*` (svelte); Bun probes `.ts` on targets — emit
  extensionless or exact-`.ts` specifiers, never `.js` for a `.ts` file.
- **`#kit` / `#remote` / `#stores`** are package `imports` — each consuming
  package's package.json maps them (svelte → own `gen/`, tests/app →
  `@svelte-desktop/svelte/gen/*`). `#kit` = compiled kit runtime, `#remote` =
  compiled remote module, `#stores` = `@svelte-desktop/platform/stores`.
- **`svelte-desktop/stores`** resolves via root tsconfig `paths` →
  `packages/platform/gen/stores.js` (Bun honors paths at runtime).
- **`gen/` trees are generated** — never hand-edit; fix the source and run
  `bun run gen`. Generated code imports the svelte client entry through
  `@svelte-desktop/svelte/svelte-client.js` and registers stylesheets via
  `@svelte-desktop/gpuix/native-css/register`.
- **Isolated linker**: root `node_modules` is sparse. Anything needing
  `node_modules/<pkg>` must resolve through the owning package's own
  `node_modules` (see `svelte-client.js` — `'./node_modules/svelte/…'`).
- gpuix ↔ svelte have a **circular workspace dep** — intentional (nkit
  components compile against the svelte shim; the runtime renders via gpuix).

## Conventions

- **Bun only** — `bun <file>`, `bun test`, `bun build`, `Bun.file`,
  `bun:sqlite`. No node/npm scripts. `vite` is the sanctioned toolchain for
  the app dev loop and `@svelte-desktop/vite` — it runs under Bun.
  (See CLAUDE.md for the full list.)
- **Platform ops never fake success** — unsupported/unavailable returns typed
  `{ok:false, error:{code}}` (`unsupported`, `unavailable`, `invalid_args`).
  No panics across the NAPI boundary; validate args at `platform.rs`
  accessors (`f64_arg`, `opt_f64`, …).
- Async native ops use the **pending lane** (`Outcome::Pending` +
  `platformResult` request ids). Anything that pumps a nested runloop
  (menu.popup, dialogs) must go pending, never run inside the AppCell borrow.
- gpui fork diffs live in `packages/gpuix/native/patches/gpui-fork.patch` —
  re-export after editing the vendored checkout
  (`~/.cargo/git/checkouts/zed-*/crates/gpui*`).
- Error/unsupported behavior in the JS sink (`qg-backend.ts`) mirrors the
  Rust renderer — when you add an op to the Rust side, check whether the JS
  backend needs the same case (it owns `stylesheet.register`/`setClass`).

## Verification targets (current green)

platform tests **84/84** · svelte **51/51** · nkit **30/30** · kit **49/49** ·
quickgui headless **45/45** · pages **25/25** · bun:test **243/243**
(filedrop, theme-event, style-spread, style-adversarial, qg-stylesheet,
delegated-events, move-ops + platform) ·
cargo --lib **314/314** ·
multi-window probe **pass** (create→mount→paint→close→clean exit) ·
titlebar no-drag probe **manual only** (`bun packages/tests/probe-titlebar-nodrag.ts` —
posts real CGEvents via `packages/tests/bin/cge.swift`, needs macOS
Accessibility/TCC permission and a focused window) ·
live probe **130/133** (0 fails, 3 modal skips: dialogs, Touch ID, menu.popup)
