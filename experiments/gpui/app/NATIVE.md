# Native boot — the app in a GPUI window

Runs **this app's real routes** (`app/src/routes`) inside the native GPUI
window through the kit-shaped runtime in `@svelte-desktop/svelte` — no
webview, no HTTP.

## Dev loop — `bun run dev`

`vite.config.ts` loads `svelteNative()` from `@svelte-desktop/vite`
(`packages/vite`). The plugin owns the loop:

```
vite dev
  → emit.js        native app entry (virtual:svelte-native/manifest)
  → vite build     compiles app/src routes/components/loads through
                   svelte/compiler → app/.svelte-native/app.js
  → spawn          bun app/.svelte-native/app.js  (real GPUI window)
  → watch          source change → hmr update (state kept) or full-reload
```

`vite build` emits the same spawnable bundle without launching.

## Packaging — `bun run build`

`bun run build` runs `vite build` then compiles the emitted bundle into a
single binary inside an `.app`:

```
vite build → .svelte-native/app.js (374 kB bundle, @gpuix/native external)
  → bun build --compile (+ Info.plist)
  → dist/SvelteNotes.app   (85.5 MiB, ad-hoc signed)
```

Launch with `open dist/SvelteNotes.app` (LaunchServices — dock presence,
URL scheme `sveltenotes://`) or exec `dist/SvelteNotes.app/Contents/MacOS/SvelteNotes`
directly. The embedded `.node` extracts once to a content cache, so later
launches skip the extraction tax.

`--external @gpuix/native-darwin-arm64` is passed to `bun build --compile`
because the napi loader's optional scoped-package fallback doesn't resolve
under the pinned fixture copy — the sibling `.node` require wins at
runtime, so the external stays dead code.

### App icon

Two CLIs ship with `@svelte-desktop/gpuix` (linked into `node_modules/.bin`):

- **`svelte-native-package`** — the .app bundler (`scripts/package-app.ts`).
  `--icon <path>` overrides discovery, `--no-icon` opts out.
- **`svelte-native-icon`** — standalone icon compiler
  (`scripts/app-icon.ts`). `svelte-native-icon icon.png -o AppIcon.icns`
  builds an icns without bundling — iterate on art, or hand an iconset:
  `svelte-native-icon App.iconset/`.

Drop **`icon.png`** (1024×1024) next to `package.json` and rebuild — it's
discovered automatically, `sips` generates the full 10-slot `.iconset`,
`iconutil` compiles `Contents/Resources/AppIcon.icns`, and
`CFBundleIconFile` lands in the plist. `icon.icns` (copied verbatim) and
`icon.iconset/` (compiled as-is) are also discovered, in that priority
order. Sources under 1024px work but warn — the 512px+ slots upscale.

This app's `icon.png` is a generated placeholder (dark squircle, note
card, yellow band) — replace the file, rebuild, done.

### Permissions / TCC

Runtime checks and prompts ride `system.checkPermission` /
`system.requestPermission` / `system.openSettings` (see
`documentation/docs/platform-api.mdx`). Most names need no declaration —
accessibility, screenRecording, and notifications prompt or deep-link at
runtime (notifications additionally require the bundled app — they return
`unavailable` in the unbundled dev host).

`camera` and `microphone` are the exception: macOS requires the usage
string **in Info.plist before the request runs** — the unguarded
AVFoundation call aborts the process without it. Declare them at package
time:

```sh
bun run build  # plus, in the package.json script:
  … --usage camera="Scan QR codes" --usage microphone="Voice notes"
```

`camera`/`microphone` map to `NSCameraUsageDescription`/
`NSMicrophoneUsageDescription`; any other `NS*UsageDescription` key passes
through verbatim (protected folders, contacts, …). Missing key →
`requestPermission` returns `unavailable` naming the key.

One caveat for TCC-gated testing: the packaged binary is **ad-hoc signed**,
and TCC binds grants to the code signature — every rebuild produces a new
cdhash, so Accessibility/Screen Recording grants don't survive a rebuild.
Day-to-day TCC work wants a stable signing identity (Developer ID, or a
reused self-signed cert).

Generated output lives in `.svelte-native/` — `app.js` (entry) +
`dev.json` (ws URL + token). Nothing else at the app root.

## Window chrome — app-owned titlebar

The emitted `renderer.init` passes `titlebarTransparent: true` +
`appOwnsTitlebarDrag: true`, so the app owns the whole window surface:
the titlebar is invisible and the content view sits under the traffic
lights (macOS `fullSizeContentView`-style). `appOwnsTitlebarDrag` marks
the content view as app-owned titlebar content — AppKit neither
auto-drags the strip nor delays its clicks; the app decides what moves
the window.

