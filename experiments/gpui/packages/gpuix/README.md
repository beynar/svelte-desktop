# @svelte-desktop/gpuix — Svelte → native renderer (two backends)

Svelte 5 compiled components drive a fake DOM (`src/gdom.ts`) whose mutations
map onto an imperative op stream (`createElement`/`setStyle`/`setText`/
`setEventListener`/`insertBefore`/`destroyElement`/`setRoot`). No webview.

**Two native backends consume the identical op stream:**

- **gpuix** (`@gpuix/native`, napi-rs, vendored Zed GPUI) — `src/native.ts`
  flushes the queue as JSON into `applyBatch`.
- **quickgui** (`@quickgui/native`, custom WGPU+Taffy Rust core) —
  `packages/tests/qg-backend.ts`'s `QuickguiSink` translates each op into
  that package's retained-tree API (`NativeNode`/`insertNativeNode`/
  `setNativeProperty`/`setNativeEventListener`). `gdom.ts` is untouched.

The same 45-case suite passes on both (`bun packages/tests/conformance.ts` /
`bun packages/tests/conformance-qg.ts`), and the same unmodified `App.svelte`
(remote functions + `bun:sqlite`) has been verified live in a real window on
both.

## How it works

- `installGlobals()` installs fake `document`/`Node`/`Element`/`Text`/…
  **before** first mount, so `init_operations()` captures *our* prototype
  getters — Svelte internals traverse this tree unchanged.
- Template HTML is parsed by a mini parser into fake nodes (`innerHTML` on
  `template`), cloned per instance via `cloneNode`.
- Nodes materialize lazily: native ops emit when a subtree lands under the
  mounted root. Comments/fragments are pure-JS anchors (no native node);
  `insertBefore` anchors resolve to the next materialized sibling.
- Events: Svelte delegates via `document.addEventListener`; we record those
  types and emit `setEventListener` per element (with backfill, since Svelte
  registers delegation *after* first materialize). Native events dispatch into
  Svelte's own `handle_event_propagation` with a synthesized `composedPath`.
- **Mutation ops must never run inside the native event callback** — GPUI
  panics on reentrant GpuixView updates. Ops queue and flush on a macrotask /
  the frame loop.
- `remote.svelte.js` (in `@svelte-desktop/svelte`) ports the remote-function
  pattern in-process: `query(fn)` / `command(fn)` / `refreshAll()` — same DX
  as SvelteKit remote functions, no HTTP. `packages/tests/server.ts` is the
  "server side" fixture (bun:sqlite).
- `packages/svelte/kit/` adds the kit layer: `packages/svelte/build.ts` scans
  `packages/tests/routes/` for `+page`/`+layout`/`+error`/`*.server.ts` files
  → `gen/routes/manifest.js`; `runtime.svelte.js` runs load chains through
  `hooks.ts` (`init`/`handle`/`handleFetch`/`handleError`), and `Shell.svelte`
  recursively renders the layout→page chain. `goto`/`invalidate`/`depends`/
  `redirect`/`error`/`fail`/`pushState`/`preloadData`/`use:enhance`/`resolve`/
  `page`/`navigating`/`updated` via `#kit`. Form actions (`?/named` on
  `+page.server.ts`), `+server.ts` endpoints (resolved in-process by
  `event.fetch`), `[...rest]`/`[[opt]]`/`[p=matcher]`/`(group)` segments,
  `params/*` matchers, and `reroute`/`transport`/`handleFetch`/`handleError`
  hooks are all wired. Layout loads persist across navigation; errors render
  the nearest `+error.svelte` boundary. Verified by
  `bun packages/tests/kit-conformance.ts` — 49/49.

## Run

```sh
bun install
bun run gen                 # packages/svelte/build.ts: all src → each package's gen/
bun packages/tests/main.ts       # live window (gpuix backend)
bun packages/tests/main-qg.ts    # live window (quickgui backend: main-thread host + worker app)
bun packages/tests/test.ts       # headless: TestGpuixRenderer, simulateClick, screenshots
bun packages/tests/conformance.ts    # 45-case suite, gpuix TestGpuixRenderer
bun packages/tests/conformance-qg.ts # same 45 cases, quickgui RecordingHost (pure JS)
bun packages/tests/main-kit.ts       # live window: kit route tree (loads/hooks/nav), gpuix
bun packages/tests/main-kit-qg.ts    # same kit app on the quickgui backend
bun packages/tests/kit-conformance.ts # 49-case kit suite: loads, hooks, nav, actions, errors
bun packages/tests/probe-adversarial.ts # 27-check regression probe for the theme-engine
                                        # adversarial fixes (.agent/ADVERSARIAL-THEME.md)
bun packages/tests/probe-theme.ts    # 4-check theme/color ctx resolution probe
```

