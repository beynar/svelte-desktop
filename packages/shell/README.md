# @svelte-desktop/shell

Turn an **unmodified SvelteKit app** into a native desktop app (macOS; Linux via
GTK/WebKitGTK; Windows via WebView2 — see Platforms): one Vite plugin,
one config file. SSR, remote functions, form actions, endpoints and `bun:sqlite`
run in-process on Bun; the UI is the system WebKit; the result is a signed,
notarizable `.app` containing a single compiled executable.

```
bunx --bun vite dev     → the real native window on the Vite server (HMR, Web Inspector, native APIs live)
bunx --bun vite build   → .desktop/dist/App.app + .zip + .dmg (+ release/ for the auto-updater)
bun test                → drive the real window from tests
```

## Setup

```ts
// vite.config.ts — the only plugin you need (it is SvelteKit's plugin, wired for desktop)
import { desktop } from '@svelte-desktop/shell/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [desktop({ experimental: { remoteFunctions: true } })] });
```

```ts
// desktop.config.ts
import { defineConfig } from '@svelte-desktop/shell/config';
export default defineConfig({
  appName: 'Notes',
  identifier: 'com.example.notes',
  window: { width: 960, height: 680, autosaveName: 'main' },
});
```

New project: `bunx svelte-desktop create my-app` (SvelteKit app, config, Swift plugin sample, tests).
Existing project: `bunx svelte-desktop init` writes both files, rewrites
`sveltekit(` → `desktop(`, adds scripts and `.gitignore`. `bunx svelte-desktop doctor`
checks Bun, Xcode tools, the config, signing identities and the notary profile.
Requirements: macOS 12+, Bun ≥ 1.4, Xcode command line tools, `@sveltejs/adapter-bun`.

## What you get

