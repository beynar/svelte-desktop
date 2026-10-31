# Gap audit: svelte-desktop shell vs Electron, Tauri, Electrobun and gpuix-svelte

Measured on macOS 26.5, arm64 (M4 Pro), 2026-10-31. "Before" is the state when
this audit started; **now** is the current state. Each ✅ in the "now" column is
backed by an automated test or a recorded run (see the Evidence column).

Legend: ✅ have · 🟡 partial · ❌ missing · — not applicable

## 1. Developer experience

| Capability | Electron | Tauri 2 | Electrobun | gpuix-svelte | before | **now** | Evidence |
|---|---|---|---|---|---|---|---|
| One-step setup | ✅ | ✅ | ✅ | ✅ | 🟡 adapter + build script | ✅ one Vite plugin + `desktop.config.ts`; `svelte-desktop init` / `doctor` | `init` on a fresh SvelteKit project: built and smoke-tested |
| Dev mode, HMR in the real window | ✅ | ✅ | 🟡 rebuild | ✅ | ❌ | ✅ `vite dev` opens the native window on Vite | HMR probe: hot update, same JS context |
| Native/server API in dev | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ RPC bridge Vite ↔ dev shell | `bun run test:dev` 8/8 |
| Unmodified SSR framework | 🟡 | ❌ SPA | 🟡 SPA | ❌ | ✅ | ✅ | — |
| Typed native API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 245 ops, 22 services, stores | `test/run-platform.sh` |
| E2E testing of the real app | 🟡 Playwright | 🟡 WebDriver | ❌ | ✅ | 🟡 bespoke script | ✅ `@svelte-desktop/shell/test` (built or dev) | `bun run test`, 8/8 |
| DevTools | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ on in dev; `debug` / `setInspectable` in prod | — |

## 2. Native extensibility

| | Electron | Tauri | Electrobun | gpuix-svelte | before | **now** | Evidence |
|---|---|---|---|---|---|---|---|
| App-defined native commands on the UI thread | 🟡 addons | ✅ commands | 🟡 | ❌ | ❌ | ✅ `native/*.swift`, `.m`, `.c` → plugin, auto-compiled, `nativeModule<T>()` from page and server | Swift plugin: sync, async, typed errors, AppKit, events |
| N-API addons from server code | ✅ | — | 🟡 | ✅ | 🟡 untested | ✅ `native/addons/*.c` → `.node`, `loadAddon()`, signed into the bundle | C addon in tests, built and dev |
| Sidecar binaries | 🟡 | ✅ | ❌ | ❌ | ❌ | ✅ `sidecars` + `sidecar()` | packaged and signed (no example) |
| Permission model for page → native calls | 🟡 | ✅ capabilities | ❌ | — | 🟡 origin gate | ✅ origin gate + `permissions.pages` allowlist enforced natively | bridge check; `denied` error |

## 3. Web view features

| | Electron | Tauri | Electrobun | before | **now** |
|---|---|---|---|---|---|
| alert / confirm / prompt | ✅ | ✅ | ✅ | ❌ ignored | ✅ native sheets |
| File drop with real paths | ✅ | ✅ | ✅ | ❌ | ✅ `fileDrop {paths}` (DOM events kept) |
| Downloads | ✅ | ✅ | 🟡 | ❌ | ✅ WKDownload, progress events |
| Print / PDF | ✅ | ✅ | 🟡 | ❌ | ✅ `print`, `printToPDF`, `window.print()` |
| Find in page / zoom | ✅ | 🟡 | ✅ | ❌ | ✅ |
| Context menu control | ✅ | 🟡 | ✅ | ❌ | ✅ none (prod default) / default / custom |
| Camera / microphone | ✅ | ✅ | 🟡 | ❌ | ✅ app origin only, plist + entitlements from config |
| Open-file / file associations | ✅ | ✅ | 🟡 | ❌ | ✅ `fileTypes` → CFBundleDocumentTypes, `openFiles` |
| capturePage, executeJavaScript, user agent | ✅ | 🟡 | ✅ | ❌ | ✅ |
| Multiple windows | ✅ | ✅ | ✅ | ✅ | ✅ |
| Menu-bar apps / popovers | 🟡 | 🟡 | 🟡 | ✅ | ✅ plus a lazy `preload:false` mode |
| Embedded extra web views (BrowserView / `<webview>`) | ✅ | ✅ | ✅ | ❌ | ✅ `view.*`: app routes or any URL at bounds, external content sandboxed from native (`test/platform/view.ts`, 15) |

Evidence: `test/platform/webview.ts`, 102 checks.

## 4. Distribution

