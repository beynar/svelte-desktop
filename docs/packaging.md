# Packaging — measured results

## Two artifacts, both verified running (2026-09-15)

### 1. SvelteKit server binary — `app/build-bin/server`
- Built via `vite.config.binary.ts` → `@sveltejs/adapter-bun` `compile: true`.
- 64.6 MB Mach-O arm64. Runs with no toolchain: served `GET /` → 200 in 55 ms.
- Contains remote functions + routes; `paths.origin` baked to
  `http://localhost:42777` (CSRF origin check requires it — documented quirk).
- Status: **works unsigned**. Notarized/signed: NOT_RUN (no credentials).

### 2. Desktop app single binary — `bun build --compile src/mission-startup.ts`
- 82.6 MB Mach-O arm64, embeds the `gpuix-native.darwin-arm64.node` addon
  (Bun extracts embedded `.node` to a temp dir at first load).
- Measured on this machine (M4 Pro):
  - `napi-loaded`: 428 ms (vs 12 ms unpacked — one-time extraction cost)
  - first frame: ~940 ms total (vs ~450 ms unpacked)
  - steady RSS: ~174 MiB; frame p90 5.5 ms; event-driven idle.
- Status: **works unsigned**, real window, real Svelte tree.
- Open questions for a `.app` bundle: `Info.plist` (bundle id → notifications,
  deep links, file associations), `Frameworks/` dylib layout (QuickGUI already
  looks there), iconset, signing+hardened runtime, notarization stapling —
  all untested without credentials.

## What ships inside the binary

- Bun runtime (the bulk of the 82.6 MB), compiled JS bundle (210 modules),
  embedded `.node`. OS-provided deps only: AppKit/Metal (system frameworks).
- SBOM: `bun.lock` is the dependency inventory; generate via `bun pm` tooling —
  TODO for release pipeline.

## Known constraints

- `--compile` embeds files imported via `type: "file"`/known loaders; NAPI-RS's
  runtime `require()` of the platform package resolved correctly (verified by
  the window actually opening).
- Re-running extraction every launch costs ~400 ms — a `.app` layout keeping
  the `.node` in `Contents/Frameworks` (or resources) would remove it; the
  loader's search path would need a small patch (documented approach: set
  `process.env` override or patch the NAPI-RS loader's candidate list).
- No cross-compile attempted: `bun build --compile --target` exists for
  linux-x64/win-x64 but `@gpuix/native` ships those targets too; NOT_RUN.
