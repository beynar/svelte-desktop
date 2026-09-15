# Discovery — repository & reference audit

Audit date: 2026-09-15. Repo: `/Users/arnaud/code/svelte-desktop` (not a git repo — no VCS checkpoints).

## Environment (pinned)

| Component | Version | Evidence |
|---|---|---|
| macOS | 26.5.1 (25F80) | `sw_vers` — MEASURED |
| CPU / RAM | Apple M4 Pro, 14 cores, 48 GiB | `sysctl` — MEASURED |
| Bun | 1.4.0 | `bun --version` — MEASURED |
| Rust | 1.94.0 (4a4ef493e 2026-03-02) | `rustc --version` — MEASURED |
| Svelte | 5.57 (gpuix-poc), 5.56.7 (app) | package.json — SOURCE_VERIFIED |
| SvelteKit | 3.0.0-next.0 (app) | package.json — SOURCE_VERIFIED |
| @gpuix/native | 0.7.0 | node_modules — SOURCE_VERIFIED |
| @quickgui/native | 0.1.4-next.1 | node_modules — SOURCE_VERIFIED |
| GPUI (vendored spike) | 0.2 (crates.io) | native/Cargo.toml — SOURCE_VERIFIED |

## Repository structure (actual)

```
svelte-desktop/
  app/            SvelteKit 3-next app; adapter-bun; vite.config.binary.ts → bun --compile
  gpuix-poc/      THE working Svelte→GPUI implementation (see below)
  native/         "sgfx" — minimal vendored-GPUI hello-world crate (gpui 0.2), unbuilt
  shell/          older shell work (not inspected deeply)
  docs/           mdx docs site sources (architecture, comparison, conformance…)
  dist/           built docs site
  .agent/         mission state (STATE/TASKS/JOURNAL)
  spec/           native-api.yaml (this mission)
  crates/native-core/  $native spike — rustc cdylib, 390 KiB dylib
  packages/native/     command registry + codegen → typed bindings.ts
  results/run-20260915-a/  raw measurements (JSONL)
```

## The existing Svelte→GPUI implementation (located, reused)

`gpuix-poc/` — the owner-validated implementation. Architecture, verified by reading
source and running it:

- `src/gdom.ts` (~1900 lines) — fake DOM: Document/Element/Text, attributes→
  custom props, event delegation mirroring browser semantics, `el.animate()`
  WAAPI-lite, rAF. Svelte 5 compiles to DOM calls; gdom services them.
- `src/native.ts` — mutation sink: `emit(op)` → JSON batch →
  `GpuixRenderer.applyBatch()` (NAPI). setTimeout-deferred flush so mutations
  never run inside native event callbacks (GPUI panics on reentrancy — measured
  and worked around, see JOURNAL history).
- `@gpuix/native` — NAPI-RS addon, `GpuixRenderer` (real window) +
  `TestGpuixRenderer` (headless, layout readback, synthetic events).
  Binary: `@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node`.
- `src/kit/` — SvelteKit-parity layer: Shell/runtime, file-router manifest
  (`src/gen/routes/manifest.js` — 17 routes, 2 endpoints, 1 matcher).
- `src/nkit/` — ~45-component svelai-parity library, CVA-style style-prop
  recipes, Theme provider (palette/designTokens/motion/components registry),
  transitions (fso/fade/fly/zoom/slide), WAAPI loops.
- Conformance: `conformance.ts` 45/45, `conformance-nkit.ts` 30/30,
  `conformance-qg.ts` 45/45 (headless quickgui tree), `kit-conformance.ts`.
- `src/bench.ts` — pipeline benchmark with baseline.json regression compare.

## The QuickGUI backend (second renderer, live in-repo)

`@quickgui/native` 0.1.4-next.1 — `bun:ffi` + `dlopen` of
`libquickgui_host.dylib` (darwin-arm64/x64 shipped in `lib/`). 28 FFI symbols:
`run_host`, `create_app`, `create_window`, `set_event_notifier`, `drain_events`,
tree/property mutation, plus service calls.

**Its `src/` ships a large typed service surface** (system.ts ~2000 lines):
Clipboard (text/HTML/image/files/bookmark/custom), Shell.open, SpellChecker,
Notifications (actions/attachments/replies), Menu (roles/submenus/services/
accelerators), GlobalShortcut, Screen, Desktop, Appearance, Keyboard,
PowerMonitor (+PowerAssertion), SystemPreferences, Permissions, Tray/TrayIcon,
CrashReporter, Metrics, AutoStart, Protocol (deep links), SecureStorage,
DeepLink + single-instance, dialogs (open/save/alert), dock (attention/visible/
moveToApplications), window menus, secure keyboard entry, activation policy.
These bind to the same FFI host — spec'd and typed; per-method runtime
verification is the remaining work.

## app/ — the SvelteKit production path

Real SvelteKit 3-next app: file routes, `data.remote.ts` remote functions
(`experimental.remoteFunctions`), `adapter-bun` with `compile: true` →
`build-bin/server` (64.6 MB Mach-O, verified serving HTTP 200 in 55ms without
toolchain). This is the *server-side* packaging story; the desktop binary path
is `bun build --compile` of a gpuix-poc entry (verified working, 82.6 MB).

## Integration points

| Layer | Mechanism | Status |
|---|---|---|
| Svelte → native ops | gdom.ts fake DOM, compiled `.svelte` → DOM calls | WORKING, 45/45 conformance |
| Ops → renderer | JSON batch → NAPI `applyBatch` | WORKING, measured |
| Events ← renderer | NAPI callback → `dispatchPayload` → delegated DOM dispatch | WORKING |
| Kit routes | gen/routes/manifest.js + src/kit runtime | WORKING, kit-conformance green |
| Remote functions | #remote → app server (adapter-bun) | WORKING in app/, packaged binary verified |
| QuickGUI backend | qg-backend.ts sink → FFI protocol | WORKING headless; real window untested this session |
| $native commands | crates/native-core cdylib + packages/native codegen | SPIKE working (add/wordCount/jsonTransform, typed errors) |
| Vendored GPUI | native/ sgfx crate | UNBUILT (was disk-blocked; 29 GiB now free) |

## Missing prerequisites / known gaps

- No git repo → no commit checkpoints; state lives in .agent/.
- Real-window QuickGUI host untested (headless tree only).
- NAPI-RS toolchain for own .node modules untested (FFI chosen for spike).
- macOS-only so far; no cross-compile attempted.
- `bun:ffi` is documented experimental by Bun; NAPI is their recommended stable path.
- App not signed/notarized — unsigned local artifacts only.