## Status (verified — 45/45 on BOTH backends)

mount ✓ state/derived/effect ✓ click via GPUI hit-test ✓ `{#if}`/`{#each}`
(keyed, reorder) ✓ `{#key}` `{#await}` ✓ `bind:value` + native text editing ✓
`use:` actions + update ✓ `{@attach}` ✓ `transition:fade` (real interpolated
native animation via WAAPI-lite `element.animate`) ✓ `class:` + scoped `<style>`
(class→StyleDesc bridge — scoped CSS actually applies) ✓ `<svelte:element>` ✓
`<svelte:boundary>` ✓ `<svelte:head>` ✓ snippets `{@render}` ✓ spread attrs ✓
`on:` modifiers (`|once`) ✓ `svelte/store` ✓ `setContext`/`getContext` ✓
`{@html}` ✓ `tick()` ✓ remote query/command + `bun:sqlite` ✓
`bind:this` ✓ `bind:value` (native text editing) ✓ `bind:checked` +
`bind:group` (checkbox/radio → clickable div + activation) ✓
`bind:clientWidth` (real bounds via automation tree + ResizeObserver-lite) ✓
`bind:innerHTML` (MutationObserver-lite) ✓ `<svelte:window onkeydown>` (window
key events via `setWindowKeyEvents` sentinel) ✓ `createRawSnippet` ✓
`new FormData(form)` (Bun FormData + fake-form collection) ✓ `scrollTo`/
`scrollTop`/`onscroll` (real `getScrollOffset`) ✓

Key fixes along the way:

- `svelte` resolves to its **server** entry under Bun — user-code imports must
  be aliased to the client entry (`packages/svelte/svelte-client.js`, done in
  `build.ts`; in a real package this is a bundler-plugin alias).
- Focused elements need key/focus listeners (that's what creates gpuix's
  FocusHandle); `focusElement` only works *after* a rendered frame.
- gpuix `change` on inputs = DOM `input` + `change` (dispatch both).
- `applyBatch` from inside the event callback → GPUI reentrancy panic. All
  mutation ops defer to a macrotask.

## Backend differences (found by the qg experiment)

- **quickgui gains**: real a11y (AccessKit), IME/undo/spell-check text editing,
  Taffy flexbox+grid, native hover/active/focus style states, reparenting
  without destroy/recreate (`insertNativeNode` handles moves), packaged
  signing/notarize/updater story, `new Window()` multi-window.
- **quickgui loses**: no JS-side layout readback — no `getElementBounds`/
  `getAutomationTree`/`scrollOffset` equivalent → `getBoundingClientRect`,
  `bind:clientWidth`, `animate:flip` measurement, scroll-offset reads are all
  **unverifiable/unsupported** there today. gpuix's test renderer exposes all
  of these.
- Headless conformance on quickgui asserts the retained `NativeNode` tree +
  listener invocation (no real hit-testing — no JS automation API; their
  TestContext is Rust-side only).
- quickgui runs the app in a **Bun worker** (AppKit owns the main thread) —
  remote functions/`bun:sqlite` unaffected; verified live.

## nkit — the component library (`src/nkit/`)

~45 Svelai-parity components on the style-prop lane: `s(props, ctx)` resolves
typed props (`bg`/`fg`/`radius`/`control`/`gap`/`hover`/`stateLayer`…) to
native `StyleDesc`; `resolveTokens` does the same for svelai class strings.
Recipes are cva-style per component (`recipes/*.js`).

**Definition-time validation** (the StyleX-shaped layer): `recipe()`/`cva()`
walk every fragment at module load — typo'd keys, malformed values,
undeclared `defaultVariants`/`compoundVariants` keys — and freeze configs.
`defineStyles({ name: props })` is the `stylex.create` equivalent: validated,
frozen, palette-sweep-registered fragments consumed via `s()`/`mergeProps`.
Issues land in `definitionIssues` (lane `'props'` = always a bug, reported
loudly; lane `'class'` = boundary drops, informational) and re-check against
the live palette on every theme swap. `bun packages/tests/probe-stylex.ts` — 21/21.