Any element opts into moving the window with **`data-window-drag`** —
the attr maps to the `windowDrag` custom prop; mouse-down arms the
gesture and the first move with the button held calls
`Window::start_window_move` (plain clicks still dispatch normally). A
`click_count == 2` press calls `Window::titlebar_double_click()`, which
honors the macOS `AppleActionOnDoubleClick` setting (zoom / minimize /
none) — the real native double-click-titlebar behavior.
`+layout.svelte` carries a `data-window-drag` header with an ~84px
traffic-light gutter.

Interactive descendants inside a drag region are **no-drag** by
derivation — a double-click on a titlebar button must not zoom the
window. gdom marks real activation targets with the `pressTarget` prop
(interactive tags/roles, `contenteditable`, own or delegated activation
listeners incl. pointer/touch presses — `element.events` can't be used
because delegated types live in the tree-level set, not per element). The mark is
a lifecycle: it's recomputed and retracted as listeners and relevant
attributes change post-mount. Such elements consume the native press
before it reaches the region's handlers — but only when a `windowDrag`
ancestor actually exists (the guard walks live ancestors at press time,
so window-level consumers like text selection are unaffected elsewhere);
focusable controls (input, x-button, tabindex…) instead mark
`default_prevented` via `track_focus`, which the drag handler also
respects. Plain children still propagate, so empty titlebar space keeps
dragging and double-clicking as usual.

Plugin opts override the emitted flags: `svelteNative({
titlebarTransparent, appOwnsTitlebarDrag, trafficLightX, trafficLightY })`.

## Headless — `headless: true` plugin option

`TestGpuixRenderer` — no window; pump events, print painted text, exit.
Same entry, different renderer class.

- Headless proof: `bun packages/tests/test-app.ts` (mounts, navigates
  / → /about → /, clicks `increment via command()` → sqlite write +
  query refresh repaints the counter, submits the `form()`).

## Specifier mapping (vite plugin, app-side files only)

| app source          | resolves to                                             |
| ------------------- | ------------------------------------------------------- |
| `$app/server`       | `@svelte-desktop/svelte/app-compat/server.js` (`query/command/form/prerender` from `#remote` + `getRequestEvent/read/invalid` from `#kit`) |
| `$app/<other>`      | `#kit` — navigation/state/forms/paths/environment superset |
| `#lib/x`, `$lib/x`  | `app/gen-app/lib/<emitted>` — probed against `app/src/lib` |
| `./x.ts` relative   | emitted sibling (`x.ts.js` — never collides with `x.svelte`→`x.js`) |
| `*.svg`/`*.png`/…   | emitted `.js` stub exporting the file's absolute path    |
| `svelte`/`svelte/*` | client entries via `@svelte-desktop/svelte/svelte-client.js` |

Route-module naming: `+page.ts` → `+page.ts.js` (vs `+page.svelte` → `+page.js`).
App `hooks.ts`/`hooks.server.ts`/`hooks.client.ts`/`src/params/*` are picked up
if added (compiled into `gen-app/`, merged into the manifest).

## Remote functions — in-process transport (no HTTP)

`data.remote.ts` compiles as a plain module; `query/command/form` are the
in-process constructors from `remote.svelte.js`. Each call runs inside a
synthesized RequestEvent through `hooks.handle` (`__remoteInvoke`), so
`getRequestEvent()`/locals/cookies work. `form()` spreads real DOM props +
`data-remote-form` dispatch through the router's submit pipeline.
Verified: `getState` (query) resolves inside `{@const x = await …}` in a
`<svelte:boundary>`; `increment` (command) writes `bun:sqlite` and the
awaited state repaints.

## Known gaps / divergences

- `<code>` text isn't in `getPaintedText()` (it is in the automation tree) —
  a renderer/debug API limit, not app breakage.
- `openNativeDialog` returns `{native:false}` — `__nativeBridge` is a host-shell
  injection; absent in-process by design.
- No `+error.svelte` in the app → unexpected errors render blank (kit would
  use the root error page; add one to `app/src/routes/` to cover).
- `hooks` is empty (`export {}`) until the app adds a hooks file.
- Assets resolve to a file-path string (no asset server) — fine for
  `<link rel=icon>`; a real image pipeline is a vite-plugin concern.
- `.css` imports: the vite plugin harvests them into the native stylesheet
  registry (`virtual:svelte-native-style?<id>`); the direct build-app path
  strips them.
- Remote `query` results are cached per args for the mount's lifetime
  (remount after unmount re-queries; navigation keeps cached resources —
  `queries` registration is owner-scoped, matching kit semantics loosely).
- `command()`/`form()` invoked *inside* a derived would still hit
  `state_unsafe_mutation` (synchronous `$state` writes) — kit intends them
  for event contexts; the app uses them correctly (onclick/form submit).
