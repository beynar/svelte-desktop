# STATE — svelte-desktop mission

## Mission
Validate Svelte + Bun + GPUI + native Rust as a desktop framework. Decide Bun
integration architecture, define V1 native API contract, report what is
production-ready. Fixed: Svelte+TS authoring, Bun runtime, GPUI renderer, no
Chromium/WebView.

## Environment (pinned 2026-09-15)
- macOS 26.5.1 (25F80), Apple M4 Pro, 14 cores, 48 GiB RAM, arm64
- Bun 1.4.0, Rust 1.94.0, cargo 1.94.0
- Disk: 29 GiB free (vendor-GPUI build previously blocked at 1.7 GiB — now possible)
- Repo: /Users/arnaud/code/svelte-desktop — NOT a git repository (no checkpoints possible)
- gpuix-poc: svelte 5.57, @gpuix/native 0.7.0 (NAPI), @quickgui/native 0.1.4-next.1 (bun:ffi)
- app/: SvelteKit 3.0-next app, adapter-bun 1.0.0-next.2, vite 8.1.5

## Key architecture facts (verified this session)
- @gpuix/native = NAPI-RS addon (`@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node`)
  → Bun host + in-process Rust renderer = mission architecture B, already working.
- @quickgui/native = `bun:ffi` + `dlopen` of `libquickgui_host.dylib`, events via
  `quickgui_set_event_notifier`/`drain_events` callbacks = FFI transport, also live.
- gpuix-poc/src/gdom.ts = fake DOM; svelte compiles to DOM ops → op-stream → NAPI batch.
- native/ = vendored GPUI cargo scaffold (unbuilt; was disk-blocked).
- app/vite.config.binary.ts = bun build --compile single-binary SvelteKit build.

## Prior session results (all green)
- nkit conformance 30/30, svelte conformance 45/45, qg 45/45, showcase 25/25 pages
- nkit: ~45 components, Theme system, motion/transitions, CVA-style recipes
- Overlay system on real native anchored/mouseDownOutside path

## Running processes
- none owned by this session

## Next action
docs/discovery.md + sources.md audit, then spec/native-api.yaml, then
bridge/startup/memory benchmarks, packaging experiment, docs/recommendation.md