| | Electron | Tauri | Electrobun | gpuix-svelte | before | **now** | Evidence |
|---|---|---|---|---|---|---|---|
| .app, Info.plist and icon from config | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ schemes, document types, usage strings, LSUIElement, extra keys | plist inspected |
| Hardened runtime and entitlements | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ Bun JIT set, plus device entitlements derived from usage strings | signed build (Apple Development identity), 19/19 e2e |
| Developer ID signing, timestamped | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ nested code first, then the bundle, then the DMG | `codesign -dvv` |
| Notarization and stapling | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 `notarytool` + staple (app and DMG), gated by a local pre-flight (`svelte-desktop preflight`) | a build signed with an Apple Development identity passes every pre-flight check except the certificate type; a real submission needs a Developer ID |
| Universal arm64 + x64 | ✅ | ✅ | 🟡 | ❌ | ❌ | ✅ lipo of executable, libshell, plugin and addons | e2e 19/19 on both slices (x64 under Rosetta) |
| DMG with Applications link, zip | ✅ | ✅ | ✅ | ❌ | 🟡 | ✅ | — |
| No `.env` / `bunfig.toml` picked up at runtime | — | — | — | ✅ | ❌ (found in this audit) | ✅ | regression test via `bunfig.toml` in cwd |
| Linux (GTK3 + WebKitGTK 4.1) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ native backend on the portable core; packaged as an app dir, tar.gz and AppImage; dev mode works | Docker (Ubuntu 24.04, Xvfb): native suites 354/0, notes e2e 11/11, `vite dev` e2e, release 7/7 |
| Windows (WebView2) | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 native backend on the portable core (≈150 ops); exe with icon/version resources, zip, NSIS installer (URL schemes, file associations), Authenticode via osslsigncode, signed release artifacts; x64 and arm64 | cross-compiled (llvm-mingw, -Wall -Wextra clean, all exports); Wine smoke of the native layer (25 calls, window lifecycle, close veto); installer install/uninstall under Wine. **Not run on real Windows**: Bun and WebView2 don't run under Wine |
| Mobile | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | — |

## 5. Auto-update

| | Electron | Tauri | Electrobun | before | **now** | Evidence |
|---|---|---|---|---|---|---|
| Signed updates | ✅ | ✅ | ❌ unsigned | ✅ | ✅ ed25519 manifest, sha256 artifacts | 53 unit tests |
| Release artifacts written by the build | ✅ | ✅ | ✅ | ❌ | ✅ `release/` (tar.zst, signed update.json) | `scripts/test-update.sh` |
| Delta updates | ❌ | ❌ | ✅ bsdiff | ❌ | ✅ per-file rsync-style `.sdpatch` in the signed manifest; 14 KB vs 39 MB | live 0.1.0 → 0.2.0 via the patch |
| Swap, relaunch, rollback | 🟡 | 🟡 | ✅ | ✅ | ✅ | live update; signature valid after the swap |

## 6. Performance (bench/RESULTS.md: hello world, median of 7, all processes)

| | .app | zip | ready | memory |
|---|---|---|---|---|
| Electron 45.2 | 258 MB | 115 MB | 303 ms | 88–149 MB |
| Tauri 2.12 | 4 MB | 1.8 MB | 313 ms | 75–170 MB |
| Electrobun 2.0.5 | 31 MB (187 MB installed) | 31 MB | 396 ms | 86 MB |
| ours, Bun 1.4.4 | 86 MB | 39 MB | 378 ms | 87 MB |
| ours, canary `--aot --trim` | 45 MB | 19 MB | 334 ms | 85 MB |

Startup times are within noise of each other (the machine was under load).
Memory is on par at the floor; ours is the most stable sample to sample. Size:
Tauri is ~10× smaller (no runtime); we're 3–6× smaller than Electron, on par
with Electrobun's download, and smaller than Electrobun once installed. Each
pre-warmed popover costs one WebKit content process (`preload: false` to defer).

## 7. Production hygiene

| | **now** |
|---|---|
| Logs when launched from Finder | ✅ `~/Library/Logs/<id>/app.log`, both threads plus uncaught errors, rotated |
| Graceful quit | ✅ signals, ⌘Q, Dock Quit → `onBeforeQuit` → exit |
| Web process crash | ✅ reload, then `ready` again |
| Single instance | ✅ flock + `secondInstance` |
| Crash dumps | 🟡 macOS writes `.ips` reports; no in-app reporter |

## Remaining gaps (honest)

0. **First run on a real Windows machine.** Everything that can be checked
   without Windows is checked (see the table). The first real run must confirm
   the WebView2 start-up, Bun FFI threadsafe callbacks on Windows, and the bridge
   timing (risk list in native/windows/README or the build report).

1. **Linux differences** (docs in native/linux): tray hosts don't report icon
   positions, so tray-anchored popovers open at the pointer; the
   menu/system/shortcuts/deepLink/capture/view services and some webview extras
   answer `unsupported`; `autosaveName` and `fileTypes` aren't wired yet. Only
   linux/arm64 was exercised (in Docker).
2. **Notarization run.** Implemented and pre-flighted locally (hardened runtime,
   timestamps, entitlements, nested signing and SDK all pass), but not submitted:
   that needs a Developer ID certificate and a notary profile.
3. **Screen capture** is implemented (ScreenCaptureKit: displays, windows,
   applications, PNG stills). The listing and capture paths need the Screen
   Recording permission for the responsible app (here "T3 Code (Nightly)", which
   needs a restart after the grant); the typed `denied` path is tested. Rerun:
   `bun test/harness.ts test/platform/capture.ts`.
4. **Mobile:** not built. See [MOBILE.md](MOBILE.md) for the plan: Bun ships Android builds (verified: `--target=bun-linux-arm64-android` compiles), so Android can keep the full architecture; iOS has no Bun, so a thin-client WKWebView host or a static offline mode.
5. **`--aot` / `--trim`** need Bun canary until they ship in a stable release.
