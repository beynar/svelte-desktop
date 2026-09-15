# svelte-desktop

Feasibility spike: a **SvelteKit 3 (RC) app with remote functions, SSR and `bun:sqlite`,
running inside an Electrobun 2 (beta) shell as a single macOS `.app`** — no Electron,
no Chromium, no separate server process.

## Layout

- `app/` — SvelteKit 3 RC app (`@sveltejs/kit@next`), `@sveltejs/adapter-bun`,
  remote functions enabled in `vite.config.ts`. `src/lib/data.remote.ts` demos
  `query` + `command` + `form` against `bun:sqlite`, plus a native-dialog
  `command` routed through `globalThis.__nativeBridge`.
- `shell/` — Electrobun 2.0.2-beta app. `mainProcess: "bun"`, so the SvelteKit
  server runs **in-process** in the same Bun runtime that owns the window.
  `src/bun/index.ts` is the whole trick (see below). `kit/` is a staged copy of
  `app/build` (mapped into `Resources/app/kit/` via `build.copy`).

## The trick (`shell/src/bun/index.ts`)

1. `Bun.serve` is monkey-patched **before** importing `app/build/index.js`:
   - forces `PORT=0` → the server binds an **ephemeral port**; `server.url` is
     captured and handed to `BrowserWindow`. No fixed port, no `paths.origin`.
   - injects `x-forwarded-proto: http` + `PROTOCOL_HEADER` env so adapter-bun
     computes `self_origin` as `http://…` — otherwise remote-function
     **mutations are CSRF-rejected** (adapter-bun assumes TLS upstream, like
     adapter-node).
2. `globalThis.__nativeBridge` is populated with Electrobun APIs
   (`Utils.showMessageBox`, `Utils.quit`). Remote functions call it — remote
   functions *are* the native bridge (the `window.__TAURI__` pattern, server-side).
3. `await import(Resources/app/kit/index.js)` starts the SvelteKit server in-process.

## Build / run

```sh
# kit
cd app && bun run --bun build          # adapter-bun calls Bun.build — needs --bun
rm -rf ../shell/kit && cp -R build ../shell/kit

# shell (needs hutch canary channel for beta templates)
cd ../shell
HUTCH_ACTIVE_CHANNEL=canary hutch electrobun dev          # dev bundle + launch
HUTCH_ACTIVE_CHANNEL=canary hutch electrobun build --env=stable  # .app + .dmg in build/ + artifacts/
```

## Verified in the stable .app

SSR ✓ client routing ✓ `query` ✓ `command` ✓ `form` (binary wire format) ✓
`bun:sqlite` persistence across launches ✓ `Utils.showMessageBox` from a
`command` ✓ ephemeral port per launch ✓

## Sizes

- stable `.app`: **21 MB** self-extracting (launcher + zstd payload), 20 MB `.dmg`
- dev `.app`: 68 MB unpacked (bundles `bun` binary in `Contents/MacOS`)
- `app/vite.config.binary.ts` also produces a single `build-bin/server`
  **62 MB Mach-O executable** (server+assets+runtime) via `buildOptions.compile`
- for reference, Electron hello-world is ~85 MB compressed / ~200 MB unpacked

## Known limitations / next questions

- **Cookie/localStorage persistence**: ephemeral port = new origin each launch →
  web storage doesn't survive restarts. Desktop state should live in
  `bun:sqlite`/files anyway; if web storage matters, pin a port + `paths.origin`.
- `compile`-mode binaries pin `paths.origin` at build → fixed port.
- No `icon.iconset` yet; signing/notarization config needed for real distribution.
- Fire-and-forget view→main RPC (outside remote functions) would need Electrobun's
  socket client — `electrobun` npm package is a stub in 2.x; vendor
  `api/browser/` from the devkit if needed. Remote functions cover request/response.
- HMR dev loop: point `BrowserWindow` at `bun run --bun dev` (Vite) instead of the
  built server — standard Electrobun+Vite pattern, not wired here.
