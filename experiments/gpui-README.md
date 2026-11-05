# kitop

Feasibility project: **a SvelteKit-shaped app — Svelte 5, remote functions,
`bun:sqlite` — rendered as a real native macOS window through GPUI** (the Zed
renderer). No Chromium, no webview, no DOM: compiled Svelte drives a fake-DOM
bridge (`gdom`) whose mutations map onto an imperative op stream consumed by a
Rust/GPUI renderer embedded via NAPI-RS.

## Monorepo layout

```
packages/
  gpuix/            the GPUix fork — renderer + runtime
    native/         Rust crate (GPUI, AppKit, platform services) → libsgfx.dylib
    src/            gdom.ts (fake DOM bridge), native.ts (op stream/sink),
                    nkit/ (native component kit), native-css/ (stylesheet pipeline)
  platform/         the platform API product
    src/            index.ts (namespaces: app, windows, screen, clipboard, shell,
                    dialog, theme, system, power, secureStorage, notifications,
                    deepLink, menu, tray, shortcuts, capture, diagnostics,
                    capabilities, updater) + bus.ts (transport) and sibling
                    modules store.ts, windowState.ts, stores.svelte.ts, dpi.ts
    spec/           native-api.yaml — the wire contract
  svelte/           everything Svelte/SvelteKit
    kit/            the kit-shaped runtime (router, loads, actions, remote fns)
    app-compat/     the $app/server shim
    params/         route param matcher (hex)
    build.ts        the monorepo compile orchestrator (src → gen per package)
    build-app.ts    the app-targeted sibling (app/src → app/gen-app)
  vite/             the vite plugin + adapter (`@kitop/vite`) — vite dev
                    boots the native window, vite build emits the bundle
  tests/            conformance + mission probes + showcase
    cases/          svelte conformance cases
    routes/         kit conformance fixture routes
    dashboard/      showcase app (nkit + shadcn + streamdown)
    conformance*.ts, kit-conformance.ts, mission-*.ts, probe-*.ts
experiments/        abandoned spikes, kept for reference
  shell/            Electrobun 2 shell (Chromium-free webview route)
  native-core/      C ABI / bun:ffi renderer spike
  native-codegen/   generated-bindings spike
app/                the live SvelteKit demo — runs on the native renderer
                    (two boot paths: vite plugin + direct gen-app — see app/NATIVE.md)
documentation/        architecture, platform-api, api-plan, roadmap, notes
.agent/             STATE.md + JOURNAL.md — working log
results/            probe evidence (platform.jsonl etc.)
```

## Commands

```sh
bun install            # workspace install (bun isolated linker)
bun run gen            # compile all packages' src → their gen/ trees
bun run test           # platform tests + all conformance suites
bun run demo           # gen + native showcase window (packages/tests)
cd app && bun run dev  # native app loop — vite dev + svelteNative plugin → GPUI window
bun packages/tests/mission-platform.ts   # live platform-API probe (130+ ops)
cd packages/gpuix/native && cargo build --release   # rebuild libsgfx.dylib
```

The deployed `.node` binding lives at
`node_modules/.bun/@gpuix+native@0.8.0/.../gpuix-native.darwin-arm64.node`
(copy `libsgfx.dylib` there after a Rust rebuild — all workspace symlinks
resolve to it).

## Verified

| Suite | Result |
|---|---|
| platform API (`native-api.test.ts`) | 75/75 |
| svelte conformance | 45/45 |
| nkit conformance | 30/30 |
| kit conformance | 49/49 |
| quickgui headless backend | 45/45 |
| showcase pages | 25/25 |
| live platform probe | 130/133 ok, 0 fails, 3 modal skips |
| `bun build --compile packages/tests/mission-startup.ts` | 110 MB single binary — opens the window, mounts the showcase, ticks frames, exits |

## The shape of it

- Svelte compiles to DOM calls; `gdom` is a fake-DOM bridge (not a VDOM) —
  every mutation becomes a `createElement`/`setStyle`/`setText`/`setClass`/
  `setEventListener`/`moveBefore` op streamed to the native sink. Svelte's
  delegated event types ship once as `setDelegatedEvents` — the renderer
  attaches them at build, no per-element listener ops.
- Component `<style>` blocks compile through Lightning CSS → `stylesheet.register`
  ops → the Rust `StyleSheetRegistry` resolves selectors (compounds,
  descendant/child/sibling combinators, attribute selectors, `:not(compound)`),
  cascade and pseudo-state buckets natively.
- The kit runtime (`packages/svelte/kit`) implements routing, layouts, load,
  server load, actions, remote functions (`query`/`command`/`form`/`prerender`),
  invalidation, navigation, errors, endpoints and streaming — in-process.
- The platform API is brokered: TS → `callPlatform(service, op, args)` → Rust
  routes by service, async ops resolve through a pending-request lane, native
  events stream back as `platformResult`/events. Unsupported ops return typed
  `unsupported`/`unavailable` errors — never fake success.
- A second backend (`packages/tests/qg-backend.ts`) interprets the same op
  stream through `@quickgui/native` for headless conformance runs.

See `documentation/` for the deep dives — `documentation/platform-api.mdx` (JS surface),
`documentation/api-plan.mdx` (phase plan), `packages/platform/spec/native-api.yaml`
(wire contract), `.agent/STATE.md` (current status). Agent-facing map +
conventions live in `AGENTS.md`.