| | |
|---|---|
| **Your app, unchanged** | SvelteKit SSR + remote functions + `bun:sqlite`, served on a random loopback port behind a session-cookie gate (Host check, one-time secret, HttpOnly cookie) |
| **Dev mode** | `vite dev` opens the native window on the Vite server: HMR in the window, Web Inspector, server code reaches native APIs through an RPC bridge, native plugin rebuilt and window restarted on change, `desktop.config.ts` edits restart. Closing the window ends `vite dev`. |
| **Native API** | 245 ops in 22 services (incl. aliases), typed, from pages **and** server code, plus reactive stores (`import { theme, window, tray } from '@svelte-desktop/shell/stores'`). [Platform API](#platform-api) |
| **Your own native code** | `native/*.swift` / `*.m` / `*.c` → a plugin dylib, ops callable from pages and server (`nativeModule<T>('svc')`); `native/addons/*.c` → Node-API addons (`loadAddon`); `sidecars` for executables. [Native code](#native-code) |
| **Web view features** | alert/confirm/prompt, file drop with real paths, downloads, print/PDF, find, zoom, context menu control, camera/mic permissions, open-file/file associations, capturePage, executeJavaScript. [WEBVIEW.md](WEBVIEW.md) |
| **Menu-bar apps & popovers** | `<StatusItem popover="/route">`, `<Popover anchor={el}>`, Spotlight-style panels on a global hotkey, content sized to fit. [POPOVERS.md](POPOVERS.md) |
| **Distribution** | Info.plist from config (URL schemes, document types, usage strings, LSUIElement), icon from one PNG, hardened runtime + entitlements, Developer ID signing, notarization + stapling, universal arm64+x64, zip, DMG with Applications link |
| **Auto-update** | ed25519-signed manifest + sha256-pinned artifacts from any static host; `vite build` writes `release/` including a **delta patch** from the previous release (14 KB instead of 39 MB for a typical change); download → verify every file → swap after quit → relaunch, rollback if the new version doesn't start. [updater README](src/updater/README.md) |
| **Testing** | `launch()` drives the built app or `vite dev` in its real window: `click`, `fill`, `press`, `waitFor`, `eval`, `platform`, `screenshot`, `nextEvent` |
| **Production hygiene** | logs to `~/Library/Logs/<id>/app.log` when launched from Finder, graceful quit (signals, ⌘Q, Dock) with `onBeforeQuit`, crash recovery of the web process, single-instance lock, no `.env`/`bunfig.toml` pickup at runtime |

## Configuration (`desktop.config.ts`)

| key | |
|---|---|
| `appName`, `identifier`, `version` (package.json), `icon` (static/icon.png), `copyright` | identity |
| `window` | `{ width, height, minWidth, minHeight, title, autosaveName, visible, hiddenUntilReady, debug }` or `false` (menu-bar app) |
| `schemes` | deep-link URL schemes → `openUrls` event |
| `fileTypes` | `[{ name, extensions, role, rank, utis }]` → `openFiles` event |
| `usageDescriptions` | `{ camera, microphone, location, … }` → Info.plist strings **and** hardened-runtime entitlements |
| `trayOnly` | no Dock icon / app menu |
| `native` | native plugin folder (default `native/`), `false` to disable |
| `addons` | prebuilt `.node` files to ship |
| `sidecars` | `{ name: 'bin/tool' }` → `sidecar(name, args)` |
| `permissions.pages` | ops pages may call (`'window.*'`, `'clipboard.readText'`); enforced natively; server code unrestricted |
| `update` | `{ manifestUrl, publicKey, channel, privateKey, baseUrl }` |
| `build` | `{ aot, trim, bun, universal, dmg, zip, outDir, minimumSystemVersion }` — `aot`/`trim` need Bun canary today |
| `sign` | `{ identity, entitlements, hardenedRuntime, notaryProfile }` — or `$CODESIGN_IDENTITY`, `$NOTARY_PROFILE` |
| `plist` | extra Info.plist keys |

## Platform API

```ts
import { app, windows, popover, tray, dialog, clipboard, webview, nativeModule, broadcast } from '@svelte-desktop/shell/platform';
import { theme, window, power, screen } from '@svelte-desktop/shell/stores';   // reactive ($state), event-fed
import { desktop, onDesktopReady, loadAddon, sidecar } from '@svelte-desktop/shell/server'; // server code
import { onDesktopEvent } from '@svelte-desktop/shell/client';                  // pages
```

Services: app · window (81 ops, multi-window, close veto, titlebar styles) · screen ·
clipboard · shell · dialog · theme · menu (app/Dock/context, live updates) · system
(+ permissions) · power · secureStorage (Keychain, Touch ID) · notifications · deepLink ·
tray · shortcuts (global hotkeys) · popover · webview · diagnostics/capabilities ·
updater. `capabilities.describe()` lists every op of the running build.
Calls from pages go straight to native (an origin-checked WebKit message handler);
calls from server code go over FFI (or RPC in dev) to the same dispatcher.

## Native code

```swift
// native/Greeter.swift — compiled by the plugin, loaded on the UI thread
func desktopSetup() {
  Desktop.command("greeter.hello") { args in "Hello \(args["name"] as? String ?? "?")" }
  Desktop.command("greeter.title") { _ in Desktop.window()?.title }      // MainActor: AppKit is fine
  Desktop.command("greeter.add") { args in
    guard let a = args["a"] as? Double, let b = args["b"] as? Double else { throw DesktopError.invalidArgs("numbers") }
    return a + b                                                           // async/await allowed
  }
}
```

```ts
const greeter = nativeModule<{ hello(a: { name: string }): string }>('greeter');
await greeter.hello({ name: 'Ada' });            // from a page or from server code
```

Objective-C/C: `SDCommand(@"svc.op", ^(NSDictionary *args, SDReply reply) { … })` in
`void SDSetup(void)`; raw C ABI in [`native/include/svelte_desktop.h`](native/include/svelte_desktop.h).
Frameworks autolink from `import`/`@import`. Node-API addons: `native/addons/fastmath.c` →
`loadAddon<{ fib(n: number): number }>('fastmath')` in server code (dev and build).

## Testing

```ts
import { launch } from '@svelte-desktop/shell/test';
const app = await launch();                       // built app; launch({ dev: true }) for vite dev
await app.fill('input[name=q]', 'hello'); await app.press('input[name=q]', 'Enter');
await app.waitFor(() => document.body.innerText.includes('hello'));
expect(await app.platform('window', 'getTitle')).toBe('Notes');
await app.close();
```

Run with `bun test --timeout 30000` (app startup exceeds bun's 5 s default). The test
channel exists only when `launch()` sets `SVELTE_DESKTOP_TEST`.

## Distribution

```sh
CODESIGN_IDENTITY="Developer ID Application: You (TEAMID)" NOTARY_PROFILE=notary bunx --bun vite build
```

Signs nested code then the bundle with the hardened runtime and the entitlements Bun's
JIT needs (plus device entitlements derived from `usageDescriptions`), notarizes and
staples the app and the DMG, after a local pre-flight of Apple's requirements
(`bunx svelte-desktop preflight App.app` runs it on any bundle). Without an identity builds are ad-hoc signed (runs
locally, Gatekeeper blocks downloads). `build.universal` lipos arm64 + x64 (Bun cross-
compiles the x64 slice; `aot` stays on the host slice).

## Architecture

```
App.app/Contents/MacOS/App                one bun --compile executable (UI thread + Worker)
App.app/Contents/Frameworks/libshell.dylib  ~570 KB: webview/webview + native services
                           /libapp-native.dylib, addons/*.node   your native code
main thread: Cocoa run loop (WKWebView)   ←→   Worker: Bun.serve (SvelteKit) + desktop API
             one native dispatcher (platform_*.mm) for page bridge, FFI and plugins
```

## Measured (macOS 26.5, M4 Pro — see [bench/RESULTS.md](bench/RESULTS.md))

| hello world | .app | zip | ready | memory (all processes) |
|---|---|---|---|---|
| Electron 45 | 258 MB | 115 MB | 303 ms | 88–149 MB |
| Tauri 2.12 | 4 MB | 1.8 MB | 313 ms | 75–170 MB |
| Electrobun 2.0 | 31 MB (187 installed) | 31 MB | 396 ms | 86 MB |
| **this, Bun stable** | 86 MB | 39 MB | 378 ms | 87 MB |
| **this, `--aot --trim`** | 45 MB | 19 MB | 334 ms | 85 MB |

## Tests in this repo

- `test/run-platform.sh` — native suites against a real window (476 checks).
- `bun test src/updater` — updater + delta engine (53 tests). `examples/notes`: `bun run test`,
  `bun run test:dev`, `scripts/test-update.sh` (real 0.1.0 → 0.2.0 update through a delta patch).

## Platforms

| | native backend | packaging | verified |
|---|---|---|---|
| macOS 12+ | `native/*.mm` (Cocoa, WKWebView) | .app, zip, DMG, notarization, universal | full suites on this Mac |
| Linux | `native/linux` (GTK3, WebKitGTK 4.1) on `native/portable` | app dir, tar.gz, AppImage | Docker under Xvfb (`test/docker/run.sh platform|notes`) |
| Windows | `native/windows` (Win32, WebView2) on `native/portable` | folder, zip, NSIS installer, Authenticode | cross-compiled + Wine smoke of the native layer; **not yet run on real Windows** (AUDIT.md) |

`build: { target: 'linux' | 'windows' }` selects the target. The portable core
(`native/portable`) carries the dispatcher, bridge, permissions and plugin host
shared by Linux and Windows.

## Limits
 `aot`/`trim` need Bun canary. Notarization needs your Developer ID
(the pipeline is implemented, not exercised here). See [AUDIT.md](AUDIT.md).