**Theming** — `<Theme>` (`Theme.svelte` + `theming.svelte.js`) mirrors svelai's
ThemeState: `themes`/`defaultTheme`/`forcedTheme`/`enableSystem`/`storageKey`
(persists to `~/.config/nkit/<key>.json`)/`colorScheme`/`value`/`attribute`,
`designTokens` (svelai's spacing/radius/typeScale factors compiled onto the
token tables — `small|normal|large`, `none…round`, fluid type presets),
`motion` (duration `instant|fast|normal|slow|slower` + named easings),
`components` registry, `spinnerVariant`, `reduceMotion`, `size`/`density`/
`defaultColor` globals, `onSystemResolve`/`onThemeChange` hooks. macOS
light/dark detection via `defaults read -g AppleInterfaceStyle`.

Reactive restyle without remount — two lanes. **Native lane:** token *names*
cross the wire unresolved (`backgroundColor: "secondary"`), so a scoped
`theme`/`color` custom-prop change — or a reparent under a differently-themed
ancestor — re-resolves the subtree's stored raw styles natively; no JS
re-emission. **JS lane:** global `<Theme>` swaps still bump a `$state`
revision counter (`revision.svelte.js`) so every `$derived` style recomputes
+ pushes. **Rule:** `s()` calls must sit inside `$derived` (or `{@const}`/
template expressions) — a top-level `const x = s(...)` resolves once and goes
stale on theme flip.

Component-theme ladder (per svelai): recipe `defaultVariants` →
`<Theme components>` registry → `<ComponentTheme>`/`setComponentTheme` subtree →
instance `theme` prop → instance props/styles. Laddered props (`variant`,
`size`, `density`, `color`, `side`, `align`, `shape`) must arrive `undefined`
to `ct.props()` — destructure defaults would mask registry overrides.

**Motion** — three lanes: native `motion` prop on `Layer` (anchored overlays),
WAAPI-lite `el.animate()` (progress widths, spinner/skeleton loops —
`iterations` incl. `Infinity`, `direction:'alternate'`), and Svelte-contract
transitions in `transitions.js` (`fso`/`fade`/`fly`/`zoom`/`slide` — `in:`/
`out:`/`transition:` write native style props per tick; `mx`/`my` = margin
offsets for flow elements). The 5-rung motion ladder: component preset →
registry `motion` → subtree → instance `theme.motion` → instance `transition`
prop → `reduceMotion` collapses to 0.

`bun packages/tests/conformance-nkit.ts` — 30/30 (incl. `c-theme`, `c-motion`).
`bun packages/tests/smoke-pages.ts` — 25/25 showcase pages paint.
`bun packages/tests/main-showcase.ts` — live window with a global
theme-controls header bar.

## Not done / caveats

- `bind:files` (no FileList source), `bind:contentRect` variants, dimension
  binds read automation-tree bounds (gpuix test renderer only — see above).
- Checkbox/radio render as styled divs — semantics work, the *appearance* is
  app-authored (no native checkmark glyph).
- `<select>` element semantics, `bind:value` on select, contenteditable.
- `animate:flip` (rects now resolve via automation tree — untested),
  `svelte/motion` (rAF-based, should work — untested).
- Hydration: mechanically possible (innerHTML parser + `hydrate()`), but
  pointless — there is no SSR HTML payload in a native app.
- A11y: the owned renderer (`native/`) maps `role`/`aria-*` onto gpui's
  `AriaProperties` — pressed/selected/expanded/value*/orientation/set
  indices all wire; `haspopup`/`controls`/`disabled`/`busy` are fork-blocked
  (closed struct). The published gpuix `.node` still exposes no role/label
  API — attrs become inert custom props there.
- Multi-window: `GpuixRenderer.init()` owns one window; no JS API for more.
- Window/document non-key events (`resize`) unwired. `mouseDownOutside` works —
  it targets elements owning both the listener and a FocusHandle
  (`tabIndex` + key/focus listeners), then bubbles; `anchored` + `occlude` +
  `autoFocus` is the overlay pattern (`Layer.svelte`).
- IME composition edge cases, text selection APIs, clipboard.
- Packaging: `bun` + `.node` + JS → `.app` bundle — `scripts/package-app.ts`
  (Electrobun-style; see `documentation/packaging.md`), or
  `bun build --compile packages/tests/mission-startup.ts` for the single
  binary (110 MB, verified).
