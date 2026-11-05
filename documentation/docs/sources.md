# Sources — retrieval log

Retrieved/inspected 2026-09-15. Local pinned versions take precedence over URLs.

## Local primary sources (inspected in node_modules / repo)

| Source | Version/commit | Where inspected |
|---|---|---|
| @gpuix/native | 0.7.0 (npm) | `gpuix-poc/node_modules/@gpuix/native/` — index.js (NAPI-RS loader), index.d.ts (GpuixRenderer/TestGpuixRenderer API), package.json (`napi.binaryName: gpuix-native`, targets: darwin-arm64, linux-x64, win-x64). Binary: `@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node`. Repo: github.com/remorses/gpuix. License: Apache-2.0. |
| @quickgui/native | 0.1.4-next.1 (npm) | `gpuix-poc/node_modules/@quickgui/native/src/` — ffi.ts (dlopen, 28 symbols, event notifier/drain callbacks), runtime.ts (`quickgui_run_host`), system.ts (full service surface), tray.ts, dialog.ts, integrations.ts (AutoStart/SecureStorage/CrashReporter/Metrics), single-instance.ts (DeepLink), binding.ts/binding-types.ts, protocol.ts. Libs: `lib/darwin-{arm64,x64}/libquickgui_host.dylib`. Repo: github.com/egoist/quickgui. |
| svelte | 5.57.0 | gpuix-poc/node_modules — runes, transitions contract, `untrack` |
| @sveltejs/kit | 3.0.0-next.0 | app/node_modules — remote functions (experimental) |
| @sveltejs/adapter-bun | 1.0.0-next.2 | app/ — `compile: true` buildOptions |
| gpui (vendored) | 0.2 (crates.io) | native/Cargo.toml — sgfx scaffold |

## Brief-provided seeds (recorded, not re-fetched this session)

- Q1–Q4 quickgui.dev + github.com/egoist/quickgui — docs claims treated as
  inspection targets; local package source above is the authoritative artifact.
- B1–B7 bun.com docs — contributing (Rust-based build), node-api, ffi
  (experimental warning), sqlite (sync), secrets (experimental), executables,
  napi.rs getting-started.
- E1–E7 electronjs.org api — app, base-window, clipboard, menu,
  system-preferences, safe-storage, desktop-capturer (inventory reference only).
- T1–T3 v2.tauri.app — plugin system, capabilities model, updater.
- R1–R2 reactnative.dev architecture — JSI/Fabric/TurboModules as design
  reference only.
- S1 svelte.dev/docs/kit. W1 wasmtime security. W2 zed-industries/embedded_gpui.
  M1 itsbalamurali/gpui-mobile.

## External fetches this session

None required — every audited artifact was present locally. Published QuickGUI
benchmark numbers were NOT re-measured against their fixture; our numbers are
our own (see results/run-20260915-a/).
