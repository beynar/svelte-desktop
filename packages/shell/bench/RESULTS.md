# Desktop "hello world" benchmark: Electron vs Tauri 2 vs Electrobun vs ours

Measured 2026-10-31 on a MacBook Pro M4 Pro, macOS 26.5.1 (25F80), arm64.
Raw data: `results.json`, full log: `artifacts/bench-run.log`.

The app is the same everywhere: one 800×600 window showing a tiny local page (an `h1` and a
button that increments a counter, see `shared/index.html`). The page sends
`fetch('http://127.0.0.1:47321/ready')` on `window` `load`. Ours renders the same markup as a
SvelteKit page (`ours-minimal/src`), with the same beacon in `app.html`.

## Results

Median of 7 launches. The first launch of each app is thrown away (macOS scans a new binary
on first run, and Electrobun unpacks itself then). MB = 1024² bytes.

| app | .app on disk | installed on disk | zip (ditto) | DMG (tool's own) | cold start → ready, ms median (min–max) | main proc @3 s | helpers @3 s | **total @3 s** median (min–max) | total @10 s | procs |
|---|---|---|---|---|---|---|---|---|---|---|
| Electron 45.2.0 (electron-builder) | 258.1 MB | 258.1 MB | 115.4 MB | 115.1 MB (UDZO) | 303 (288–448) | 39.0 MB | 110.1 MB | 149.1 MB (88.1–205.1) | 88.0 MB | 4 |
| Tauri 2.12 (tauri build) | **4.0 MB** | **4.0 MB** | **1.8 MB** | **1.9 MB** (UDZO) | 313 (276–349) | 30.0 MB | 139.8 MB | 169.8 MB (75.0–190.1) | 95.7 MB | 5 |
| Electrobun 2.0.5 (stable build) | 30.9 MB ¹ | 187.4 MB ¹ | 30.5 MB | 31.0 MB (ULFO) | 396 (306–435) ² | 40.1 MB ³ | 47.1 MB | 86.4 MB (85.2–211.3) | 86.1 MB | 6 |
| **Ours, minimal**, Bun 1.4.4 stable | 85.5 MB | 85.5 MB | 38.8 MB | 29.8 MB (ULMO) | 378 (360–402) | 37.0 MB | 49.8 MB | 86.8 MB (85.5–87.8) | 85.3 MB | 5 |
| **Ours, minimal**, Bun canary `--aot --trim` | 45.0 MB | 45.0 MB | 18.8 MB | 13.5 MB (ULMO) | 334 (323–392) | 35.0 MB | 49.5 MB | **84.7 MB** (84.3–85.2) | 83.3 MB | 5 |
| Ours, **Notes example** (SvelteKit SSR + sqlite + platform API; not a hello world) | 85.8 MB | 85.8 MB | 38.8 MB | 29.8 MB (ULMO) | 367 ⁴ (350–436) | 44.0 MB | 108.0 MB | 152.0 MB (151.8–154.0) | 141.8 MB | 7 ⁵ |

"helpers" means the engine's helper processes plus `com.apple.audio.SandboxHelper`, which is
about 5.4 MB in every WebKit app. "procs" counts every process attributed to the app 3 s
after launch.

¹ Electrobun ships a self-extracting `.app`: a launcher plus a 31.6 MB `tar.zst`. On first
launch it unpacks in place, so the bundle grows to 92.6 MB, and it also keeps a ~95 MB
`self-extraction/*.tar` in `~/Library/Application Support/<id>/stable/`. That gives 187.4 MB on
disk once installed. The DMG holds the compressed self-extractor.
² Electrobun's first launch, which includes the unpacking, took **3884 ms**. The other first
launches were Electron 324, Tauri 294, ours-stable 1166 and ours-aot 349 ms. Notes took
1153 ms, but its first launch here was not a fresh binary.
³ Electrobun's "main" adds up the 1.1 MB native `launcher` and the 38.9 MB `bun` process that
runs the app code.
⁴ Notes can't fetch an arbitrary URL, so its number is the time to the `"type":"ready"` line on
stdout (`SVELTE_DESKTOP_DEBUG=1`), which fires on `DOMContentLoaded`. The minimal app records both
signals, which calibrates the gap: the stdout line comes **47–48 ms earlier** than the `load`
beacon (stable: 330 vs 378 ms; aot: 287 vs 334 ms). On the beacon scale, Notes is about
**415 ms**.
⁵ Notes has 3 WebContent processes: the main window plus two pre-warmed popover web views.

### Per-process breakdown (last run, @3 s, phys_footprint)

| | main | GPU | Networking | renderer / WebContent | other |
|---|---|---|---|---|---|
| Electron | 39.0 | Helper 105.0 (GPU, volatile) | Helper 7.1 | Renderer 17.0 | – |
| Tauri | 30.0 | WebKit.GPU 14.0 | 6.8 | 19.0 | audio 5.3 |
| Electrobun | launcher 1.1 + bun 38.0 | 16.0 | 6.6 | 19.0 | audio 5.3 |
| Ours minimal (stable) | 37.0 | 17.0 | 7.5 | 21.0 | audio 5.3 |
| Ours minimal (aot) | 35.0 | 16.0 | 7.5 | 21.0 | audio 5.2 |
| Ours Notes | 46.0 | 19.0 | 8.7 | 34.0 + 22.0 + 19.0 | audio 5.3 |

## How it was measured

Harness: `bench.ts`. Re-run with `bun bench.ts [keys…]` (keys: `electron tauri electrobun
ours-minimal-stable ours-minimal-aot ours-notes`). `RUNS=n` sets the run count and
`SETTLED_AT_MS=0` turns off the 10 s sample.

- **Launch**: `open -n -W --stdout <log> [--env K=V] -a <App>.app`, identical for every app.
  This goes through LaunchServices, like a double-click. It also makes each app its own macOS
  "responsible process", which is what lets the harness attribute WebKit's XPC helpers: they
  are children of launchd, not of the app. Every time includes the `open`/LaunchServices
  overhead.
- **Cold start**: from just before `open` is spawned to the moment the harness's Bun server
  (127.0.0.1:47321) receives `GET /ready`. For Notes it is the moment the `"type":"ready"` line
  appears in the redirected stdout (polled every 2 ms).
- **Memory**: `footprint -p <pid>` → `phys_footprint` for each attributed process, sampled at 3 s
  and again at 10 s after spawn. A process counts as the app's if its executable is inside the
  `.app`, if it descends from one that is, or if its responsible pid
  (`responsibility_get_pid_responsible_for_pid`, libSystem, via `bun:ffi`) belongs to one. The
  reported number is the median over the 7 runs of each run's total.
- **Sizes**: `du -sk` of the `.app` before any launch, `ditto -c -k --keepParent` for the zip,
  and the DMG produced by each tool. "Installed" is `du -sk` after the runs, plus Electrobun's
  Application Support tarball.
- **Cleanup**: after each run the harness sends SIGTERM, then SIGKILL, to the processes inside
  the bundle and waits until no attributed process is left. It only signals processes it
  attributed to the app under test. The `~/Library/{Application Support,Caches,WebKit,
  Preferences}/…` entries the bench apps created were deleted afterwards.

### Build commands

```sh
# Electron  (bench/electron)
npm install --save-dev electron@45.2.0 electron-builder@26.18.0
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip --arm64   # mac.identity=null (unsigned)

# Tauri 2   (bench/tauri, from `npm create tauri-app@4.7.5 -- tauri --template vanilla --manager npm`)
npm install && npx tauri build --bundles app,dmg
#   template release profile kept: lto=true, opt-level=3, codegen-units=1, panic=abort, strip=true
#   template's greet command + tauri-plugin-opener kept; src/index.html replaced by the shared page

# Electrobun (bench/electrobun, hand-written config equivalent to the hello-world template)
bun install                                   # electrobun@2.0.5 (npm bootstrap for Hutch)
./node_modules/.bin/electrobun build --env=stable

# Ours, minimal (bench/ours-minimal → copied to bench/ours-builds/minimal-{stable,aot})
bun install                                   # postinstall symlinks node_modules/@svelte-desktop/shell → packages/shell
bun ../../scripts/build.ts                    # Bun 1.4.4 stable
bun ../../scripts/build.ts --aot --trim --bun /tmp/bun-canary/bun-darwin-aarch64/bun   # 1.4.4-canary.1+da867c60b

# Benchmark
bun bench.ts
```

### Versions

| | |
|---|---|
| Electron | 45.2.0, electron-builder 26.18.0 |
| Tauri | crate `tauri` 2.12.5, wry 0.57.1, `@tauri-apps/cli` 2.12.4, create-tauri-app 4.7.5, rustc/cargo 1.94.0 |
| Electrobun | npm `electrobun` 2.0.5 → Hutch 0.28.2, Electrobun core 2.0.5, bundled bun 1.4.4 (system WebKit, `bundleCEF: false`) |
| Ours | `@svelte-desktop/shell` (working tree, 2026-10-31), @sveltejs/kit 3.1.1, adapter-bun 1.0.0-next.2, svelte 5.57.3, vite 8.3.5; Bun 1.4.4+38afee6c8 (stable) and 1.4.4-canary.1+da867c60b (aot) |
| Harness | bun 1.4.4, node 26.13.0 / npm 11.20.0, Xcode 26.5 |

## Caveats

1. **Memory at 3 s is bimodal for Electron, Tauri and Electrobun.** The GPU process (WebKit.GPU,
   or Electron's GPU helper) either sits at 13–19 MB or still holds 90–140 MB of graphics memory
   that hasn't yet been marked purgeable (`footprint` shows it under "Owned physical footprint
   (graphics)"; peak 137 MB). At 3 s some runs land on each side, which explains the ranges
   such as Tauri 75–190. By 10 s most runs have settled, but not all: Tauri had one run at
   196.8 MB at 10 s. Ours landed on the low side in all 14 minimal-app runs. I can't tell from
   this data whether that is luck of timing or the alpha-0-until-DOMContentLoaded window.
   Compare the low modes too, roughly Electron 88, Tauri 75, Electrobun 85, ours 84–87 MB.
   Those are all within ~12 MB of each other.
2. **Notes is not a hello world.** It runs SvelteKit SSR, sqlite, the platform API, a menu and
   two pre-warmed popover web views, which accounts for its extra ~55–65 MB and 2 processes.
   It is labelled separately; the "ours, minimal" rows are the like-for-like comparison.
3. **The Notes bundle changed during this task.** Another session was rebuilding
   `examples/notes` while I worked. The `Notes.app` that was there at the start was a canary
   `--aot --trim` build (47.5 MB executable). By measurement time it had been replaced with a
   stable Bun 1.4.4 build (85.6 MB). I snapshotted that stable build with `ditto` into
   `bench/ours-notes-snapshot/` and measured the copy. It shares its data directory
   (`dev.svelte-desktop.notes`) with the real Notes, so the benchmark launches opened that
   sqlite database.
4. **The cold-start signal differs for Notes only** (see ⁴). Ours shows the window only at
   `DOMContentLoaded`. The other three show their window earlier, often still blank, so
   "window visible" would favour them. This bench measures "page loaded" for everyone.
5. **DMG formats differ**: Electron and Tauri use UDZO (zlib), Electrobun ULFO (lzfse), ours
   ULMO (lzma). The `ditto` zip column is the apples-to-apples download size.
6. **Nothing is signed or notarized.** Electron and ours are ad-hoc signed; the others use their
   default signing behaviour without an identity. Downloaded, quarantined apps would pay a
   Gatekeeper check on first launch, which isn't measured here. Electron is not trimmed
   (`electronLanguages` would remove most of the ~40 MB of locales).
7. **The machine was not idle.** Other agent sessions were building and testing concurrently.
   The 1-minute load average ranged from 3.7 to 8.4 across app blocks (see `loadAvg` in
   `results.json`). Time spreads of ~50–150 ms are noise of that kind. The four frameworks are
   within ~100 ms of each other, so read the differences as small.
8. **Electrobun toolchain**: the npm package is only a bootstrap. On first use it downloaded
   Hutch 0.28.2, cottontail, Electrobun core 2.0.5 and a bun 1.4.4 toolchain into `~/.hutch`
   (451 MB, shared machine-wide; a pre-existing 2.0.2-beta.22 release was already there). That
   is outside `bench/` and can't be avoided with Electrobun 2.x. The build itself succeeded with
   no failures. It warned that the icon was missing, and skipped the delta patch because no
   `release.baseUrl` is set. To re-measure Electrobun's shipped size, rebuild it first
   (`rm -rf build artifacts && electrobun build --env=stable`) and delete
   `~/Library/Application Support/dev.bench.hello.electrobun`. The first launch rewrites the
   bundle in place.
9. **Environment gotcha**: the host environment sets `ELECTRON_RUN_AS_NODE=1`, which turns the
   Electron binary into plain Node. The harness removes it before launching.
