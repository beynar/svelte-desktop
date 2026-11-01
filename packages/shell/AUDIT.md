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
| Native/server API in dev | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ RPC bridge Vite ↔ dev shell; addons and sidecars in dev with or without a window | `bun run test:dev` 10/10 |
| Unmodified SSR framework | 🟡 | ❌ SPA | 🟡 SPA | ❌ | ✅ | ✅ full SvelteKit 3: SSR, streaming, form actions, cookies, remote functions, prerendering, params, hooks, `$app/env` | `examples/kit-conformance` 18/18, built and `vite dev` |
| Typed native API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 245 ops, 22 services, stores | `test/run-platform.sh` |
| E2E testing of the real app | 🟡 Playwright | 🟡 WebDriver | ❌ | ✅ | 🟡 bespoke script | ✅ `@svelte-desktop/shell/test` (macOS, Linux, Windows layout, Android over adb, iOS simulator) (built or dev) | `bun run test`, 8/8 |
| DevTools | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ on in dev; `debug` / `setInspectable` in prod | — |

## 2. Native extensibility

| | Electron | Tauri | Electrobun | gpuix-svelte | before | **now** | Evidence |
|---|---|---|---|---|---|---|---|
| App-defined native commands on the UI thread | 🟡 addons | ✅ commands | 🟡 | ❌ | ❌ | ✅ `native/*.swift`, `.m`, `.c` → plugin, auto-compiled, `nativeModule<T>()` from page and server | Swift plugin: sync, async, typed errors, AppKit, events Android: C plugins over JNI; iOS: Swift plugins |
| N-API addons from server code | ✅ | — | 🟡 | ✅ | 🟡 untested | ✅ `native/addons/*.c` → `.node`, `loadAddon()`, signed into the bundle | C addon in tests, built and dev |
| Sidecar binaries | 🟡 | ✅ | ❌ | ❌ | ❌ | ✅ `sidecars` (one path or per platform) + `sidecar()`; Android compiles `native/**/sidecars/*.c` | Android e2e runs one from server code |
| Background processes from app code | ✅ utilityProcess | ✅ sidecar / shell | ✅ Bun | ❌ | 🟡 | ✅ managed jobs: `src/jobs/*.ts` in their own processes (`jobs.start/get/list/wait/cancel/on`, progress, events, concurrency, history across restarts, page store); plus raw `Bun.spawn` / Workers | notes e2e: macOS built + dev, Linux Docker, Android |
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
| Hidden title bar + drag regions | ✅ `titleBarStyle`, `app-region` | ✅ `decorations`, `data-tauri-drag-region` | ✅ `titleBarStyle` | ❌ | 🟡 runtime op only | ✅ `window.titleBarStyle` (hidden / hiddenInset / transparent), `data-desktop-drag` or `--app-region: drag`, chrome CSS variables, double-click per system setting — macOS (traffic lights kept); Linux and Windows: frameless window, page-drawn controls (`data-desktop-controls="none"`), same drag regions | macOS e2e; Linux Docker e2e (double-click maximizes under openbox); Windows: Wine smoke (style switch) |
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
| Mobile | ❌ | ✅ | ❌ | ❌ | ❌ | 🟡 **Android**: the same SvelteKit server compiled for `bun-linux-arm64-android` in an APK (Java WebView host, same gate, WebMessagePort page bridge, stdio server bridge, ~60 ops incl. dialogs, notifications, Keystore secure storage; NDK-built Node-API addons, C plugins over JNI, sidecars; APK and Play AAB). **iOS**: thin client — native WKWebView host on the deployed server, same bridge and services (Keychain, notifications, share, haptics) and Swift plugins (`Desktop.command`); online or offline (bundled build on app://localhost) | Pixel 9 emulator (Android 17): `tests/android.test.ts` 14/14 (from the APK and from the AAB); iPhone 17 Pro simulator (iOS 26.5): `tests/ios.test.ts` 11/11, `tests/ios-offline.test.ts` 4/4 |

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
| Crash reports | ✅ `desktop.crashInfo()`: unclean exit of the previous run + the OS reports written since (macOS `.ips`, Windows minidumps), to upload as you like (`tests/crash.test.ts`: graceful quit vs `kill -9`) |
| Cookies / sessions in production | ✅ SvelteKit's default `Secure` cookies work on the loopback origin (the gate drops `Secure`, WebKit would discard them); no idle timeout on slow requests |

## Remaining gaps (honest)

0. **First run on a real Windows machine.** Every service of the contract now has a
   Windows implementation (embedded views and capture included, compiled for x64 and
   arm64). Everything that can be checked
   without Windows is checked (see the table). The first real run must confirm
   the WebView2 start-up, Bun FFI threadsafe callbacks on Windows, and the bridge
   timing (risk list in native/windows/README or the build report).

1. **Linux differences** (docs in native/linux): tray hosts don't report icon
   positions, so tray-anchored popovers open at the pointer; global shortcuts and
   capture need X11 (Wayland has no app API for them: they answer `unsupported`
   there). Everything else is implemented: app menu bar (GtkMenuBar, accelerators,
   live updates), context menus, global shortcuts (XGrabKey), capture (displays and
   windows, PNG), system (info, keyboard layout, accent color, accessibility),
   embedded views (`view.*`, the macOS suite passes unchanged), `autosaveName`,
   documents and links the app is opened with, single instance. Linux native
   suites 400/0, notes e2e 13/13 + integration 3/3, in Docker (linux/arm64 only).
2. **Notarization run.** Implemented and pre-flighted locally (hardened runtime,
   timestamps, entitlements, nested signing and SDK all pass), but not submitted:
   that needs a Developer ID certificate and a notary profile.
3. **Screen capture** is implemented (ScreenCaptureKit: displays, windows,
   applications, PNG stills). The listing and capture paths need the Screen
   Recording permission for the responsible app (here "T3 Code (Nightly)", which
   needs a restart after the grant); the typed `denied` path is tested. Rerun:
   `bun test/harness.ts test/platform/capture.ts`.
4. **Mobile:** Android runs the full stack (14/14 e2e on the emulator, from the APK and from the Play AAB; addons, C plugins and sidecars included). iOS runs as a thin client or offline with Swift plugins (11/11 + 4/4 on the simulator): server code stays on your server. iOS device builds compile and link for `iphoneos` (unsigned `.app`, arm64, platform iOS, min 17.0) but were not installed on a device: that needs a provisioning profile. Android x86_64 builds are packaged and split by bundletool but were not run (no x86 emulator on Apple Silicon).
5. **`--aot` / `--trim`** need Bun canary until they ship in a stable release.
6. **Hidden title bar** works on macOS (traffic lights kept) and Linux (frameless, tested); on Windows it is implemented and checked under Wine, but the drag needs a real Windows run.
7. **Background jobs** are verified on macOS, Linux and Android; on Windows they are bundled the same way but, like the rest of the Windows build, not run.
