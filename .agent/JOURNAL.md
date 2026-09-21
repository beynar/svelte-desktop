# JOURNAL

## 2026-09-15 — mission start
- Env pinned: Bun 1.4.0, Rust 1.94.0, macOS 26.5.1, M4 Pro/48GiB, 29GiB free disk.
- Repo is not a git repository → no checkpoint commits; state files are the only
  rollback record.
- Found prior work intact: gpuix-poc (Svelte→GPUI fake-DOM bridge + nkit lib,
  all suites green), app/ (SvelteKit + adapter-bun + --compile config),
  native/ (vendored GPUI cargo scaffold, unbuilt).
- Verified @gpuix/native is a NAPI-RS addon (in-process Rust) and
  @quickgui/native is bun:ffi+dlopen — both transport candidates already live.
- Created .agent/STATE.md, TASKS.json, JOURNAL.md. Starting discovery audit.

## 2026-09-15 — mission execution

**Measured (results/run-20260915-a/):**
- Transport: NAPI call 44ns, bun:ffi call 13ns — both noise-level.
- applyBatch: 10k ops (320KiB JSON) → 0.68ms mean; 10MiB payload 1.9ms;
  drainEvents idle 0.1µs.
- Startup (real window, showcase): NAPI load 12ms, window init ~270ms,
  mount ~60ms → first frame ~450ms; steady RSS ~150MiB. Compiled binary:
  +428ms one-time .node extraction → first frame ~940ms, RSS ~174MiB.
- Frame p90 5.5ms real window; 9 frames/3s idle = event-driven confirmed.
- bun:sqlite: WAL, atomic rollback, 1.49M tx ins/s, ~2µs point gets,
  multi-conn reads, 40k-row sync copy 8.7ms. Workers: file-URL only (no
  Blob), own sqlite conn works.
- Packaging: app/build-bin/server 64.6MB serves 200; desktop --compile
  82.6MB opens real window — both unsigned.
- $native spike: rustc cdylib (390KiB) + codegen → typed bindings.
  add/wordCount/jsonTransform working, typed errors, 18ns/call.
  Found+fixed: codegen missing out-param arg; use-after-free via
  toArrayBuffer view read post-free.

**Architecture decision (docs/recommendation.md):** keep Bun-host + NAPI
in-process renderer (architecture B — the existing working baseline);
sidecar rejected on evidence (adds IPC surface to solve an already-solved
discipline); FFI kept for service dylib + $native; embedded-Bun gate not
opened (no upside vs working baseline).

**Deliverables written:** docs/{discovery,sources,quickgui-analysis,
sveltekit-compatibility,threading,packaging,security-model,recommendation}.md,
spec/native-api.yaml, packages/native/{commands.json,codegen.ts,bindings.ts},
crates/native-core/src/lib.rs, results/run-20260915-a/*, root package.json
task scripts (test/bench/demo/package/codegen/report — all run green).

**Final smoke:** bun run test → 45/45 + 30/30 + 49/49 + 45/45 + 25/25.
Note: smoke-pages prints non-fatal stack-trace noise at pump (dev warnings),
pages all pass — worth silencing next session.

**Not done (honest):** multi-window, a11y depth, updater, runtime-testing of
bound quickgui services, signing, cross-platform builds, embedded-Bun spike.

## 2026-09-15 (cont.) — Mission 2 tail: multiwin + reliability + a11y

### Multi-window (QuickGUI backend) — results/run-20260915-b/multiwin.log
- Fixed probe layering: runHost → worker → runApplication (same as mission-qg-app).
- PASS: 2 windows, 2 independent Svelte trees, win-a closed at 1.2s → win-b kept
  rendering, both renderer cleanups ran on close. `closed` flags correct.
- BLOCKER (lifecycle): Bun host segfaults (null deref @0x8) when the worker exits
  while the host still holds FFI notifier callbacks — reproduces both with bare
  process.exit AND after orderly window destroy. Also: app.destroy() from a timer
  races the host dispatch pump ("app has been destroyed" from post-destroy flush).
  Single-window service probe exited cleanly; multiwin teardown does not.
  Severity: crash-on-exit (after work completes) — alpha-acceptable, prod-blocking.

### Reliability suite — src/mission-reliability.ts → results/.../reliability.jsonl
11/11: 5 malformed batch shapes rejected w/ typed errors (no panic); 100k-op/3.2MB
batch applies in ~11ms; 1000× mount/unmount 50ms (~50µs/cycle); 10k-event storm
0.5ms; double unmount/flush safe; emit-during-dispatch deferred correctly.

### Accessibility layer — gdom.ts implicit roles + typed aria
- Discovery: QuickGUI dylib ships a full NSAccessibility subsystem
  (QuickGuiAccessibilityState, AX landmark/style-group roles, display-preference
  queries) fed by widget-descriptor labels — but its wire protocol carries ZERO
  aria/role properties. gpuix backend: setCustomProp lands in retained tree
  (verified via getTreeJson).
- nkit already authors role/aria-* on 24+ components (slider/switch/dialog/tabs…).
- Added: IMPLICIT_ROLE map (tag+type→role: button/link/heading/checkbox/slider/
  textbox/list/table…), aria-level for h1-h6, ARIA_BOOL/ARIA_NUM typed coercion,
  dynamic re-emit on type/href change, implicit re-emit on explicit-role removal.
- Verified: src/mission-a11y.ts → results/.../a11y-roles.log — all cases correct.
- Remaining gap: custom props reach the retained tree but gpuix does NOT yet map
  them onto the platform AX tree (NSAccessibilityElement) — transport complete,
  native AX materialization still missing. QuickGUI path would get AX for free
  IF components were expressed as its descriptors — they aren't (nkit → gpuix).

## 2026-09-15 (cont.) — raw-GPUI component-lib direction revived

User clarified the agreed direction: the component library should be REAL
native elements in vendored GPUI — one `x-button` element, not box+text
composites — for op-count collapse + real AX materialization. nkit (JS
composites on gpuix ops) is what exists today; the `native/` sgfx scaffold
(gpui 0.2.2, hello-world main.rs, lock resolved, never built) is the spike.

Build gate: first `cargo build` failed on missing Metal Toolchain → fixed via
`xcodebuild -downloadComponent MetalToolchain` (688 MB). gpui tree compiling
at time of writing. Disk: 18 GiB free (was 29) — dep tree is the risk.

Note: gpuix .node has NO element-registry API — single-element components
require our own NAPI/cdylib surface over vendored gpui. This also unlocks the
AX-materialization gap (Rust-side elements can own NSAccessibilityElement).

## native/ owned renderer — DONE (was "deferred scaffold")

Followed the agreed path: own addon, port gpuix Rust where it earns its keep.

- crates.io `gpui 0.2.2` attempt: **235 errors** — it keeps the embedded-platform
  APIs gpuix needs `pub(crate)` (`MacPlatform::new_embedded`, `with_platform`,
  `run_embedded`, `VisualTestAppContext`, `open_offscreen_window`). Dead end.
- Pinned `remorses/zed` fork `@81c99f8` **via git deps** (no submodule): the
  full ~18k-line port `cargo check`s clean. Needs Rust **1.97.1** — fork's
  `profiler` module uses `cold_path` (unstable on 1.94); `rust-toolchain.toml` pins it.
- `cargo build --release` → `libsgfx.dylib` (23MB) → `.node` → loads in Bun,
  exports `GpuixRenderer`/`TestGpuixRenderer`/`hasTestGpuixRenderer`.
- **Swap test**: copied over `node_modules/@gpuix/native-darwin-arm64/` →
  45/45 + 30/30 + 49/49 + 11/11 — identical on our own binary.
- **`x-button` shipped**: `custom_elements/x_button.rs` — one retained node,
  native variant/disabled/hover/active, `Role::Button` materialized in Rust.
  Verified: paints, `findByType`, real bounds, click event, disabled→0 events.

The element vocabulary is ours now. node_modules currently holds OUR .node —
`bun install` would restore the published one (both pass all suites).

## Rust CVA engine: `recipe.rs` shipped

Decision: variant/style resolution moves into the renderer. The win is the
wire, not the merge loop — JS recipe output was re-serialized per prop
change; now `setCustomProp` carries variant names (~30B) and Rust resolves.

- `native/src/recipe.rs`: same `{base, variants, defaultVariants,
  compoundVariants}` config + resolution order as `nkit/recipe.js`. Produces
  `Arc<StyleDesc>` via serde (same parser as wire styles — identical
  semantics incl. nested hover/active). Cache per effective-variant tuple.
- `x_button.rs` rewritten recipe-driven: variant/size/disabled are declared
  tables, no hardcoded match arms. Verified live: danger+lg → red 44px;
  `variant: ghost` flip = one scalar prop, full repaint.
- `cargo test recipe`: 4/4 (defaults, layering, compounds, nested merge,
  cache Arc sharing). Full suite still 45/45 on our .node.

Convention going forward: every custom element authors a Recipe; variant
props are its `supported_props`; JS `setStyle` remains the override layer.

## Design tokens in Rust: `tokens.rs` + theme prop + color ctx

- `native/src/tokens.rs`: closed token language, svelai-verbatim palettes
  (dark+light hex tables). Grammar: `name[-role][/alpha]` colors; spacing /
  text / radius / control / dimension scales per field kind; ×4 numerics
  deliberately excluded. `with_override({mode,palette,colors,defaultColor,
  scales})` → new theme with unique id (recipe-cache safe).
- `Inherited.tokens: Arc<TokenTheme>`; ANY element's `theme` custom prop
  overrides for self+subtree (nearest-wins, same slot as highlight).
  `CustomRenderContext.tokens` hands it to recipes.
- `Recipe::style(props, tokens, ctx_color)` — merged JSON is resolved
  symbolically → concrete StyleDesc; cache key = (variant tuple, theme id,
  ctx color).
- `x_button` ported to svelai shape: variant = shape (solid/outline/soft/
  ghost/link), `color` = ctx prop → `color-*` refs. Live-verified: themed
  parent restyles subtree; element color prop wins.
- cargo test --lib: 246/246.

Svelte `Theme` façade still TODO (wrapper emitting the `theme` custom prop);
JS `resolveTokens`/`tokens.js` becomes redundant as elements go native.

## 1:1 parity correction + gdom x-* fix (same day, later)

Independent subagent reviews vs /Users/arnaud/code/ai2 caught drift; corrected:

- `tokens.rs`: now PORTS `generateColorPalette` itself — colorizr math
  replicated exactly (HSL-space darken/lighten ±15/±25, rgb2hsl 2-decimal
  rounding, OKLCH toGamut binary search, formatCSS 5-significant-digit
  quantization, WCAG contrast). Hex fixtures byte-exact vs generator output
  under canonical app.css inputs. `mode` = full scheme swap then same-prop
  overrides. Per-scheme state opacities (dark .16/.32, light .05/.10),
  spacing/radius/typeScale FACTORS (fluid type ramp w/ legibility floors),
  `raised`/`lift` pseudo-fields → elevation shadow+border+tint. Unresolved
  tokens drop the field (no serde poisoning); bad `/alpha` → unresolved.
  JSON numbers = raw px; STRING numerics ("4") = ×spacing (class-token
  convention). ctx `color` cascades via `Inherited.color` + setStyle
  resolves tokens against the ancestor theme chain (batch still atomic).
- `recipe.rs`: declaration-order variants (serde_json preserve_order),
  ctx color in compound matching, falsy → default, `ResolvedStyle`
  {style, stateLayer} Arc-cached w/ ctx+theme in key.
- `x_button.rs`: 1/1 svelai — sizes small/normal/large, state-layer overlay
  in currentColor at scheme opacity (group_hover/group_active), focus ring,
  loading/squared/fullWidth, disabled gating, native tab stop.
- `tokens.js`/`style.js` synced: generated light palette (was hand-tuned),
  per-mode state opacities, factor-driven icon/row/hit/indent scales, 13-step
  type ramp w/ floors, elevation stacks, stateOpacity/spacingScale/radius
  knobs. Numeric JS style lanes stay raw px (fixed double-mult).
- **gdom bug**: `gpuixTag()` mapped `x-button`→`div`; added `x-*`
  passthrough so custom tags reach the registry. `probe-xbutton.ts` 7/7:
  mount, control-lg/sm heights (bounds = content box, −2 border), outline,
  disabled, link, zero events under disabled+loading.
- cargo test --lib 253/253; all suites green on rebuilt .node
  (45+30+49+45). Probe file kept at gpuix-poc/src/probe-xbutton.ts.

## Token deferral: Rust is now the single resolver (same day)

Token *vocabulary* crosses the wire, not resolved values — `bg-primary`
emits `{backgroundColor:'primary'}` and the Rust theme chain resolves it.

- tokens.js applyToken / style.js s(): emit token strings for spacing
  (string numerics ×--spacing), geometry (control/row/icon/hit/indent-*),
  text names, radius names, font-weight names, color refs (incl. `/alpha`,
  `color-*` ctx, `surface-*`), ring boxShadow color tokens, `raised`/`lift`
  pseudo-fields, `stateLayer` flag. Literals/statics unchanged (SHADOWS,
  tracking numeric — no StyleDesc letterSpacing field).
- tokens.rs: `spacing_px` += `indent-*`; `bake_state_layer` ports JS
  `overlay()` composite (fg=resolved `color` else neutral-readable;
  hover/active `??=`) — generic elements get the baked overlay, `x-*`
  elements keep the real overlay child via `ResolveOutcome.state_layer`.
- **Found + fixed a real ordering bug**: batch ops run create → setStyle →
  insert, so setStyle resolved tokens against an UNLINKED element (no
  parent chain) → always dark root theme. setStyle is now recorded during
  apply and resolved in a post-pass once every link and custom prop in
  the batch is in place (also fixes same-batch self `theme`/`color` props).
- Theme.svelte emits `theme` custom prop: `{mode, colors, surface,
  ...designTokens[t], defaultColor, viewport}` — Rust with_override
  derives the full theme (registered palette role-maps included) and it
  cascades via Inherited.tokens.
- gdom: `x-*` tags pass through to the custom-element registry (was
  silently downgraded to div — Svelte-mounted x-elements never reached
  native code before; only raw-op probes did).
- probe-theme.ts 4/4: dark/light same-token divergence, ctx color under
  light, state-layer bake. probe-xbutton 7/7. cargo 253/253. All suites:
  45+30+49+45 green on rebuilt .node.

Remaining: styles are resolved at apply-time and interned — a `mode` swap
still needs JS to re-emit setStyle (themeRev bump) since stored StyleDescs
aren't retroactively re-resolved. Making theme swaps zero-cost = mark
subtree dirty + re-resolve — the pending-style list is the seam for it.

## Adversarial review of the theme engine (same day)

Four independent reviewers attacked palette derivation, the JS→Rust
deferral wire, override/cascade semantics, and the x-button recipe vs
svelai CVA+Button — all with live probes against TestGpuixRenderer and the
real svelai source. Full triage: .agent/ADVERSARIAL-THEME.md (46 findings).

Headline P0s:
- x-button `active:{top:1}` (translate-y-px port) teleports positioned
  buttons between mousedown/up → clicks lost. 6/6 missed in probe.
- ctx `color` never emitted by nkit components → `color-*` refs resolve
  neutral; `<Button color="danger">` renders neutral.
- `hex_to_rgb` rejects 8-digit hex → alpha tokens break tint wash /
  state-layer composite / can delete backgrounds.

Also confirmed: interned styles go stale on scoped theme/color changes
(mixed repaint — x-* repaint, generics don't; reparented subtrees keep
wrong colors); raised/lift stomp explicit boxShadow/border; fluid type
ramp unconditional in Rust vs flat-by-default JS; non-6-digit/non-hex
colors silently derive garbage; no keyboard activation on x-button;
disabled x-buttons stay in tab order; loading paints no spinner; ARIA
mappings missing (pressed/haspopup/controls/disabled/busy).

Verified correct under attack: canonical palettes byte-exact, same-batch
theme resolution, nested nearest-wins, scheme-swap semantics, color
precedence, state-layer opacities, atomic batching, overlay cascade, CVA
order/falsy-defaults/cache key, focus ring, inert click suppression.

## Adversarial fix pass (same day, later)

All 46 findings resolved — see ADVERSARIAL-THEME.md "Resolution" for the
per-finding table. Svelai-faithful contract on every open question
(readable overrides ignored, fluid ramp kept, `theme` known-key gate,
native dirty re-resolution implemented).

- `tokens.rs` — the big surface: csscolorparser color inputs (3/4/8-hex,
  rgb/hsl/named, tailwind→500); `with_override` → `Result` with svelai's
  validation (luminance/saturation 0–100, monotonic spacingScale, typeScale
  viewport bounds, unknown presets, defaultColor); `surface-*` routing;
  always-derived readable roles; adjusted neutral base; `js_parse_float`
  lenient alpha; `color=""`→defaultColor; raised/lift `??=` guards +
  invalid no-op + full stacks + ring/inset preservation; per-bucket
  state-layer bakes; gradient-stop color resolution; `currentColor`
  shadow members resolve against resolved `color`; hex lowercase.
- `renderer.rs`/`retained_tree.rs` — `style_raw` retention +
  `retheme_subtree` (theme/color prop change AND reparent re-resolve the
  subtree from stored unresolved styles); `themed()` memo; `data-highlighted`
  eager hover fill; `focus`/`focusWithin`/`focusVisible` buckets wired.
- `style.rs` — `aspectRatio`, `fontStyle`, `textDecoration`,
  `textDecorationColor`, shadow lists + `inset`, focus buckets.
- `accessibility.rs` — every mappable `AriaProperties` field wired
  (pressed/selected/expanded/keyshortcuts/value*/orientation/set indices).
  haspopup/controls/disabled/busy documented fork-blocked.
- `x_button.rs`/`recipe.rs`/`mod.rs` — top-hack removed, Enter/Space
  activation, truthy inert, typed compounds, aria prop translation, href
  link semantics, aspect-square, loading overlay+pulsating spinner,
  occlusion (`block_mouse_except_scroll`), inert skips tab_stop.
- `anchored.rs` — hardcoded `0x1A1A1A` → theme surface.
- JS: `gdom.ts` (`data-color` attr map, `removeAttribute` nativeAttrName,
  `_ctxColorOwned` bridge, `data` setter String coercion — numeric text
  nodes were poisoning batches), `native.ts` (retry wedge → one retry then
  drop), `tokens.js` (focus-within/focus-visible/focus buckets, per-bucket
  ring accumulation — `ring-2 ring-color/50` finally lands the color —
  aspect-square, ms-/me-, w/h-fit, underline/decoration/italic,
  theme-only color pass-through), `style.js` (new prop mappings + ring
  flag + focus buckets + ctxColor stamp), `Theme.svelte` (dt.colors merge
  vs palette clobber), `Button.svelte`/recipe (anchor semantics, squared,
  focusVisible bucket, spinner overlay).

Validation: cargo 253/253, probe-adversarial 27/27 (new), probe-theme 4/4,
nkit 30/30, svelte 45/45, kit 49/49, quickgui 45/45, showcase 25/25,
reliability 11/11. The retry lane surfaced a real latent bug the wedge had
hidden: numeric `setText` poisoning whole batches — fixed at the `data`
setter.

## StyleX-native engine — definition-time validation (post-comparison)

Motivation: gpuix-svelte comparison surfaced that our style engine already
has StyleX *semantics* (styles-as-data, property-level merge, no cascade —
gpui's StyleDesc is natively that shape) but lacked the *definition-time*
discipline: silent runtime drops were the only signal for typos.

- `style.js` — per-call `dropped` collector threaded through `applyProps`;
  `colorOk` gate now matches the class lane (palette resolve OR well-formed
  grammar — literals like `#fff` and scoped-palette names must cross; found
  `bg:'#ffffff'` was silently dropped at RUNTIME in the props lane — switch/
  checkbox knobs were painting without their white bg). `checkStyleProps`
  (grammar tier), `defineStyles` (stylex.create equivalent: validate + deep
  freeze + register), `definitionIssues` registry, `validateDefinitions`
  palette-tier sweep wired into `registerTokenCacheClear` (strict gate:
  literals exempt, bare names must resolve → catches `bg:'primry'` typos).
- `recipe.js` — `recipe(config, label?)` validates every fragment at
  definition (base/variants/compounds), checks `defaultVariants` ⊆ declared
  axes and compound cond keys ⊆ variants, deep-freezes the config, warns once
  per unknown variant VALUE at call time (`size='huge'`).
- `cva.js` — class strings checked via `checkTokens` at definition; issues
  collected silently (lane 'class' — boundary drops like `data-[…]` are
  intentional).
- `card.js` — `cardTheme.title` declared the `color` axis (compounds were
  conditioning on an undeclared variant — worked only via caller vp shape).
- `probe-stylex.ts` — 21/21.

Validation: probe-stylex 21/21, adversarial 27/27, nkit 30/30, svelte 45/45,
kit 49/49, showcase 25/25 — no regressions.

## Brokered platform API — V1 slice live (2026-09-16)

One napi method (`platform_call`), one new EventPayload field (`data`), one
sentinel (`PLATFORM_EVENT_ID` 0x7fffff02) — 16 service namespaces dispatched
through the existing UiCommand/GPUI_APP machinery; no second dispatch system.

- `native/src/platform.rs`: dispatcher + typed error envelopes
  (invalid_args|unknown|unsupported|unavailable|denied|internal). Async ops
  reply `{pending:true,id}` and resolve through a `platformResult` event on
  the existing TSFN. App callbacks (openUrls/reopen/wake/thermal/kbdlayout/
  notificationResponse/willQuit/willRestart) register at init on both the
  macOS-embedded and threaded paths. GpuixView got an appearance observer →
  `appearanceChanged`; PlatformMenuAction → `menuAction` via .on_action seam.
- `gpuix-poc/src/native-api/`: bus (callPlatform/onPlatform/onAnyPlatform,
  initPlatformForTests seam), typed services in index.ts, pure-JS
  windowState.ts. initPlatform wired in main.ts.
- Live probe (mission-platform.ts): 52/53 ok, 0 unexpected failures.
  Keychain write→read→delete roundtrip through the pending path;
  appearanceChanged ×2 through the event path; honest negatives verified
  (javascript: denied, deepLink unavailable unbundled, capture unavailable —
  gpui feature flag off).
- Gotcha recorded: pending ops resolve on the GPUI executor — nothing pumps
  it unless tick() keeps running (probe timed out until a persistent ticker
  was added). setSize/fullscreen read stale until next frame.
- Validation: cargo build --release clean; .node swapped into node_modules;
  16/16 unit tests; 45/45 svelte + 30/30 nkit + 49/49 kit conformance — no
  regressions.

## Reactive platform stores — `#native` (2026-09-17)

`src/native-api/state.svelte.ts` — rune module (compileModule) exposing
`windowStateStore` (live bounds + persisted JSON + ready/saving as $state)
and `appearance` (current/preference/ready + dark getter; subscribes
`appearanceChanged` so OS theme flips update $state with zero polling).
Re-exports the entire service surface → `#native` is the single specifier.

- build.ts: first-party compile list gained `.svelte.ts` support (tsx strip
  → compileModule) + a `native-api/` specifier rewrite mapping `./x` →
  `../../native-api/x.ts` — stores share THE bus singleton (backend set by
  initPlatform once). package.json `#imports` gained `#native`.
- Live-verified in mission-platform.ts: theme.set('light') via the raw
  service flipped appearance.current dark→light purely through the
  appearanceChanged event (54/55 ok, 0 fails).
- Gotcha found in the same run: fullscreen exit takes ~1s (animation) — the
  `off:false` read raced the transition; windowState later read the still-
  fullscreen 2056×1290 size. Documented.
- No public resize/move subscription in the gpui fork (bounds_observers is
  pub(crate)) — live bounds refresh on init/refresh/own calls only.
- 19/19 unit tests (stores covered via #native); 45/45 + 30/30 + 49/49
  conformance re-run green after the build.ts change.
- Follow-up noted: Theme.svelte polls `defaults read AppleInterfaceStyle`
  every 1.5s — the appearanceChanged event/appearance store can replace it.

## Normalized reactive stores (2026-09-17)

Every nullary value-getter in the service layer is now a $state field.
15 stores in state.svelte.ts (#native): appStore, windowStore,
windowStateStore, screenStore, clipboardStore, themeStore (renamed from
appearance), systemStore, powerStore, deepLinkStore, menuStore,
notificationsStore, captureStore, diagnosticsStore, capabilitiesStore,
updateStore. PlatformStore base: ready/error/init. initStores() =
Promise.all with per-store error capture. Event feeds wired: appearance,
kbd layout, thermal, wake, openUrls, menuAction, notificationResponse,
reopened, willQuit, willRestart. Exceptions: secureStorage (secrets never
in reactive memory — user's call), shell/dialog (pure actions),
parameterized queries stay functions.

- Tests: 21/21 (initStores coverage + every event feed asserted).
- Live: 55/56 — all 15 stores ready; themeStore dark→light driven by the
  appearanceChanged event alone; 4 appearanceChanged events observed.
- API rule documented in docs/platform-api.mdx.

## 2026-09-17 — Public API renamed to `svelte-desktop/stores`

User rejected `*Store` suffix + `#native`; the domain names ARE the public
objects. state.svelte.ts → stores.svelte.ts; each namespace is now ONE
merged object: $state fields for nullary getters + action methods on the
same object (app.quit(), app.info, theme.dark, window.setSize). shell,
dialog, secureStorage re-exported verbatim — methods only, secureStorage
is the deliberate no-$state exception (secrets never reactive).

Specifier: literal `svelte-desktop/stores` works today via tsconfig paths
→ gen/native-api/stores.js (+ `#stores` alias); stores.d.ts redirects
type resolution to the .svelte.ts source. main.ts now
`void initStores()` after initPlatform — namespaces self-populate.

Verified: 21/21 unit (imports the literal specifier), Svelte 45/45,
kit 49/49, bundle resolves+inlines stores (120 modules). nkit 29/30 —
c-resizable fails deterministically (rz=50, drag fires, pane won't
resize): the loaded .node (built 23:17) contains the in-flight renderer
memoization work — user-side regression, surfaced not touched.


## 2026-09-17 — typed `on()` per namespace

Each event-fed namespace now exposes `on(event, cb)` — a typed, scoped
wrapper over onPlatform: `theme.on('appearanceChanged', (info: ThemeInfo))`,
`menu.on('menuAction', ({id}))`, `app.on('willQuit'|'reopened'|'willRestart')`,
`deepLink.on('openUrls', ({urls}))`, `notifications.on('notificationResponse')`,
`power.on('thermalStateChanged'|'systemWake')`, `system.on('keyboardLayoutChanged')`.
Payload shapes verified against platform.rs emit sites; empty-payload events
typed EmptyPayload. Namespaces without real platform events (window, screen,
clipboard, capture, diagnostics, capabilities, update) get no `on` — honest
surface, no fabricated events. `app.onOpenUrls` passthrough removed (deepLink
owns openUrls). 22/22 tests.


## 2026-09-17 — self-initializing stores (no await initStores)

User call: importing the module must be enough — no explicit
`await initStores()`. bus.ts gains `onPlatformReady(cb)` (queued until a
backend binds; microtask-deferred if already bound, fired by initPlatform
flush — deliberately NOT by initPlatformForTests: fake transports produce
garbage state; tests init explicitly). stores.svelte.ts registers
`initStores` at module eval → `import 'svelte-desktop/stores'` alone
self-initializes all namespaces the moment initPlatform binds. initStores
now dedupes concurrent calls (shared in-flight promise) and doubles as a
refresh-all; ns.error cleared on each init attempt. main.ts no longer
calls initStores. Verified: 22/22 unit, live probe 55/56 — auto-boot
populated all 15 namespaces.


## 2026-09-18 — Electron-parity gap work (5 parallel agents)

User: "go for it, parallelize with subagents". Five agents on disjoint
files, central dispatcher/delegation scaffolded first so cargo stayed
green throughout:

- Agent A `platform/power_ext.rs` — IOPS battery {percent|null,charging,
  external}; IOPMAssertionCreateWithDescription blockSleep/unblockSleep;
  observers: screenLocked/Unlocked (CFNotificationCenter distributed),
  systemSleep (NSWorkspace), displaysChanged (CGDisplay, 150ms debounce).
- Agent B `platform/tray.rs` + `platform/hotkeys.rs` — NSStatusItem
  set/create/remove/destroy/isSet/exists, menus → menuAction{id}, trayClick
  when no menu; Carbon RegisterEventHotKey with accelerator parser →
  shortcutPressed/shortcutReleased; dup → invalid, OSStatus ≠ 0 → denied.
- Agent C `platform/macos_ext.rs` — dock badge/bounce, activation policy,
  SMAppService login item (unavailable unbundled), single-instance lock
  (NSRunningApplication count; dev → {acquired:true}), accent color (0..1
  sRGB), NSWorkspace a11y flags, trashItem/beep, menu.popup (NSMenu at
  screen coords → menuAction{id}).
- Agent D — gpui CHECKOUT PATCH + window_svc/clipboard/observe_window:
  PlatformWindow::set_position (default no-op), Window::set_position +
  observe_window_bounds (public, mirrors observe_window_appearance);
  gpui_macos impl = setFrameTopLeftPoint y-flipped vs own screen.
  window.getPosition/setPosition/setCloseVeto (armed flag →
  on_window_should_close false + willClose; programmatic close bypasses);
  clipboard read/writeHtml/Rtf via NSPasteboard public.html/public.rtf;
  boundsChanged event (one event, full bounds). Dialog filters: NO
  PathPromptOptions field exists — deferred to a fork addition.
- Agent E — index.ts ops + stores.svelte.ts namespaces (tray/shortcuts
  added → ALL = 17), typed on() maps extended, +19 tests.

Integration: capabilities matrix → macos-only rows; mission-platform.ts +
17 probes; spec/native-api.yaml + docs/platform-api.mdx promoted.

Gotchas hit and recorded:
1. `cp` over a loaded .node → SIGKILL "Code Signature Invalid / Invalid
   Page" (kernel keeps sig pages per-inode; truncate+rewrite invalidates).
   Deploy via temp+mv — new inode. bun install still reverts the swap.
2. MacWindowState is non-reentrant: set_position held self.0 across
   setFrameTopLeftPoint → windowDidMove delegate re-locked → same-thread
   deadlock. Fixed in checkout: read under lock, drop, then msg_send.
3. boundsChanged inside a synchronous platformCall can drop — gpui
   on_moved's re-entrant handle.update hits RefCell-already-borrowed
   (logged+swallowed). Own writes still refresh via #syncLater.
4. clipboard formats/has see only gpui-modeled types — readHtml/readRtf
   work but custom UTIs never list in formats (documented).
5. Editing the gpui checkout needs `cargo clean -p gpui -p gpui_macos
   -p gpui_platform` — cargo ignores vendored mtimes.

Verified: 41/41 unit (was 22), live probe 73/75 — battery {100%,charging,
external}, IOPM assertion id roundtrip, position {768,465}→{808,505}→
{768,465}, boundsChanged ×11, tray set/remove, hotkey roundtrip, badge/
bounce, accent/a11y reads, html/rtf, trashItem, lock {acquired:true};
setActivationPolicy internal-refused + setLoginItem unavailable — honest
unbundled answers. Conformance on patched binary: 45/45, 30/30, 49/49 —
the earlier renderer-memoization regressions are GONE (user's fix landed).

## 2026-09-18 — API plan + Tauri v2 audit

Audited Tauri v2 end-to-end (env vars, all api/* namespaces, plugin list,
ACL capability/permission/scope model) and wrote docs/api-plan.mdx: steals
(mutable menu items, onCloseRequested+preventDefault framing, ~25 AppKit
window ops, permissions-lite for capture/hotkeys/notifications, Channel<T>
streaming args, store KV, dpi types, LAContext Touch ID), rejects (webview
layer, stringly invoke, __TAURI__ global, plugin fragmentation, full ACL),
9-phase queue. roadmap.mdx updated with platform-services check-off.

## 2026-09-18 — virtual-list glitch hunt: RESOLVED (two compounding causes)

The 5000-row demo had an intermittent one-frame jump on hover/click.
Bounds were always clean; the trail led through memoization, paint
replay, hitbox churn, and list anchoring. A 4-agent council mapped the
remaining suspects. Final diagnosis:

1. **live↔leaf width flip (the original -x/width glitch).** Interactive
   row subtrees were memoizable. The cached leaf measured itself at the
   parent's allocated bounds (full list width → pinned 1254px) while the
   live path measured the same subtree as a shrink-wrapped layout root
   (content width ~153px). Every hover/click bumped `subtree_revision` →
   `same_box=false` → live frame → new leaf → replay — flipping the row
   between 153px and 1254px and dragging the `margin-left:auto` badge
   across the row. Fix: `MEMO_HAS_EVENTS` flag in `memo_scan`
   (retained_tree.rs) — any subtree containing a listener never enters
   the cache. Interactive nodes gain nothing from memo anyway; the cache
   exists for static mass content.
2. **estimated-height pitch clamp (the residual 1%).** `gpui::list`
   measures items via `layout_as_root` on their *border box* — root
   margins excluded. Rows were `height:40 + margin:3px` = 40px measured
   pitch, but `estimatedItemHeight:46` assumed the margin-box. On
   `remeasure_items` (every revision bump),
   `pending_scroll.offset_in_item` clamps to the measured height →
   whole-list snap
   ≤6px for one frame, exactly on state changes. Fix: demo now uses
   `height:40 + margin:0 12px`, `estimatedItemHeight:40` — hint =
   measure, no clamp possible.
3. **Supporting: native overdraw > JS window.** `ListState` default
   overdraw 512px ≈ 12 rows > JS `OVERDRAW=8` → `child_at` missed →
   blank `unmounted_virtual_row` placeholders in the overscan band.
   Demo sets `overdraw` prop explicitly inside the JS window.

Also fixed en route: hover-event flapping (enter→re-render→hitbox
reset→re-enter loop, deduped in JS by skipping no-op style writes) and
the bounds watcher (moved into the tick loop, fields are
`x,y,width,height`).

False leads ruled out with evidence: GPUI `entity.cached` replays only
when `cache_key.bounds == bounds` (no stale-position paint); fresh
entity on every memo-key change (no replay across key changes);
`.absolute().w(0).h(0)` marker is out of flow; `apply_styles` maps
margins correctly on both live and leaf paths; text shaping is
deterministic via `line_layout_cache`.

Lesson on semantics: taffy `layout_as_root` shrink-wraps a root
`width:auto` — bare virtual rows are content-width *by design*. The old
full-width look was the leaf-pin artifact. Confirmed by user retest +
per-frame bounds log (clean 40px pitch scrolling, zero unexplained
moves). Durable invariants + remaining hazards written to STATE.md.

## 2026-09-18 — mission 5: Tauri-depth platform API (7 agents, LIVE 124/127)

Orchestrated 7 parallel implementation agents over shared scaffolding
(modules + dispatch tails + nswindow/nsstring/with_window/emit_channel
helpers landed first so cargo check stayed green).

**Delivered:**
- window_ext (~45 NSWindow ops, zero fork — RawWindowHandle::AppKit →
  ns_view → window), events_ext (5 events incl secondInstance via
  NSDistributedNotificationCenter), permissions (6 permission names +
  openSettings + LAContext Touch ID), capture_ext (dlopen-gated
  ScreenCaptureKit — direct, no scap dep), menu_ext (update/get/items,
  ~20 roles, 55-icon whitelist, aboutPanel, tray click rect),
  TS layer (75/75 tests; store/dpi/events namespaces; once/Channel/
  allowlist/mockPlatform; asyncDispose handles), gpui fork filters
  (all 6 impls, setAllowedFileTypes), quickgui worker-exit segfault
  ROOT-CAUSED + fixed (bun patch --commit).

**Integration (mine):** role_menu_item (gpui path: OsAction edit roles +
app_menu action types; added ToggleFullscreen/AboutPanel actions),
apply_item_extras wired into popup builder + tray, notifications
permission aliases, capabilities matrix (45 window ops + all services),
dialog filters wired to PathPromptOptions.filters, setMinSize/setMaxSize
added, probe extended +47 cases.

**Real bugs found by probing:**
- UNUserNotificationCenter raises uncatchable ObjC exception on
  unbundled binaries → C++ abort. Fixed: has_bundle_identity() gate →
  honest `unavailable`.
- Honest errors verified: setFocusable→unsupported, menu.update missing
  →unavailable, capture→unavailable (TCC denied), notifications perm→
  unavailable (unbundled), fullDiskAccess request→unsupported.

**Multi-window blockers mapped** (agent S): FFI notifier outlived worker
VM (fixed via patch); gpuix needs window registry + window_id on
UiCommand/EventPayload + scoped singletons.

**Drag-drop**: zero-fork path confirmed — gpui emits ExternalPaths drops
already; needs view-level on_drop wire only.

Probe: 124/127 ok (0 fails, 3 modal skips). Conformance unchanged:
svelte 45/45, nkit 30/30, kit 49/49. TS: 75/75.

## 2026-09-18 — native stylesheet pipeline + /app boots natively (5-agent build)

The "plugin svelte + CSS→stylex natif" milestone landed in one parallel
push. Verified end state: svelte conformance 45/45, kit conformance
49/49, cargo test --lib 299, plugin e2e 18/18, probe-styled + test-app
green.

**Architecture delivered** — JS normalizes and ships payloads; Rust owns
all resolution:

- `gpuix-poc/src/native-css/parse.ts` — lightningcss (1.33.0) →
  `NativeStyleRule[]` ({sel:[{k:tag|class|id|universal|state}], decls
  verbatim, spec, order}); 66 tests; combinators/attr-sels/pseudo-elems/
  at-rules → warnings, never throws.
- `native/src/stylesheet.rs` (~1700 lines) — StyleSheetRegistry:
  compound-sel matching (tag/id-via-custom_props/class tokens), cascade
  (spec asc, order asc; inline style wins field-wise even inside
  buckets), stylesheet→inline→recipe→setStyleProps deep-merge,
  `parse_decls` port (box/logical shorthands, calc(), var() depth-capped,
  box-shadow layers, named colors), invalidation scoping (class-only
  rules → classed elements; other rules → all; replacement counts old
  rules), multi-state rules skipped at register. 29 tests.
- Ops (tuple + object forms): `stylesheet.register/unregister`,
  `setClass` — gdom `pushClass()` dedupes via `_sentClass`, covers
  className/classList/setAttribute/removeAttribute/materialize/remount.
- Pseudo-states are NATIVE: `.card:hover` → hover StyleDesc bucket →
  apply_interactive_styles → GPUI hitbox/focus — zero JS listeners.
  `needs_focus` ORs `has_focus_bucket`; memo_scan disqualifies resolved
  pseudo buckets (same rationale as MEMO_HAS_EVENTS).
- `build.ts` compiles with `css:'external'` → per-component
  `gen/*.styles.js` registering on import (sheet id = compiled path;
  re-register = unregister+register for HMR).
- `packages/svelte-native/` — vite-plugin-svelte-native (transform +
  virtual manifest + virtual style modules + $app/* shims), adapter.js +
  build.js/dev.js CLIs, README; 18/18 tests incl. headless e2e
  (build→spawn→painted text).
- `app/` boots natively: `app/native.ts` → `main-app.ts` → `build-app.ts`
  (compiles ../app/src → src/gen-app/) → `app-boot.ts` (kit-app.ts
  pattern). Remote fns in-process: `$app/server`→app-compat shim →
  query/command/form/prerender via hooks.handle — sqlite round-trip
  verified. build-app.ts specifier map: $app/*→#kit, #lib/$lib→gen-app,
  .ts→x.ts.js siblings, assets→path stubs; needs experimental.async.
- remote.svelte.js fixed (2 real bugs): firstRun guard on sync
  `loading=true` write (state_unsafe_mutation → infinite
  invalidate→evict→re-query loop at 99% CPU), and `remoteQuery` reads a
  `settled` $state counter synchronously so `{@const x = await q()}`
  re-derives on settle.

**Contracts worth remembering**
- `<style>` in .svelte now compiles to native rules automatically;
  scoped `svelte-HASH` classes ride along as plain class tokens.
- v1 selector support: compound only (no combinators), 5 pseudo buckets,
  no attr-sels/pseudo-elements/at-rules → compile-time warnings.
- Inline `style` attr > stylesheet rules (field-wise, incl. buckets).
- `.css` file imports are stripped — no global stylesheet path yet.
- Batch poisoning caveat resolved: unknown ops previously dropped whole
  batches; new ops now known (45/45).

## 2026-09-18 — Mission 5 review pass + gpui re-entrancy fix

Two independent reviewers dispatched (Rust FFI + TS API). TS reviewer
(bddbd3f2) returned FIX-FIRST with 4 wire-contract lies, an ordering bug,
non-idempotent disposers, and ~25 smaller findings — all fixed:

- Envelopes: isActive bare-bool (window_svc shadow), ignoresMouseEvents→
  {ignored}, isContentProtected→{contentProtected}, capture.isSupported→
  {supported} + store unwrap. Mocks corrected to wire shapes (they had
  encoded the wrong envelopes — tests passed on lies).
- onCloseRequested: subscribe→arm / disarm→unsub ordering + rollback.
- Idempotent asyncDispose via memoized promise on all 3 handles.
- bus: malformed-reply → typed rejection (was sync throw); per-listener
  try/catch; rebind rejects pendings + clears channels.
- stores: simpleFullscreen field (was polluting fullscreen), setSize/
  focus/theme.set/tray.remove state coherence, handler .catch, log caps.
- store.ts: corrupt-JSON→{}, persist().catch, undefined→delete;
  windowState validates all 4 bounds fields.

Also landed: gpui fork update_or_defer — re-entrant AppKit callbacks
(moved/resized/active/hover/layout) no longer drop their notification
when the AppCell is borrowed (retries on foreground executor). Fixed the
'RefCell already borrowed' swallow — boundsChanged streams ~9× more
events now, zero logs. Patch re-exported (29KB).

Tests: 75/75 green. Probe: 124/127 (3 modal skips). Rust FFI reviewer
still in flight.

## Rust FFI review — crash-class findings FIXED (2026-09-18, late)

The scoped FFI reviewer found 3 issues; all landed + verified live:

- **F1 menu.popup RefCell abort** — popUpMenuPositioningItem:'s nested
  tracking loop ran inside the platformCall AppCell borrow; common-mode
  sources pumping during tracking could re-enter gpui → RefCell panic →
  abort. Now an Outcome::Pending op at the service router: menu+target
  retained +1 across the pool drain, tracking runs via cx.spawn outside
  the borrow, resolves {dismissed:true} on platformResult.
- **F2 non-finite geometry** — f64_arg rejects NaN/±inf at the boundary;
  opt_f64 for optional args (popup x/y, dock progress, min/max size).
  Probed: 1e999 → invalid_args (transport degrades it to non-number →
  required args reject, optional args treat as absent — honest both ways).
- **F3 SMAppService** — dlopen ServiceManagement before Class::get, same
  pattern as capture_ext's ScreenCaptureKit gate. The op now reaches the
  bundle-identity guard — live for bundled builds instead of dead.

Verification: cargo check/release clean, .node redeployed (temp+mv),
probe 130/133 ok 0 fails 3 modal skips, tests 75/75, conformance
45/45 + 30/30 + 49/49 unchanged. Zero RefCell/crash signatures.

## 2026-XX-XX — Parent :hover killed by painted children (hit-test truncation)

**Symptom** — `.card:hover` applied while hovering the card's own area, but dropped
as soon as the pointer moved over a descendant (e.g. the `.badge` div with its own
background). CSS `:hover` must apply to the whole ancestor chain.

**Root cause** — `should_occlude()` in `native/src/style.rs` returned true for ANY
element with a non-transparent background, and `build_host_container` mapped that to
`block_mouse_except_scroll()`. In `Window::hit_test` (gpui `window.rs:1089`), a
`BlockMouseExceptScroll` hitbox sets `hover_hitbox_count` to the ids collected so
far — every hitbox *behind* it stays in `ids` (still scrollable) but `is_hovered()`
returns false. Since hitboxes iterate front→back, a painted child truncated ALL
ancestors out of the hover set. The same truncation also suppressed ancestor mouse
listeners (`on_mouse_down`/`on_hover` all check `hitbox.is_hovered`), so the bug
was bigger than the reported style symptom.

**Fix** — narrowed `should_occlude` to overlay semantics: `pointer-events:auto` →
`occlude()` (BlockMouse, steals wheel), `absolute`/`fixed` →
`block_mouse_except_scroll()` (keeps wheel), in-flow → no flag. In-flow painted
children now get a `Normal` hitbox (or none when inert — GPUI only inserts hitboxes
for `hitbox_behavior != Normal` or interactive elements, `should_insert_hitbox`
div.rs:2332). A `Normal` hitbox never truncates: child stays event-targetable AND
ancestors stay hovered — both CSS-correct.

**Accepted trade** — covered *siblings* (negative-margin/overlap in-flow) now stay
in the hover set, where CSS would not hover them. The flat spatial hit test cannot
distinguish "ancestor of the top target" from "unrelated element behind it"; this
is also Zed's accepted semantic (Normal is the default, blocking is opt-in for
overlays). Parent-over-child hover is the common path and was fully broken.

**Verification** — `probe-hover-ancestor.ts` (new): mounts `.card:hover` + painted
`.badge` child, drives `simulateMouseMove` card-padding → badge-center → off-card,
asserts JS `mouseover`/`mouseout` sequence `enter,leave` (JS listeners share the
same `hitbox.is_hovered` predicate as the native bucket). PASS. 300 cargo tests,
45/45 svelte, 49/49 kit, fmt clean.

**Gotcha for future probes** — `simulateMouseMove` dispatches fine, but emitted JS
events ride the TSFN and only land when the Bun loop turns: synchronous
`tick()` loops never see them. Pump with `await sleep()` between moves
(see `pump()` in test-app.ts).

## Rust FFI review round 2 — all findings landed (2026-09-18, late)

Second scoped reviewer (d5b7920b) delivered a deeper pass — 4 more
crash/latent findings + 2 leak fixes, all implemented:

- **getSystemIdleTime wrong value** — eventType 0 is kCGEventNull (doesn't
  track input), not the wildcard. Now kCGAnyInputEventType = u32::MAX.
- **setStyleMask: fullscreen crash** — setStyleMask: on a fullscreen
  NSWindow throws an uncatchable ObjC exception (same guard Electron
  carries). nswindow_is_fullscreen() check added; setResizable/
  setClosable/setMinimizable (via set_style_flag), setTitleBarStyle and
  setDecorations now return `unavailable` in fullscreen.
- **GpuixEventsObserver class collision** — Class::get reuse now verified
  (last_scale ivar + gpuixBackingChanged: method present) or registers a
  pid-suffixed class; set_ivar/get_ivar can't panic on a foreign class.
- **representedObject UTF8String guards** — isKindOfClass:NSString added
  in tray item_action + macos_ext menu_item_action (menu_ext convention).
- **LAContext leak** — released on all early exits and inside the reply
  block after evaluation completes (was intentionally leaked).
- **addObserver name_obj** — released after addObserver: retains it.
- Nits: tray `kind:"submenu"` without children → invalid_args (was a
  dead item); EVENT_SINK poison-safe lock; menu_ext zipper positional
  assumption documented.

Deferred with reason: pending-op timeouts (dialogs legitimately wait
indefinitely — a blanket timeout would break real use), executor-drop
menu/target leak (process is exiting anyway), permissions GCD-block
pools (documented safe on queue threads).

Verification: release build clean, .node redeployed (temp+mv), probe
130/133 ok 0 fails 3 modal skips, tests 75/75, conformance 45/45 +
30/30 + 49/49 unchanged.

## /app demo verification — end-to-end green (follow-up to hover fix)

`bun src/verify-app-demo.ts` drives the real notes app: mount → /about nav →
back → type note (simulateKeystrokes, one token per char + `space`) → Add →
delete via × → counter. **ALL PASS** (6/6).

Two real bugs found + fixed during verification:

- **`form()` data is FormData, not a plain object** — `data.remote.ts` read
  `data.text`; remote dispatch passes raw FormData → field always undefined →
  handler returned `{error:'empty note'}` without inserting. Fixed to
  `data.get('text')`. Same as real kit semantics ('unchecked' → FormData).
- **kit resets the form after a successful submit** — `_submitForm` remote-form
  branch now `form.reset()` when dispatch resolves defined (rejected/invalid
  keeps input, matching kit). Edited in `src/kit/runtime.svelte.js` — the gen/
  output is rebuilt by build.ts on import; never edit gen/ directly.

Verify-script traps fixed en route:
- `painted().includes('native demo note')` matched the INPUT's own text —
  false positive before the FormData fix. Row presence now asserted via the
  per-note × button in the automation tree.
- `simulateKeystrokes('a b c')` — takes space-separated GPUI keystroke names
  (one token per char, `space` for gaps), not a raw string.
- Simulated input events arrive one event-loop turn after dispatch —
  `await sleep()` between simulate* calls (same reason as the hover probe).

Final state: svelte conformance 45/45, kit 49/49, cargo 300/300, parser bun
tests 66, plugin e2e 18/18, verify-app-demo 6/6. Native binary deployed
(temp+mv). sqlite round-trip confirmed: insert + delete + counter all persist.

## vite dev owns the native window (post-restructure)

The dev loop moved inside the plugin: `pnpm dev` / `bun run dev` → `vite dev`
→ `svelteNative().configureServer` → `createDevSession` (emit → `vite build`
→ spawn `.svelte-native/app.js` → watcher → rebuild+restart). Child PID swaps
on rebuild; old process survives a failed rebuild. `vite build` emits the
same bundle through the plugin's `config` hook. `dev.js` CLI remains but is
no longer the primary path. `app/native.ts` is now a `bun run dev` shim.

Fixed in this pass:
- `paths.js` repointed to the packages/ split (packages/gpuix/src/*,
  packages/svelte/kit/*); tests updated off the removed GPUIX_POC export.
- `$app/server` shim exports query/command/form/prerender.
- `experimental.async` + consumer compilerOptions pass through
  svelteNative({compilerOptions}) — plugin-owned keys (generate/css/dev)
  stay authoritative.
- `bun:` specifiers externalized in the SSR build.
- Entry-emission race: buildNativeApp emitted its entry (headless/
  rendererClass) then the plugin's config hook re-emitted app.js with
  defaults mid-build → windowed bundle never exited (e2e 60s timeout).
  SVELTE_NATIVE_ENTRY_WRITTEN env flag marks the entry written; config()
  computes paths without re-emitting. e2e 412ms.
- `config()` must stay SYNC — tests (and vite's merge) call it without
  awaiting; async made conf.resolve undefined.
- toImportSpecifier emits absolute fs paths (not /@fs/ — rolldown can't
  load dev-server protocols in vite build).
- e2e fixture symlink setup: lstatSync + replace-on-broken (existsSync
  follows links and misses stale symlinks → EEXIST).
- `@gpuix/native` resolves to the fixture's self-hosted copy via
  GPUIX_NATIVE (the only complete JS wrapper in-repo post-split).

Verified: bun run dev → window; touch src/lib/data.remote.ts → rebuild
(~80ms) → PID 74714→74969; bun test 18/18.

## 2026-09-18 — Monorepo restructure (gpuix-poc → packages/*)

**Layout.** Dissolved the gpuix-poc monolith into a bun-workspaces monorepo:
`packages/gpuix` (Rust crate + gdom/native/native-css/nkit runtime),
`packages/platform` (platform API + spec), `packages/svelte` (kit runtime,
app-compat, remote module, build orchestrators, svelte-native plugin),
`packages/tests` (all conformance/mission/probe/showcase content),
`experiments/` (abandoned shell + native-core + codegen), `app/` stays at
root as the live demo. `@svelte-desktop/{gpuix,platform,svelte}` package
specifiers via workspace symlinks + exports maps; per-package `gen/` trees
siblings of src/; `#kit`/`#remote`/`#stores` resolved per-package imports.

**Import rewiring.** Hand-written code uses package specifiers; generated
code gets them emitted by build.ts (svelte-client shim, native-css register,
native.ts/gdom reach-backs — depth math deleted). svelte deep paths go
through each package's own node_modules (isolated linker — root is sparse).
node binding: one canonical `.bun/@gpuix+native` location all symlinks hit.

**qg-backend grew a stylesheet mirror** — JS sibling of the Rust registry
(compound match, spec+order cascade, inline-wins, base bucket only) so
component `<style>` sidecars resolve on the headless backend again (the
pipeline had moved rules off the legacy classRules path → stylecss regressed
to 44/45; back to 45/45).

**Verified from new layout:** 75/75 tests, 45/45 svelte, 30/30 nkit,
49/49 kit, 45/45 qg, 25/25 pages, 130/133 live probe (0 fails, 3 modal
skips), app boots + paints. Circular gpuix↔svelte dep is honest.

## plugin moved to packages/vite (@svelte-desktop/vite)

The vite plugin is a top-level workspace package now — the flat packages/
taxonomy (gpuix/platform/svelte/tests/vite). Name changed
svelte-desktop-native → @svelte-desktop/vite; app's vite.config + package.json
updated (workspace:*). paths.js depths one level shallower (PACKAGES=..,
REPO_ROOT=../..). runtime/_kit.js + server.js cross-package imports switched
to @svelte-desktop/svelte/* package specifiers (AGENTS.md convention — the
deep relatives broke on both moves). @svelte-desktop/svelte added as a real
dependency. Verified: bun test 18/18 in packages/vite, bun run dev → window,
edit → rebuild → PID swap.

Gotcha: a vite dev started BEFORE the move holds the old plugin in memory —
its PKG_DIR points at the deleted path; restart it or the next rebuild fails.

## vite dev → real HMR (ModuleRunner over ws, no process restart)

dev-session's build→spawn→restart loop is replaced for `vite dev` (dev.js
CLI keeps it — no server to run a transport). New architecture:

- `environments.native` — real DevEnvironment, consumer:'server',
  resolve.builtins node:*+bun:*+@gpuix/native, resolve.external
  ['@gpuix/native'], dev.createEnvironment → DevEnvironment with hot:true +
  a custom HotChannel (createWsHotChannel — HotPayload JSON over ws).
- configureServer binds `ws://<local>/$HMR_WS_PATH` on server.httpServer's
  upgrade, emits the entry + dev.json {wsUrl, entry}, spawns
  runtime/host.js under Bun via startNativeHost (supervised respawn).
- runtime/host.js — ModuleRunner + createWebSocketModuleRunnerTransport
  (Bun's global WebSocket client). Reconnects on close by re-reading
  dev.json (port can move). Retries entry import on update payloads when a
  previous eval failed.
- emit.js entry is now remount-safe: globalThis.__svelteNativeHost holds
  renderer/teardown/router/gen; callback dispatches via host.dispatch (the
  renderer cb outlives realms). teardown = unmount(catch async rejection) +
  doc.body child removal + flush. Route restored from old router history.
  gen guard kills superseded tick loops.
- transform compiles .svelte with hmr:true in dev → self-accepting
  $.hmr(Component) swaps.

Verified live: .svelte edit → `hmr update` in place; .ts edit → boundary
pages self-accept; kit runtime edit → `page reload`→`program reload` →
module-graph reload → remount on SAME process (pid unchanged). ws dep
added (vite loads plugins under node, not bun). Traps fixed:
server binds [::1] only → wsUrl from server.resolvedUrls.local (127.0.0.1
refuses); fetchModule externalizes only BARE specifiers → resolveId/alias
pins for @gpuix/native gated to build (abs-path inlining → CJS require
dies); unmount's async-boundary rejection was unhandled → .catch attached.

## 2026-09-19 — M1 correctness + M2 interaction + M3 multi-window

**M1 (Agent A, reviewed):** `reveal_virtual_list_ancestor` now computes the
ListState logical index as `window_start + position-in-materialized-window`
(was passing a raw offset array → jumped to top). `scroll_virtual_list_to_item`
queues via `PENDING_VIRTUAL_LIST_SCROLLS` applied during the next build —
`visibleRange` no longer emits before the anchor moves. Silent programmatic
scrolls now emit via a per-frame mirror sweep: `REPORTED_VIRTUAL_LIST_TOPS`
dedup key `(item_ix, offset_bits, viewport_height_bits)` shared between gpui's
wheel-path handler and the sweep → no double-report, dead lists `retain`ed out,
pending scrolls cleared one-shot. qg-backend grew pseudo-state buckets
(hover/active/focus/focusWithin/focusVisible) + retraction on re-resolve.

**M2 (Agent B + me):** fileDrag* wired end-to-end — gdom maps
drop→fileDrop / dragenter→fileDragEnter / dragover→fileDragOver /
dragleave→fileDragLeave with synthesized `dataTransfer` (types:['Files'],
frozen {name,path} files, getData('text/uri-list')). Rust side: one
`on_drag_move::<ExternalPaths>` hook per element drives the trio; enter/leave
synthesized by diffing a per-view `file_drag_target` cell (gpui has no leave
callback — no-drop sessions leave the last element logically inside until the
next drag; documented). `fileDrop` arm emits a pending leave first. Theme.svelte
subscribes `appearanceChanged` via `onPlatformEvent`, kills OS polling after
first event, keeps one-shot native reads at init + polling as fallback.
Tradeoff (documented): reduced-motion freezes too — no a11y-changed event exists.

**M3 (Agent C + me):** real multi-window on macOS.
- Rust: `WINDOWS` registry (id→{handle,label,close_veto}), `NEXT_WINDOW_ID`
  monotonic, `RENDERER_STATE` shared (tree/callback/selection). `GpuixView.
  window_id`; every event stamped by a wrapped callback (emit sites untouched).
  `Drop` → roots[w] remove + registry remove + `platform:closed` (try_with —
  TLS-teardown safe). `apply_batch_to_tree` → `BatchOutcome{destroyed,windows,
  global}`; destroy/reparent resolve `window_of` BEFORE mutation; per-window
  `notify` only on touched windows + `invalidate_element_window` for
  element-scoped scroll/reveal ops.
- Dispatch: `args.windowId` validated (non-neg int; float/string →
  invalid_args — no silent truncate) → `update_window_in(id)` runs the whole
  dispatch inside the target window's update → every view_window op is
  window-scoped for free. App-scoped `window_svc::call_app` handles
  create/list/get without a live window. `get` miss → null (lookup, not
  assertion). Duplicate label → invalid_args.
- create: `cx.open_window` (label/title/x/y/w/h/resizable/focus/show/
  titlebarTransparent) → `GpuixView::new(id,…)` → `observe_window` → registry
  insert → `created` event → `{windowId,label}`. `observe_window` + events_ext
  observers tag windowId on bounds/appearance/willClose/focus/scale events.
- TS: `windows.{create,list,get,focus,close}` + optional trailing windowId on
  every existing op; `emitTo(w,ev,p)`/`onWindow(w,ev,cb)` (data.windowId
  filter); `onCreated/onClosed/onCloseRequested`. gdom `windowRoots` map,
  `createWindowRoot/destroyWindowRoot`, setRoot trailing windowId (primary
  wire output unchanged), `closed` → destroyWindowRoot. `events.emitTo` now
  routes numeric ids via real platform emitTo ('main'/'0' stay local).
- Probe `probe-multiwindow.ts` PASS: create→{windowId:1}, list [0,1],
  get(label)→info, createWindowRoot mount+paint, emitTo/onWindow scoped,
  close→closed{windowId:1}+registry teardown, list drops, get→null,
  re-create→fresh id 2, last-close→clean exit 0. `window not found` ERROR
  logs on close = gpui `.log_err()` on pending notify effects hitting the
  removed window — benign upstream teardown noise.
- Ops verified: setTitle→view.window_title+set_window_title+refresh;
  focus→activate_window; setCloseVeto→registry Cell read by
  on_window_should_close (programmatic close bypasses — JS close IS the
  decision; documented).

**Deploy note:** `cp` of the .dylib into node_modules invalidates the Mach-O
signature at fault time → `SIGKILL (Code Signature Invalid)`. Fix: re-sign
ad-hoc after every deploy — `codesign --force --deep --sign - <node files>`.
Added to the redeploy runbook in AGENTS.md.

**Suites:** 84 platform tests, 45 svelte, 30 nkit, 49 kit, 45 qg, 25 pages,
13 filedrop+theme-event, multiwindow probe — all green.

## Multiwindow adversarial round 2 — probe hardening + 4 real bugs
- probe-multiwindow.ts grew 14→26 assertions: created-event payload, real
  simulated clicks both windows, secondary bounds+focus, dup label,
  non-positive dims, fractional/dead windowId, emitTo(0), post-close
  element death, monotonic re-alloc, clean exit.
- NEXT_WINDOW_ID allocated before dim validation → rejected creates burned
  ids (probe saw 4 vs expected 2). Validation now precedes allocation.
- GpuixView::new took `clock` but hardcoded ::new() in the struct body —
  shared clock never landed. Fixed; one Arc across RENDERER_STATE+views.
- gdom `materializeRoot` never replayed root attrs/_customProps/listeners —
  root `setAttribute('tabindex')` vanished (no nativeId at set-time).
  Extracted shared `emitElementProps`; root props now land like children.
- simulate_* ops hardcoded window 0 → optional trailing windowId (default
  = active window — where real input lands).
- getFocusedElementId semantic: KEY window's focused element. Focus needs
  `windows.focus(id)` first — probe asserts this directly.
- Full verify: 45/45 svelte, 30/30 nkit, 49/49 kit, 45/45 qg, 25/25 pages,
  212/0 bun tests, probe 26/26 + clean exit.

## 2026-09-15 — adversarial review + hardening pass

Adversarial review of vite-plugin HMR, gdom event handling, DevTools, and
resize/render perf. 5 parallel reviewers → 30+ findings → 16 fixes implemented.

### vite-plugin HMR (host.js, vite-plugin.js, dev-session.js, emit.js)
- Boot race: gate `runner.import()` on WebSocket open + `transport.connect()`
- Stale socket: generation-tagged close listener + `transport.disconnect()`
- WS auth: random token in dev.json, upgrade rejected on mismatch
- Respawn on clean exit: `code === 0` → no respawn; spawn error handler
- `vite:invoke` listener accumulation → `close()` clears listeners
- Route invalidation → native env's `moduleGraph` + `full-reload` message
- Stylesheet stale cache → invalidate virtual module after `transform` update
- `resolvedUrls` null at `listening` → derive URL from `httpServer.address()`
- SIGINT handler accumulation → remove on `close()`, re-raise after cleanup
- Remount guard: gen/dispatch/teardown sync before `await router.start()`
- `allocId` collision → persist `nextId` on `globalThis.__svelteNativeHost`

### gdom (gdom.ts, native.ts)
- `hasStateRules` → per-element `_hasStateRule` (was: any stylesheet :hover →
  every element gets pointer listeners → kills subtree memoization)
- `_active` sticky → clear on any `mouseup`, not just matching target
- `removeEventListener` never emitted `false` → native listener leak
- `dematerialize` O(nodes × total_events) → keyed by `nativeId`
- `drainAfterRender` crash on closed window → try/catch guard
- `frameStats` crash on uninitialized renderer → try/catch guard

### Rust renderer (renderer.rs)
- `theme_for_element` fresh `TokenTheme::dark()` per element → thread_local
  `ROOT_THEME` Arc (memoization actually hits now)
- `setRoot` orphan leak → destroy replaced root's subtree
- `Mutex::lock().unwrap()` → `unwrap_or_else(|p| p.into_inner())` (3 sites)
- Title update every render (~120 AppKit calls/sec during resize) → cache

### DevTools (DevTools.svelte, devtools-state.svelte.ts)
- APFS filename collision: `devtools.svelte.ts` → `devtools-state.svelte.ts`
- `initDevTools` idempotent (multi-mount safe)
- Array caps: burst overflow → clamped before flush
- `Request` method detection: `input.method` for `Request` objects
- Sparkline: `<svg>` children not rendered → `use:nativeProps` + source string
- FPS metric: raw painted frames = 0 on idle → show frame times instead
- `console.warn` → `$state` → re-render → `console.warn` loop → plain array
  buffer + interval flush (breaks sync cycle)

### Pipeline + docs
- `app/main-app.ts` tick 8→16ms (matches emit.js, halves render rate)
- `emit.js` target style: fixed 900×640 → flex column (flexGrow fills window)
- `blume.config.ts`: removed `navigation.actions` (unsupported in 0.5.4)
- Stale `docs/` → `documentation/` refs in spec, README, AGENTS, agent state
- `gpuix-poc/` and `spec/` path refs fixed in published docs

### Verification
- `cargo check` — clean (455 warnings, 0 errors)
- `bun run test` — 84/84 platform, 45/45 svelte, 30/30 nkit, 49/49 kit,
  45/45 qg, 25/25 pages — all green

## 2025 — lint/strict cleanup + ambient $app types (continued)

### gdom.ts + native.ts — all strict errors fixed (~40)
- `dispatchEvent(GEvent | GEventBase)` — internal `GEventListener` type;
  `EventListener` stays at the public add/remove boundary (caller compat),
  cast `as unknown` into the store (fake-DOM boundary, can't express truth
  more accurately)
- `override` on every `nodeType`/`cloneShallow` (GText/GComment/GFragment/
  GElement/GDocument); removed misplaced `override` on getBoundingClientRect
- `_className` `private` dropped — matches the file's `_`-internal convention
- `noUncheckedIndexedAccess` fixes: regex captures guarded (`m[1]`/`x[1]`/
  `a[1]` — flatMap + explicit undefined checks), `toNumber(v: string|undefined)`,
  native bindings declared as fixed-length tuples (`[number,number,number]`)
- `GFormData.append` — `declare append: FormData['append']` (union-typed base)
- `getPropertyValue` proxy trap — was UNREACHABLE (string-key branch shadowed
  it) → reordered; real runtime bug fixed alongside the type error
- `__kitGoto` typed as callable global; `parseInt(el.tagName[1])` guarded
- DOM-lib shapes absent under `lib: ESNext` declared locally:
  `MutationObserverInit`, `FrameRequestCallback`, `requestAnimationFrame`,
  `Animation`

### Package exports — extensionless targets fixed for tsc
- `./*` → `./src/*` produced extensionless targets tsc can't resolve.
  New maps: `"./*.js" → "./src/*.js"`, `"./*.ts" → "./src/*.ts"`,
  `"./*" → "./src/*.ts"` in gpuix + platform package.json.
  Bun + tsc both resolve all specifier shapes now.

### Ambient $app/* types — plugin-owned, generated, hidden
- `emit.js` emits `.svelte-native/ambient.d.ts` on every boot — real
  signatures verified against runtime.svelte.js (query/command/form generics,
  RemoteResource/RemoteForm, page/navigating shapes, manifest virtual module)
- `app/src/app.d.ts` references it via `/// <reference path>` — the kit
  pattern (app.d.ts is the standard ambient host; generated file stays hidden)

### Misc real bugs fixed en route
- `stores.svelte.ts` — `isSimpleFullscreen` returned `{simpleFullscreen:bool}`,
  field got the object → unwrapped `.then(r => r.simpleFullscreen)`
- `build.ts` shadcnAlias `m[1]` undefined guards
- `params/hex.ts` param typed
- `parse.test.ts` cases tuple typed
- `devtools-state.svelte.ts` — `oldest` guard, `fetch.preconnect` preserved
  via Object.assign, `Parameters<typeof fetch>[0]` instead of RequestInfo

### Result
- **0 errors in all non-test source files** (was ~50 in gpuix/platform/app)
- Remaining ~264 errors are pre-existing strict debt in `packages/tests/*`,
  `vite/test/*`, `*.test.ts` — untouched, separate cleanup
- `bun run test` — still all green (84/84, 45/45, 30/30, 49/49, 45/45, 25/25)
- `bun run dev` — clean boot, no ws.send errors, host stable

### Root sizing — app fills window by default
- Emitted target style: `display:flex;flex-direction:column` → added
  `width:100%;height:100%` — the Rust wrapper is `size_full` but the
  target stayed content-sized; percentage resolves against the definite
  wrapper box.

## App-owned titlebar (window chrome ownership)
- `WindowOptions.app_owns_titlebar_drag` (napi `appOwnsTitlebarDrag`) →
  gpui `app_owns_titlebar_drag` — content view claims titlebar hit-testing:
  no AppKit auto-drag, no double-click disambiguation delay on strip clicks.
- `windowDrag` custom prop in build_host_container — Zed titlebar model:
  mouse-down arms a shared `window_drag_arm` flag, first move still holding
  the button calls `Window::start_window_move`; up/down-out disarm. Plus
  `window_control_area(Drag)` for Windows/Linux hit-testing.
- gdom: `data-window-drag` attr → `windowDrag` prop (NATIVE_ATTR +
  bool-value coercion like autoFocus).
- emit.js emits `titlebarTransparent: true` + `appOwnsTitlebarDrag: true`
  by default (ENTRY_KEYS: both + trafficLightX/Y are svelteNative() opts).
- app/+layout.svelte: `.shell` → column; `.titlebar` strip (38px,
  data-window-drag, 84px traffic-light gutter) + `.body` row.
- cargo check/build clean; dylib redeployed + codesigned; emitted
  .svelte-native/app.js verified carrying the flags; all suites green.

## `{@attach}` native style attachments (Svelte 5.29 shape)
- `s()`/`recipe()`/`mergeStyleDesc` envelopes are now **callable attachments**
  — `<div {@attach card}>` applies through `gdom`'s `styleProps` prop and
  returns cleanup that clears `_nativeEnv` on teardown/re-run.
- `envify(fields)` in nkit/style.js: `const env = (el) => { el.styleProps =
  env; return () => el.styleProps = null }` + `Object.assign(env, fields)` —
  `__native/__frags/__recipe/__ctx` stay own props on the function so
  `isNativeStyle`, merge, and `applyStyle` lanes all keep working.
- Three lanes on one value: `{@attach env}` (primary), `{...env.style}`
  (spread → non-enumerable `style` view → `styleProps` prop),
  `use:applyStyle={env}` (legacy action).
- gdom: `styleProps` get/set → `applyNativeStyle`; `setAttribute`/
  `removeAttribute('styleProps')` route the same lane and accept functions.
- `NativeStyle` d.ts gained a call signature `(el) => void | (() => void)`.
- New e2e case `cases/attachstyle.svelte`: `{@attach env}` + probe attach
  asserts `el.styleProps === env` → paints `a=yes`. Svelte conformance
  45→46/46. Unit lane coverage in tests/style-spread.test.ts (8 tests).
- NOTE: svelte's `attach()` runs `fn(node)` inside a deferred render
  `effect` — attachments are not synchronous at mount; `_nativeEnv` lands
  on first flush, replayed by `emitNativeEnv` at materialize.
- Suites re-verified: svelte 46/46, nkit 30/30, qg 45/45, kit 49/49,
  pages 25/25, bun test 220/220.
- recipe `color` axis: direct `recipe(...)({color})` calls now feed `__ctx`
  too (`__ctx: rest.color`) — the variant tuple already carried it for
  compound matching, but `color-*` refs resolve against the element's
  `color` custom prop, which only `s(props, ctx)` set. Direct
  `{@attach buttonTheme.root({color:'danger'})}` now tints correctly.
  recipes.mdx gained a "Using a recipe" section (`{@attach
  buttonTheme.root({variant, size, color, disabled})}` + slot-bag/`slots()`
  explanation). style-spread 8→9 tests; bun 220→221.

## recipe() → multi-slot (tailwind-variants) shape
- `recipe(config)` is now overloaded: a `slots:` map → one shared variant
  tuple drives every slot; no `slots:` → existing single-slot RecipeFn.
  Implemented as definition-time decomposition into per-slot recipe
  registrations (`name.slot`) — zero Rust changes, same ~30B tuple wire.
- Variant values are slot-maps `{axis: {value: {root: frag, icon: frag}}}`;
  slots unstyled by a value get `null` markers (axis still declared →
  compounds match shared axes on every slot). Compounds gain tv's
  `slots: [...]` shared-style targeting alongside slot-mapped styles.
- Call: `theme(props)` → `{slot: (extra) => env}` — `{@attach s.root()}`,
  `s.root({style})` per-slot escape. `ct.slot`/`ct.root` accept a
  multi-slot recipe via the `__slots` marker (per-slot bags still work).
- `recipes/button.js` migrated as the reference (root/prefix/suffix share
  the `size` axis); Button.svelte now passes `buttonTheme` whole.
- recipe.d.ts: `recipe()` overload — `SlotRecipeConfig<S,V>` →
  `SlotRecipeFn<S,V>` (`__slots`/`__recipes` metadata).
- recipes.mdx rewritten: multi-slot shape first, single-slot second,
  `slots()` documented for per-slot-axes edge cases.
- Tests: style-spread 9→13 (slot decomposition, shared tuple, per-slot
  extras, attach lane). bun 221→225; nkit 30/30 re-verified post-migration.

## s() → style() rename + style-in-recipe composition
- `s()` is now `style()` — canonical export in nkit/style.js; `s` remains as
  a re-export alias (`export { style as s }`). ~160 call sites swept across
  src/nkit, tests, docs. Collision: 49 components destructure a `style`
  prop — renamed destructures to `style: instStyle` (ct.slot's own name).
  Gotcha: macOS BSD sed has no `\b` — `[[:<:]]` required; and `import`
  lines need exclusion from shorthand-attr patterns.
- style() envs now unwrap to their frag stream in EVERY recipe frag
  position (fragOf in recipe.js): base, variant values, slot-mapped
  values, compound styles, the per-call `style:` escape. Multi-frag envs
  (mergeStyleDesc results) collapse ordered via mergeProps — null retracts,
  pseudo buckets merge. In multi-slot recipes an env variant value applies
  to every slot; a slot-map picks per slot. An env compound style applies
  to all slots.
- recipes.mdx: "Composing style and recipe" section documenting all of it.
- Tests: style-spread 13→17. bun 225→229; svelte 46/46, nkit 30/30,
  qg 45/45, kit 49/49, pages 25/25.

## External-resize lag: runloop service + resize coalescing
- Symptom: huge lag on third-party window-manager resizes (Swish). Root
  cause was two compounding gaps vs Zed's NSApp.run, confirmed by sampling
  + A/B measurement (not guesswork):
  1. `pump_events` serviced the CFRunLoop ~µs per 16ms JS tick, so AX MIG
     writes only dispatched inside that sliver — each
     `AXUIElementSetAttributeValue` blocked ~16ms waiting for a tick.
  2. Each `set_frame_size` ran the resize callback inline →
     `flush_effects` → synchronous `Window::draw` (full taffy layout +
     Metal draw + waitUntilScheduled) *inside the AX handler*.
- Fix (gpui-fork.patch, section 4):
  - `pump_events(wait_seconds)` → `CFRunLoopRunInMode(mode, wait, false)` —
    each `tick(16)` is now a bounded NSApp.run slice; sources dispatch on
    arrival. `renderer.tick(wait_ms?)` optional arg; `tick()` default 0
    keeps tests nonblocking.
  - `resize_pending` flag: non-live-resize `set_frame_size` only does
    `super.setFrameSize` + arms the display link; `take_pending_resize`
    applies drawable size + resize callback at the *latest* size, consumed
    by `step` (vsync) or unthrottled `display_layer`. Storm → ≤1
    drawable-realloc + draw per frame at the final size. Live-resize
    (edge-drag) path untouched.
- emit.js: generated pump loop calls `host.renderer.tick(16)` with
  setTimeout floor 1ms.
- Measured (40 rapid AXSize writes): AX total 649ms → 28ms; settle
  6.4s → ~1ms. Zed same storm: 16ms writes, 2.8s settle — we're now
  faster than Zed on this path because the frame applies instantly while
  the draw coalesces to vsync.
- Gotcha: cargo treats git checkouts as immutable — `cargo clean -p`
  removes 0 files; delete `target/release/deps/*gpui_macos*` +
  `.fingerprint/gpui_macos-*` to force rebuild.
- Verified: cargo build --release clean, dylib deployed+codesigned,
  patch re-exported, bun test all green (platform 84, svelte 45, nkit 30,
  kit 49, qg 45, pages 25), sample shows ~10 draw samples per 40-write
  storm (was: draw dominated).

## Titlebar double-click + no-drag for interactive descendants

- `data-window-drag` regions restore the native titlebar double-click:
  `on_mouse_down` checks `click_count == 2` → `Window::titlebar_double_click()`
  (honors `AppleActionOnDoubleClick`; the second press never arms a drag).
- Interactive children inside a drag region are no-drag by derivation
  (Electron `app-region: no-drag` model). Two gpui-native mechanisms:
  - `pressTarget` custom prop → element attaches a first-registered
    `on_mouse_down` that calls `cx.stop_propagation()` — fires after its
    own listeners (bubble = reverse paint order) and before ancestors',
    so the region's drag/zoom handlers never see the press.
  - Focusable controls (input/textarea/x-button + tabIndex/focus-event
    elements) don't need it: their `track_focus` mouse-down calls
    `window.prevent_default()`, and the drag handler checks
    `window.default_prevented()` first.
- `pressTarget` is emitted by gdom (`isPressTarget`): interactive tags
  (SUMMARY/LABEL), interactive implicit/explicit roles, contenteditable,
  own activation listeners (el.listeners), and delegated handlers read
  from `el[Symbol('events')]` via getOwnPropertySymbols — `element.events`
  can't be used because delegated types are backfilled onto EVERY element.
- Verified: probe-titlebar-nodrag.ts drives real CGEvents — button dbl
  → count+2, no zoom; input dbl → no zoom; title div dbl → zoom+restore;
  live app same (delegated $.delegated path). bun test all green.
  Synthetic leftMouseDragged can't drive performWindowDrag (AppKit reads
  the hardware tap) — drag-move verified manually.

## theme() — the app-level theme as a function call (setTheme op)
- `theme(options)` in nkit/theming.svelte.js — call at component init:
  builds ThemeState, provideTheme for descendants, OS/system detection,
  persistence, window-event registry, and ships the resolved declaration
  straight to Rust — NO wrapper element, NO {@attach} needed. Returns the
  reactive ThemeState (`app.resolvedTheme`, `app.theme = 'light'`).
- New `setTheme` batch op: stores the declaration on RetainedTree
  (theme_decl) — theme_for_element seeds the ancestor fold from it, so the
  app theme needs no element carrier. Element-level `theme` custom props
  still fold ON TOP (the scoped lane). Retheme covers every top-level
  element; elements created later resolve the decl at create time.
- <Theme> stays as the scoped-subtree lane — slimmed to ~120 lines on top
  of setupScopedTheme() (setupTheme without the global emit); its element
  still carries `theme`/`data-theme`/`colorScheme`/`reduceMotion` props +
  the opacity-dip transition + children(th) snippet.
- qg-backend mirrors setTheme (stores themeDecl for inspection).
- Verified: rust renderer tests 26/26 (+set_theme_seeds_the_ancestor_fold:
  pre-element retheme, post-decl create, scoped-prop override, prop-clear
  fallback), svelte 47/47 (+themefn case: theme=dark ctx=same through real
  init+context), nkit 30/30, qg 45/45, kit 49/49, pages 25/25, bun 230/230
  (+theme-event setTheme op assert: mode/dark + ctx provision).
- Naming note: `theme` the function vs `theme` the custom prop vs
  `data-theme` attribute — same word three lanes, consistent with svelai.

## Nested theme() — scoped lane without use:/attach

- Scoped-theme docs purged of `use:` — the lane was always a plain
  `theme={…}` attribute (gdom routes it to `setCustomProp`); `use:` was
  never needed. Raw non-string attr values now survive gdom's
  materialize/replay (`_rawAttrs` side-map — was stringified to
  "[object Object]").
- `theme()` nested under an existing theme context = scoped lane:
  `getContext(KEY)` read *before* `provideTheme` → skips the global
  `setTheme` emit and the persistence lane (`persistPath` gated on
  `emitGlobal`), provides its own ThemeState to descendants. `t.decl`
  getter exposes the reactive declaration — one `theme={t.decl}` attr on
  the subtree root scopes native token resolution (element-ancestry fold;
  a function call can't claim "the elements my component renders" — Svelte
  has no component-root concept).
- Verified: bun 231/231 (+nested op-capture test: parent's setTheme ops all
  carry dark, child paints light via context), svelte 48/48 (+themenested
  case pair: parent theme() dark + nestedtheme.svelte child theme() light),
  nkit 30/30, qg 45/45, kit 49/49, pages 25/25, platform 84/84.

## Council review — adversarial pass over the titlebar/resize/runloop work

Four read-only reviewers (renderer.rs, gpui fork, gdom.ts, cross-cutting)
audited the app-owned titlebar, pressTarget, pump_events and programmatic
resize work. Fixes landed, verified, documented:

- **C1 — click-to-focus regression (fixed).** The press guard originally
  included `focus_handles`, but gpui registers the focus-transfer listener
  BEFORE mouse_down_listeners drain → in reverse bubble it fires LAST →
  the guard's stop_propagation killed window.focus() for every
  tabindex/focusable host element. Guard is now `!is_window_drag &&
  pressTarget`; focusable elements rely on their own prevent_default()
  which the drag handler checks.
- **Guard scoped to drag-region descendants (fixed).** Was a global
  stop_propagation that suppressed window-level consumers (text-selection
  clear/drag listeners on the reset canvas run LAST in bubble). The guard
  now walks ctx.tree ancestors at press time and only stops propagation
  when a real windowDrag ancestor exists — zero collateral outside drag
  regions, survives dynamic attr changes.
- **window_drag_arm leak (fixed).** on_mouse_up requires hover → release
  outside the region left arm=true → next crossing left-drag hijacked a
  window move. Added on_mouse_up_out clearing the arm; click_count==2 also
  clears; >=3 neither arms nor zooms.
- **gdom pressTarget lifecycle (fixed, agent G).** Was write-only at
  materialize. Now refreshPressTarget() recomputes+retracts on
  add/removeEventListener, role/contenteditable/type/href attr changes,
  delegated backfill, and lazily at dispatch. Added
  pointerdown/up + touchstart/end to PRESS_TARGET_EVENTS; delegated symbol
  probed per-call (no stale cache); undefined delegated values and
  contenteditable="false" no longer false-positive; delegation hosts
  (mount root/body) never mark themselves; pressTarget suppressed on
  native-guarded elements (input/textarea/x-*).
- **removeEventListener mapping bug (fixed, agent G).** Emitted the raw DOM
  type instead of gpuixEvent(type) — renamed types could never retract.
  Now emits the gpuix name + listenerFeedClaimed() keeps native feeds
  still needed by delegation/aliases/state-rule/input feeds.
- **Fork: display-link churn + throttle rework (fixed, agent F).**
  set_frame_size restarted the CVDisplayLink on every AX write (stop →
  unsubscribe → mutex → start per write). Now gated on registration; the
  non-live-resize displayLayer consumes pending resize + defers render to
  step() instead of the never-engaging 16ms throttle; take_pending_resize
  keeps the flag when resize_callback is checked out; scale-factor updates
  clear pending (no duplicate bounds_changed); pump_events re-entry logs +
  returns instead of panic-aborting across NAPI; update_or_defer retries
  bounded so bounds_changed can't be permanently lost.
- **tick() hardened.** NaN/negative/Infinity waits now clamp to
  [0, 500]ms — tick(Infinity) can no longer park the main thread.
- **Probe determinism (fixed).** Vendored cge.swift to
  packages/tests/bin/ (was unversioned /tmp); added swift-toolchain +
  helper preconditions; docstring corrected (was "via cliclick"); added
  `raise <pid>` — NSRunningApplication.activate brings the probe app
  frontmost so CGEvents hit-test its window (without it clicks landed on
  whatever app covered the rect — the earlier pass was luck). New
  coverage: tabindex click-to-focus inside+outside the region (the C1
  class) and a real delegated-handler child.
- **Found en route:** dblclick on selectable text calls window.blur() +
  word-select (paint.rs:792 — intentional). Probe mirrors the app with
  user-select:none on the bar so the focus assertions stay meaningful.

Verified: cargo release build clean (gpui+gpui_macos+gpui_platform
recompiled), dylib deployed+signed, gpui-fork.patch re-exported (916
lines/24 files incl. display_link.rs), git apply --check --reverse clean,
suites 84/48/30/49/45/25 green, probe-titlebar-nodrag 13/13 PASS on real
CGEvents (button/input/tabindex/delegated dblclicks → no zoom; tabindex
click → focused both sides of the region; title-text dblclick →
zoom+restore; single click after the sequence works).

## CTHEME removal + adversarial styling review

- **CTHEME lane deleted.** `setComponentTheme`, `ComponentTheme.svelte`, and
  the `sub` ladder level removed — `theme({components})` (nested) and the
  `theme` prop already cover every use. `useComponentTheme` renamed to
  `componentTheme(name, instTheme, slots)`; ~45 component callers migrated.
  The resolver keeps recipe→registry→instance ordering; `instTheme` accepts
  a getter (`() => theme`) so replaced objects stay reactive. Nested
  `theme()`/`<Theme>` without `defaultTheme` now inherits the parent's
  resolved theme instead of re-falling to system; `forcedTheme` actually
  assigns (was destructured-and-dropped); nested scopes skip the global
  `setTheme` emit and the persistence lane.
- **Adversarial findings fixed — JS lane:**
  `style()` sanitizes non-object fragments (a bare primitive used to ride
  the wire as `null` and fail the batch shape check, dropping the WHOLE
  batch); one recipe binding per element — second bindings warn+drop in
  style()/componentTheme/mergeStyleDesc; recipe() throws TypeError on
  non-object config and warns on nested recipe envs; multi-slot shared
  StyleProps variant values apply to every slot (they used to evaporate);
  partial slot-maps report unknown keys; componentTheme survives primitive
  slot entries (was a `for…in` over string indices) and unwraps
  env-carrying level entries.
- **gdom:** `_rawAttrs` side-map keeps object-valued attributes (theme
  decls, position objects…) intact through materialize/replay — was
  "[object Object]"; `_attrColor` ledger + `_ctxColorOwned` handshake so a
  `data-color` attribute survives env ctx-color ownership release;
  cloneShallow copies the new fields; property setters clear stale
  _rawAttrs entries; `setAttribute('data-color', null)` retracts via
  removeCustomProp (no undefined 3-arg op).
- **Rust applyBatch hardened to its contract:** phase-2b structural
  shadow-preflight (window/element existence, parent/child links) runs
  before mutation so phase 3 is genuinely non-failing — `setRoot` now
  warns+skips instead of `Err`-ing mid-apply and poisoning the JS retry
  lane; `setTheme` with no arg decodes Null → retracts rather than
  invalidating the batch; `root_tokens_for(tree)` shared by render and
  validation lanes (x-button/anchored no longer stuck dark under a light
  setTheme).
- **native.ts renderer swap:** `setRenderer` now resends registered
  stylesheets + the last `setTheme` declaration alongside recipes — a
  fresh tree used to lose both.
- **qg-backend mirror:** `setStyleProps`, `setRecipe`, `registerRecipe`
  cases added — symbolic StyleProps resolve through the gen mirror
  (resolveStyleProps + token literals), recipe variants/compounds match
  Rust semantics (defaults→call variants→ctx-color, declaration order),
  env retraction releases owned prop codes.
- **Tests:** style-adversarial.test.ts (11) + conformance cases
  themeinherit/themeforced/themeladder (nested inherit, forcedTheme,
  getter-based instance theme reactivity + primitive-slot guard).

Verified: cargo --lib 301/301 · bun test 242/242 · svelte 51/51 ·
nkit 30/30 · kit 49/49 · qg 45/45 · pages 25/25 · platform 84/84.
Zero CTHEME/setComponentTheme/useComponentTheme/ComponentTheme references
in src, gen, tests, docs.

## 2026-09-19 — app packaging: `bun run build` → .app in one step

`cd app && bun run build` now runs `vite build` (plugin emits the spawnable
bundle at `.svelte-native/app.js`, `@gpuix/native` pinned external to the
deployed fixture copy) then `packages/gpuix/scripts/package-app.ts` compiles
it with `bun build --compile` and wraps the binary in
`app/dist/SvelteNotes.app` (85.5 MiB, ad-hoc linker-signed, Info.plist
bundleId `dev.svelte-desktop.notes`).

- `package-app.ts` gained `--out-dir <dir>` (default `build`) and repeatable
  `--external <spec>` passthrough to `bun build --compile`.
- `--external @gpuix/native-darwin-arm64` is REQUIRED: the napi loader's
  scoped-package fallback `require('@gpuix/native-darwin-arm64')` doesn't
  resolve under the fixture dir and fails the bun bundle. Dead code at
  runtime — the sibling `require('./gpuix-native.darwin-arm64.node')` (our
  deployed libsgfx) wins first, and bun embeds that .node in the binary.
- Verified: `open dist/SvelteNotes.app` → LaunchServices launch, GPUI window
  "svelte·desktop — notes" on screen, ~174 MiB RSS, clean kill. Direct exec
  of `Contents/MacOS/SvelteNotes` works identically.
- Root `bun run package` was stale (cd gpuix-poc — retired); now delegates
  to `cd app && bun run build`.

## 2026-09-19 — style parity: expressible vocab wired end-to-end + census

Closed every "accepted but silently dropped" styling gap that didn't need a
new native capability, plus two that did (gpui fork):

**gpui fork** (re-exported to gpui-fork.patch):
- `FontRun.letter_spacing: Pixels` → CoreText `kCTKernAttributeName` at shape
  time. Shaping/wrapping/hit-test/cache all consistent; `Pixels` is Eq+Hash so
  it rides the layout cache keys for free. Merge conditions split runs on
  spacing change. `TextStyle.letter_spacing: Option<Pixels>` + `to_run` +
  `Styled::letter_spacing` builder.
- `AriaProperties` +9 scalar fields (disabled/busy/hidden/modal/readOnly/
  required/live/invalid/hasPopup/roleDescription) — trait methods on
  StatefulInteractiveElement → accesskit `set_*` in `write_a11y_info`.

**Native crate:**
- `StyleDesc` +letter_spacing, line_height_scale, font_features, text_transform.
- `Inherited.text_transform` cascades; applied in `text_content` +
  `joined_text_content` (aria values announce transformed text).
- accessibility.rs maps aria-checked (checkbox/switch/radio were silent),
  disabled/busy/hidden/modal/readonly/required/live/invalid/haspopup/
  roledescription.

**JS lanes:**
- style_props.rs + style.js mirror: `letterSpacing`/`tracking`, `leading-*`
  → lineHeightScale, `radiusTl/Tr/Bl/Br` + `radiusT/B/L/R`, `fontFeatures`,
  `textTransform`/`case`.
- tokens.js: `leading-<n|fraction>` emits lineHeightScale, `leading-<scale>`
  emits px; `uppercase`/`lowercase`/`capitalize`/`normal-case`; `tabular-nums`
  → fontFeatures {tnum:1}. Removed them from the silent-drop regex.
- stylesheet.rs: unitless `line-height` → lineHeightScale (was the <8 px
  multiply hack — wrong when fontSize lived outside the rule);
  `font-feature-settings` parser ("liga" 0/1, tnum=1).
- qg-backend: symbolicFieldEntries +letterSpacing/textTransform (protocol
  codes 240/242 already existed); lineHeightScale post-pass emits LineHeight
  with the ×fontSize semantics the qg renderer expects.
- style.d.ts: StyleProps interface gained the new keys.

**Docs:** documentation/docs/styling/census.mdx — full expressible/refused
tables grouped by genre (layout, sizing, typography, color, border, effects,
interaction, values grammar, ARIA). boundaries.mdx updated (letterSpacing no
longer "dead vocabulary").

Verified: cargo 314/314 · bun test 174/174 (15 style-adversarial incl. new
vocab tests) · svelte 51/51 · nkit 30/30 · kit 49/49 · qg 45/45 · pages 25/25.
Native dylib rebuilt, deployed to both .node locations, re-signed.

Follow-up: `native-css/parse.test.ts` was stale against `parse.ts` (untracked
WIP — combinators, attr selectors, `:not()`, `:global` unwrap, and descendant
nesting all parse now; the tests still asserted drop). Rewrote the stale
sections to assert the supported surface; kept genuinely-dropped cases
(pseudo-elements, non-state pseudos, ancestor-state) as drop assertions.
`test:unit` now globs `packages/gpuix` too — 242/242.

## Delegated event rework + regression fix (2026-09-21)

Reworked Svelte's delegated-event plumbing to kill the per-element
`setEventListener` backfill storm: `document.addEventListener(type)` for a
delegated type now emits ONE `setDelegatedEvents` op; the renderer stores
`tree.delegated_events` and attaches the same listeners at build time via a
`element.events ∪ delegated` union (`RetainedTree::dispatches` is the shared
gate — also consulted by custom elements via `ctx.delegated` and by
`apply_a11y_click`). Focus/key types stay element-scoped (`FOCUS_KEY_TYPES`
→ focusables only); fileDrop/visibleRange/highlight stay element-only;
`native.ts` replays the delegated set on renderer rebind; qg-backend mirrors
(wire-on-register + wire-on-create). Test: `delegated-events.test.ts` —
one setDelegatedEvents op, zero per-element backfill ops, keyDown stays
element-scoped.

Two regressions found + fixed after the rework:

1. **Memoization turned on for the first time.** Backfill had made every
   `element.events` non-empty → `MEMO_HAS_EVENTS` → nothing ever memoized.
   With clean `element.events`, subtrees started memoizing — and a
   `GpuixSubtree` entity recorded before the delegated set landed replays a
   view with no listeners forever (scan cached on `subtree_revision`).
   Fixes: `memo_scan` flags MEMO_HAS_EVENTS when `delegated_events` is
   non-empty (parity: delegation = listeners, attached from a different
   set), and the `setDelegatedEvents` apply arm calls the new
   `RetainedTree::invalidate_render_caches()` (bumps every
   subtree_revision → kills stale scans AND stale memo entries) + repaints
   all roots.

2. **Text nodes became event targets.** The build-time union wired
   delegated `click` onto `text` elements — under backfill they never got
   listeners (gdom emits no listener ops for nodeType 3). The deepest emit
   on `<a>item 7</a>` became the text node; `dispatchNative`'s activation
   walk requires `target instanceof GElement` → anchor/submit walks bailed
   → kit navigation + forms died (layout-clicks:0 → 49→34). Fix:
   `dispatches` returns element-only for `element_type == "text"` and the
   wiring loop excludes delegated types on text — DOM-correct (text is
   never a target), parity-restoring. Verified live: click on "item 7"
   emits deepest-first `click@<a>` → `__kitGoto` fires → /item/7.

Suspected causes ruled out on the way: `preflight_structural_ops` ignores
non-structural ops (not a dropper); emit order is still deepest→root and
the `lastGesture` echo-collapse still holds.

Verified after fix: cargo 314/314 · platform 84 · svelte 51 · nkit 30 ·
kit **49/49** · qg 45 · pages 25 · unit 243 (incl. delegated-events test).
Dylib rebuilt, deployed to both .node locations, re-signed.

CAUTION when running kit-conformance: it must run from packages/tests —
the suite does `read('hooks.ts')` resolved against process cwd; running
from repo root fails 4 cases with a fake ENOENT cascade.

## Svelte transitions drive real native motion (2026-09-21)

`in:`/`out:` now produce visible native animation, verified by sampling
painted bounds mid-flight through TestGpuixRenderer — not just lifecycle.

**Mechanism.** Svelte 5's transition driver builds ~1-per-16ms PRE-EASED
keyframes via `css(t)` (easing baked in), then calls `element.animate()`.
gdom's WAAPI-lite interpolates keyframe props per rAF tick → `setStyle`
ops → Rust layout. Two gdom gaps made it a no-op before:

1. `getComputedStyle` returned only inline props. `slide()` reads
   opacity/height/padding/margin/border — `+''`→0 opacity (invisible!),
   `parseFloat('')`→NaN height (dropped). Fixed: defaults (opacity:1,
   position:static) ← mergedStyleProps (class+inline) ← painted bounds
   override width/height. Kebab+camel lookups + getPropertyValue.
2. `animate()` interpolated first→last keyframe — flattened the baked
   easing curve. Fixed: piecewise sampling across all frames, `offset`
   honored. anim exposes currentTime/playState/cancel — svelte's
   bidirectional counterpart reversal + abort paths work.

**App feature.** Sidebar itself collapses: `{#if sideOpen}` + `in:`/`out:`
with a custom `collapseX` (svelte's `slide` is vertical; sidebar wants
width — still the same in:/out: contract). Padding moved to `.sidebar-in`
(fixed 200px) so collapse clips cleanly. Toggle in titlebar.

**Verified.** probe-slide-transition.ts — 10/10: eased outro
`60→43→30→20→12→7→4→2→1→0`, intro mirror, unmount-after-outro, width axis
`199→143→99→65→40→23→11→4→1→0`. svelte conformance 51/51, style unit
suites green.

**Found on the way.** vite-plugin's lazy `import(NATIVE_CSS_PARSE)` has
always thrown under node (extensionless `../native-attr` — node type-
stripping needs explicit .ts) → every dev `<style>` block silently
dropped. Fixed → `.ts` extension; registerSheet rules now flow to Rust.

## MenuBar / StatusItem components (menu.insert + tray badge + content-sized popover)

**Feature.** Two platform components under `packages/platform/src/components/`
→ compiled to `gen/components/` by a new `vendorDir` lane in build.ts
(`platformReachback` alias: `../index*` → `@svelte-desktop/platform`; platform
package.json gained `"./gen/*"` exports pass-through). Consumers import
`@svelte-desktop/platform/gen/components/MenuBar.js`.

- `MenuBar.svelte` — `{label, icon, items, index, onClick}` mounts one
  top-level bar entry via `menu.insert`; `subItems`/`submenu` nest, item
  `onClick`s register into a global id→fn table fed by one `menuAction`
  subscription (`items.js` helper). `$effect` teardown releases callbacks +
  `menu.remove`s — renames and unmounts both clean up.
- `StatusItem.svelte` — `{icon, label, tooltip, badgeColor, items, onClick,
  bind:open, position, children}`. `items` → native dropdown (menu spec on
  the status item); `children` snippet → borderless transparent floating
  window: `windows.create(visible:false)` → `createWindowRoot` → `moveBefore`
  reparent of the stage (hidden `display:none` until it lands — no win-0
  flash) → 100ms poll of the subtree's unioned `getBoundingClientRect`s →
  `setSize` + `positionTo('trayBottom')` + `show`. Blur of the popover or
  focus of any other window dismisses; teardown closes window + tray.

**Native ops.**
- `menu.insert {name, icon?, items?, id?, index?}` — inserts one bar entry
  without touching gpui-owned menus; `representedObject = name` marks it
  foreign so `top_pairs`/`item_id` keep spec correlation intact (items()
  shows it, get/update/remove find it). No `items` → clickable bar item
  firing `menuAction` with `id`. Re-inserting a name replaces.
- `menu.remove {name}` — drops by representedObject-or-title.
- `tray.set badgeColor` — composites a dot onto the icon top-right via
  NSBezierPath (non-template image so the bar can't recolor it); explicit
  `null` reloads the unbadged `imagePath`.

**Real bug found by the live probe.** `native_image_name` passed literal
`"NSImageNameAddTemplate"`-style strings — the constants' *runtime values*
differ (`NSAddTemplate`). Every `{native:…}` icon silently failed. Rewrote
the map to cocoa's `NSImageName*` statics (real NSString objects); the 6
deprecated names cocoa doesn't export got literal transformed strings.

**Verified.** probe-menu-tray.ts (new, live): 24/24 — insert submenu +
nested get/update, clickable-with-icon, replace dedupe, remove +
missing→unavailable, tray badge set/clear/invalid→invalid_args, MenuBar
mount→Tools-in-bar→unmount-removes, StatusItem→tray+popover window at
140×90 content size→teardown. cargo 314/314, bun unit 243/243, conformance
84/51/30/49/45/25 all green.

### Adversarial perf review of the transition path (same session)

Measured (probe-anim-perf.ts, TestGpuixRenderer, 160ms collapseX outro):
11 applyBatch calls @ ~29µs avg (parse + apply + resolve_element_layers +
invalidate); renderer.flush ~126µs/pass; ~155µs/frame total — 100× headroom
inside a 16ms frame. Op volume = one setStyle per rAF tick.

Verified-correct properties: emit batches per macrotask (one NAPI crossing
per flush, never inside a native event callback — the setTimeout(0) seam
avoids reentrant GpuixView updates); set_style interning + ptr-eq makes
same-bytes resends free; mark_render_changed on style diff bumps ancestor
subtree_revision → memoized ancestors can never serve a stale animated
frame; progress is wall-clock (elapsed/duration) — timer jitter drops
frames without accumulating error; cancel() stops the rAF chain; live path
invalidates via cx.notify per touched window → vsync paint.

Fixed during review: duration:0 animations (svelte's delay-dummy) settled
on a rAF tick — ~16ms dead-time before the real animation began. Now
settles via queueMicrotask (onfinish still fires after the caller attaches
it). Probe intros now start interpolating on the first sample.

Honest remaining limits (not bugs): JS rAF is setTimeout(16) — ~62fps
ceiling, not vsync-aligned, and keeps ticking when the window is occluded
(native motion.rs uses window.request_animation_frame() — a `frame` event
or requestFrame op would give JS rAF true vsync + hidden-window throttle);
every animated frame re-runs the full stylesheet match in
resolve_element_layers (29µs at ~30 rules — a scaling note for huge sheets
× many concurrent animations); layout-driven animation relayouts per frame
— same class as browser width/height transitions (non-composited), the
composited path (transform) doesn't exist in StyleDesc.

### rAF rides native vsync — requestFrame op + frame event (same session)

The remaining-limits item above got implemented: JS rAF is no longer a
setTimeout(16) loop. Design: `requestAnimationFrame` queues callbacks in
a Map and emits one `["requestFrame"]` batch op per pending queue;
`BatchOp::RequestFrame` marks every root-hosting window in
`outcome.windows` → `invalidate_after_batch` notifies them → the next
vsync render runs `GpuixView::render` → which emits a `frame`
EventPayload (element_id = new Rust-side WINDOW_EVENT_ID 0x7fff_ff01,
matching gdom's). `dispatchPayload` intercepts `frame` inside the
WINDOW_EVENT_ID branch (before document dispatch — it's not a DOM event)
and drains the queue with browser semantics: swap-then-run so callbacks
registered mid-drain run next frame, cancel = map delete, one op covers
the whole queue.

Cadence follows the display (120Hz-capable on ProMotion) and pauses when
the window stops drawing — an occluded window produces no renders, so no
frame events; a 250ms one-shot watchdog ticks the queue anyway (throttled
to ~4fps, animations complete by wall-clock instead of freezing). The
watchdog also covers surfaces that never emit `frame`: TestRenderer
ignores outcome.windows (only explicit flush() renders — each render
emits the event, so tests tick per pump), and the qg mirror's switch has
no throwing default so the op is a clean no-op there.

Verified: probe-raf.ts 10/10 (op reaches native via a Proxy-wrapped
renderer — napi instances aren't safely patchable; tick on frame event,
shared-frame ordering, nested-next-frame, cancel, no-render-no-tick,
watchdog fallback, requeue chain). probe-slide-transition 12/12 (denser
intermediate samples now — one tick per render instead of per 16ms
timer). probe-anim-perf: 34 applyBatch/402ms (~85fps tick cadence),
0.037ms avg. Conformance 51/51, kit 49/49, unit 243/243, Rust
request_frame test green. Dylib rebuilt, deployed to all 4 .node copies,
re-signed.

### Popover placement: nil-screen fix + placement API (same session)

User report: popover opened off the icon with a visible staged-window
flash. Root cause chain, all fixed:

- `visible:false` → `show:false` → NSWindow never ordered →
  `NSWindow.screen == nil` → vendored `set_position` early-returned
  silently → window stayed at its centered staging rect (the flash was
  that 800×600 staged frame presenting before the first fit).
- gpui fork patches (README §7): `MacWindow::set_position` and
  `MacWindowState::bounds` now fall back to `screens[0]` on nil screen —
  matches `window_screen()`'s primary-screen policy in window_ext, so
  unordered/hidden windows position and report real frames.
- `window.setSize` was `window.resize()` — spawned `setContentSize:`
  async on the executor, so `place()` could read the stale 800×600
  frame. Now synchronous `setContentSize:` (same rationale as
  `set_bounds`' atomic frame set).
- StatusItem staging: `visible:true, focus:false, opacity:0` — ordered
  (screen resolves), invisible (alpha), non-key (first `show()` does
  `makeKeyAndOrderFront`, nothing steals focus while staged).
- fit/place errors were swallowed by `.catch(() => {})` — now logged
  like the tray.set error path.

`position` prop on StatusItem: preset name | fixed {x,y} | callback
`({width,height,tray,displays}) => preset|{x,y}` evaluated at every fit.
Coordinates are window-screen-relative (gpui's model — every display's
bounds are (0,0)-anchored); types/docs updated to say so. Component
`.d.ts` now imports types via the `@svelte-desktop/platform` package
specifier — `../index.ts` resolved to the missing `gen/index.ts` after
vendoring and silently demoted props to `any` (implicit-any params on
callbacks in consumers).

Probe fixture bug found en route: `||` after a truthy assignment meant
the placement callback returned `{width,height,displays}` — never
`{x,y}` — and `setPosition(undefined,undefined)` rejected invalid_args
under a swallowed catch. Comma-sequenced; placement assertion now real.

Verified: probe-menu-tray 31/31 (placement callback → 300,200 on a
3-display box), probe-pos-space (new) — unordered window set/get
round-trips + positionTo('center') while hidden. cargo 315/315,
platform 84/84. gpui-fork.patch re-exported.

### Adversarial review of the vsync rAF — findings + fixes (agent-reviewed)

A read-only review agent audited the requestFrame/frame mechanism. 5 REAL
findings + 4 MINOR + 5 NOTE, all triaged; the real ones fixed:

REAL, fixed:
- Multi-window N× tick: every root window emits `frame` per render → the
  shared queue would drain N×/vsync with N animating windows. Fix:
  cross-window same-cycle suppression in dispatchPayload — a frame event
  <4ms after the last tick from a DIFFERENT windowId is the same display
  cycle (same-window renders always tick; ≥240Hz-safe).
- Throwing rAF callback lost all later same-frame siblings + propagated
  through the TSF/drain loop. Fix: per-cb try/catch → console.error,
  continue (report-and-continue, spec-ish).
- HMR stale-realm leak: old realm's pending watchdog could drain its
  queue once post-reload → stale cbs re-register via the NEW global rAF
  → adopted → run forever pushing dead-id ops through the old realm's
  emit. Fix: `__svelteNativeHost.rafGen` claimed at gdom module eval —
  rafAlive() guards registration/tick/watchdog; a stale realm dies
  before it can tick once (the `??=` at module eval precedes emit.js's
  own host creation, so realm 1→2 transitions are covered too).
- Version skew poison: new gdom + old dylib → `requestFrame` is an
  unknown op → decode fails the WHOLE batch atomically → retry drops the
  retried prefix → co-batched setStyles lost. Fix: one-shot
  `applyBatch('[["requestFrame"]]')` probe via deferCall on first rAF —
  atomically safe (decode precedes apply); unsupported bindings drop to
  the 16ms watchdog lane permanently (= old behavior) instead of 250ms.
- animate().pause()/play() were stubs: pause froze nothing and resume
  jumped to wall-clock. Fix: pause freezes currentTime + stops the step
  chain; play shifts `start` by the paused span (start is `let` now).

MINOR, fixed:
- requestFrame ops coalesce in emit() — unbound renderer would otherwise
  pile one per watchdog tick into a stale replay storm on bind.
- Pre-mount rAF (roots empty) marked nothing → 4fps until mount render;
  now marks window 0.
- test_renderer events Vec grew a frame payload per render when
  harnesses never drain (mission-*.ts) → consecutive undrained frames
  coalesce.
- probe-raf watchdog margin 300→400ms; +throw-sibling, +cross-window
  coverage. probe-anim-perf switched to the Proxy rebind (napi objects
  aren't guaranteed extensible — probe-raf's approach was the right one).

NOTE, handled: tickRaf reentrancy guard (rafTicking flag — a nested
synthetic frame event drops instead of violating next-frame deferral);
WINDOW_EVENT_ID comment now names `frame`; the "120Hz" claim corrected —
emit.js pumps the runloop at ~16ms so ~60Hz effective today (mechanism
itself unbounded — a faster pump unlocks it); post-paint tick latency +
arrival-time timestamp documented in the gdom comment.

Verified safe (agent confirmed, not just claimed): occlusion IS real —
gpui's display link stops on NSWindowOcclusionStateVisible loss; TSF is
NonBlocking + emits under the tree Mutex are safe on all 3 transports;
no stranded-callback state exists; sentinel values identical; emit
inside native callbacks safe via setTimeout(0); forward skew (old gdom +
new dylib) untouched; poisoned-batch self-heal via watchdog holds.

After fixes: probe-raf 14/14, slide-transition 12/12, anim-perf clean,
conformance 51/51, kit 49/49, unit 243/243, cargo request_frame test
covers both arms (roots + rootless). Dylib redeployed + re-signed; dev
host restarted on the new binding.

### Permissions declaration — package-app.ts --usage

The runtime permission API already existed and is complete:
`system.checkPermission` / `requestPermission` / `openSettings` covering
accessibility (AXIsProcessTrustedWithOptions), screenRecording
(CGRequestScreenCaptureAccess), notifications (UNUserNotificationCenter —
needs a bundle identity, returns `unavailable` unbundled), camera +
microphone (requestAccessForMediaType:), fullDiskAccess (check is a
readable-TCC.db heuristic → granted|unknown; request is `unsupported` by
design — openSettings only), plus `secureStorage.authenticate` (LAContext).

The missing half was the declaration: camera/mic requests abort the
process when the NS*UsageDescription key is absent — permissions.rs guards
it (returns `unavailable` naming the key), but package-app.ts emitted no
way to declare one.

`package-app.ts` now takes repeatable `--usage name=reason` — `camera`/
`microphone` map to NSCameraUsageDescription/NSMicrophoneUsageDescription,
any other `NS*UsageDescription` key passes through verbatim (protected
folders, contacts…). Plist values are XML-escaped (a `&` in a reason would
have corrupted the whole plist → bundle identity lost → notifications
silently broken too). Verified end-to-end: built PermTest.app, plutil
parses both keys, malformed `--usage` exits 1 with usage text.

Docs: platform-api.mdx caveats list (camera/mic key requirement + FDA
heuristic), app/NATIVE.md permissions section (incl. the ad-hoc-signing
caveat — TCC binds grants to cdhash, so dev rebuilds lose Accessibility /
Screen Recording grants; stable identity needed for that work),
packaging.md open-questions updated.

### Platform API typing sweep — zero Promise<unknown> remains

All 80 `callPlatform` sites in packages/platform/src/index.ts now carry an
explicit generic, mapped against the actual Rust `ok(...)` payload per op
(subagent-extracted table, verified per arm — not guessed from docs):

- ~62 mutators resolve `Value::Null` → `callPlatform<null>` (window setters,
  clipboard writes, shell ops, app/menu/power/secureStorage mutators).
- Real payloads typed concretely: `menu.insert → {inserted, name}`,
  `menu.remove → {removed, name}`, `tray.remove → {removed}`,
  `shortcuts.unregister → {unregistered: bool}`,
  `shortcuts.unregisterAll → {unregistered: number}` (a COUNT, same key
  name as unregister — the spec sig now records the distinction),
  `app.setDockBadge/bounceDock/setActivationPolicy → boolean` (literal true).
- Two honest `Promise<never>`: `app.exit` (std::process::exit diverges —
  the promise never settles) and `window.setFocusable` (always rejects
  `unsupported` — no success payload exists on any current backend).
- secureStorage.setPassword/deletePassword resolve null — but on the
  pending lane (platformResult), noted for consumers.

Spec yaml sigs updated for the non-obvious returns (insert/remove/tray/
shortcuts/dock ops). tsc: zero platform errors; 84/84 platform tests pass;
stores.svelte.ts re-exports and disposable-handle types unaffected
(Promise<null> ⊂ Promise<unknown>).

### window.controlsArea — traffic-light geometry token

`window.controlsArea` op → `windows.getControlsArea()` →
`window.controlsArea` $state (stores refresh on boundsChanged). Reports the
close/minimize/zoom cluster in content coords (top-left, y down — the
drawable space): union rect + per-button {x,y,w,h,visible} + `side:'left'`
for cross-platform mirroring. Negative y = buttons above the drawable
(non-fullsize titlebar → nothing to reserve); `null` on borderless windows.
Probe asserts main window → 3-button cluster ({x:9,y:-23,60×14}) and
borderless popover → null. 34/34 probe, 85/85 platform tests.

## Rapid sidebar toggle → corrupted end-state — FIXED (animFrames cascade)

Bug report: rapid open/close left the rail stuck mid-flight (transparent,
width ~48px, `overflow:"undefined"` literal on the wire).

Investigation path: built probe-rapid-toggle.ts (burst-click mid-transition),
traced every anim's apply/cancel/finish + `collapseX`'s `w` captures.

Findings:
1. `in:`/`out:` compile to TWO independent `$.transition` managers —
   `resume_children` calls `in()` on the intro manager FIRST while the
   outro is still running → `getComputedStyle` (browser-faithful: WAAPI
   effects show in computed style) captures mid-flight width →
   `collapseX` bakes `w=48` → intro animates to the wrong target.
2. The killer: `animate()` wrote keyframes directly into `style.props`
   and `cancel()` left them → the animation's last frame persisted
   FOREVER (browser: cancel drops the effect → authored style resurfaces
   → snap back to `style="width:200px"`).
3. Worse: with split managers the old intro is NOT aborted on `out()` —
   it keeps running CONCURRENTLY with the outro — two anims interleaving
   writes into one props map (browsers stack WAAPI effects; we clobbered).
4. `GStyle` proxy returned `undefined` for unset props → svelte's
   `element.style.overflow = overflow` restore wrote literal `"undefined"`.
5. `finish()` after `cancel()` still applied the last frame (queued
   zero-duration settle ignored `done`).

Fix — the cascade model the DOM actually has:
- `GElement.animFrames: Map<animKey, Map<prop,val>>` — animation effects
  live in per-anim layers, NEVER in `style.props`. `mergedStyleProps()`
  overlays class ∪ author ∪ live frames in creation order (later wins =
  WAAPI stacking) — one merge point feeds both the native wire
  (nativeStyleFor) and getComputedStyle.
- `cancel()` = `animFrames.delete(key)` + push — underlying values
  resurface automatically; works for running AND finished fill:forwards
  anims (svelte cancels the dummy post-finish inside onfinish).
- `finish()` honors fill (forwards/both persist; none drops), early-returns
  when already cancelled. `finished` rejects AbortError on cancel with an
  internal catch (svelte uses onfinish, never awaits it).
- GStyle proxy: unset props read `''`; `x = ''`/`null`/`undefined` deletes
  — `el.style.x` = author layer (animations invisible in inline decl,
  exactly like a browser); getComputedStyle sees merged+animated.

Bonus fix — qg fade-out starvation: `framesSeen` gate — the 250ms
occlusion watchdog only engages after a real frame event arrived; the JS
mirror (accepts requestFrame as no-op, never emits) stays on 16ms.

Verified: rapid-toggle 9/9 (end-state pure authored {width:200,border:1}),
slide 12/12, raf 14/14, qg 45/45, conformance 51/51, nkit 30/30,
unit 244/244, kit 49/49, pages 25/25.

Doc note for users: `in:`/`out:` are non-reversible by design — mid-outro
reopen animates toward a stale target then self-heals at introend (same as
browsers). `transition:collapseX` gives smooth reversal.

## svg subtrees — inert DOM, serialized `source`

`<svg>` is a leaf renderer natively (gpui::svg paints a whole document).
Nested markup (`<path>`, `<circle>`, `<linearGradient>`…) now stays DOM-inert
— children never materialize — and the `<svg>` element serializes its whole
subtree into the `source` custom prop on every mutation. Authored Svelte
`<svg><path d={d}/></svg>` works verbatim and stays reactive.

- `svgHost(n)` — outermost svg ancestor; `markSvgDirty(n)` — re-serializes
  into `source` via the setCustomProp ledger (dedup + materialize replay).
- `GAttrs` — attributes Map subclass; every attr write path (setAttribute,
  className/id setters, parseHTML's attr loop) dirty-marks its host.
- `GElement._localTag` — authored tag case survives tagName uppercasing so
  `linearGradient`/`clipPath` serialize correctly; cloneShallow copies it.
- `createElementNS` now records namespaceURI.
- insertBefore/removeChild/data-setter svg branches: inert + dirty-mark;
  a materialized element moved into an svg dematerializes.
- Root box attrs (class/style/id/aria-*/data-*) stay out of the document;
  inner attrs serialize verbatim; xmlns auto-injected.
- svg root keeps full element behavior: class/style (native stylesheet +
  setClass), events, custom props — `color` tints `currentColor`.

App: note delete button uses natural `<svg><path/></svg>` markup —
`.note-del:hover .note-del-ic` rides the native stylesheet's
descendant+state matching to recolor the icon.

Verified: svg-subtree 9/9, unit 253/253.

## Native CSS transforms — transform/transform-origin through GPUI (LANDED)

`transform` and `transformOrigin` already crossed the JS→native wire as raw
strings (`styleObject` passthrough) but landed on a nonexistent `StyleDesc`
field — Svelte's `fly`/`scale`/`crossfade` were silently animating only
their opacity half. Now the full transform pipeline is native:

- **`native/src/transform.rs`** — CSS 2D parser: translate (incl. `3d` with
  z=0), scale, rotate (deg/rad/grad/turn/unitless-zero), skewX/Y, matrix;
  transform-origin px/%/keywords, default `50% 50%`. All-or-nothing parse
  like CSS. `Transform::matrix(bounds)` resolves %-of-self lengths and the
  origin into a `T(origin)·M·T(-origin)` `TransformationMatrix`.
- **`Transformed` element** — wraps `build_element`'s finished subtree:
  request_layout delegates (transforms don't affect layout, like CSS);
  prepaint+paint run inside `window.with_element_transformation(matrix)`.
- **gpui-fork** — `element_transform_stack` on `Window` (composed
  child→parent so nested transforms multiply); `transformation` on Quad,
  Underline, Strikethrough, Shadow, PolychromeSprite; hitboxes and content
  masks transformed to AABBs (conservative under rotation); defer_draw
  captures the active matrix; primitive culling uses transformed bounds.
- **Metal** — quads/shadows/underlines/polychrome sprites take the
  transformed vertex path; fragments inverse-map position into local space
  so `quad_sdf` corner radii/borders stay exact under rotation+scale.
- **Bounds** — `bounds_tracker`/`track_own_bounds` report transformed
  AABBs, matching CSS (getBoundingClientRect is visual-space).

Svelte reads `getComputedStyle(node).transform` to compose onto existing
transforms — the animFrames layer means the computed value is live during
transitions and the author declaration stays clean.

probe-transform.ts + cases/fly.svelte: **15/15** — real painted bounds
displace (fly y:-60) and shrink (scale start:0, center origin) mid-flight,
computed transform exposed, exact rest convergence, zero style residue,
clean remount. Regression: rapid-toggle 9/9, slide 12/12, raf 14/14,
qg 45/45, conformance 51/51, nkit 30/30, kit 49/49, pages 25/25,
bun:test 257/257, cargo --lib 324/324.

Still unsupported: `filter`/`backdropFilter` (no StyleDesc field — `blur`
animates opacity only), `draw` (getTotalLength). Rotated content masks are
AABB-conservative — a rotated element inside a tight clip can over-clip.

## Icon API — `<Icon>` + registry conventions (nkit)

`src/nkit/Icon.svelte` — the tintable icon component over the `<svg>` renderer:
four content channels, precedence children > source > name (`src` for files/
data-URLs). `size` takes 'small'|'normal'|'large' (icon scale) or px;
`color` names a palette — omitted, the icon inherits parent `color` (true
currentColor: stylesheet :hover rules tint it). `class` is dual-channel —
tokens resolve AND the raw string lands as DOM classes for stylesheet
selectors. `label` promotes decorative (aria-hidden) → role=img + aria-label.

`icons.js` — `svgIcon(content, opts?)` composes a document with the built-in
wrapper (public), `registerIcons(set)` merges app icons; `wrap` now delegates
to `svgIcon`.

`iconTheme` recipe (display.js) — icon scale sm/md/lg, `shrink:0`, no base fg
(tint is opt-in so inheritance + stylesheets own the default lane).

App adoption: note delete button is now `<Icon name="x" size={16}
class="note-del-ic" />` — `.note-del-ic` + `.note-del:hover .note-del-ic`
stylesheet rules still own the tint (Icon emits no inline color when
`color` is unset, so no clobber).

Docs: `documentation/docs/styling/icons.mdx` + section index entry.

Verification: new `c-icon` case — all 3 element channels mount as native
svg elements; nkit conformance **31/31**, svg-subtree **13/13**,
bun:test **257/257**. Also removed a stray `yo` debug text that was
painting in the StatusItem popover. test-app.ts has 2 pre-existing nav
FAILs (expects 'increment via command()' — button renamed earlier this
session, unrelated to Icon).

## App icon pipeline — `.app` bundle icons (package-app.ts)

Correction of scope: the gpuix.dev "#5 wrap it in an app with an icon"
convention is about the **bundle icon**, not UI icons. Implemented the
packaging side:

`scripts/app-icon.ts` — `resolveAppIcon(arg, resourcesDir, cwd)`: three
input forms → one `AppIcon.icns` in Contents/Resources. `.icns` copies
verbatim, `.iconset/` compiles via `iconutil -c icns`, `.png` generates
the full 10-slot iconset via `sips` then compiles (warns when source <
1024px). `discoverIcon(cwd)` probes `icon.icns` > `icon.iconset` >
`icon.png` — the drop-a-file convention.

`package-app.ts` — `--icon <path>` (overrides discovery), `--no-icon`
(opt-out), resolves after `bun build --compile`, emits
`CFBundleIconFile` in Info.plist only when an icon resolved. Logged
`[icon] origin → AppIcon.icns`.

gpuix/package.json exports gained `"./scripts/*"` so tests reach the
script helpers via the package specifier (never deep relatives).

`app/icon.png` — generated 1024² placeholder (dark squircle + note card
+ yellow band + text lines, per-pixel via node:zlib png encoder) so the
convention path has real art; replace the file to rebrand.

Verified end-to-end: packaged a trivial entry from `app/` → discovery
picked up icon.png → `Contents/Resources/AppIcon.icns` (iconutil
roundtrip: all 10 slots) + `CFBundleIconFile` in plist. Tests:
app-icon.test.ts **8/8** (png→icns all slots, icns verbatim copy,
iconset compile, discovery order, flag-less discovery, --no-icon,
bad-input errors). Unit total **265/265**.

## CLIs — `svelte-native-package` + `svelte-native-icon`

`@svelte-desktop/gpuix` now exports two bins (isolated linker lands them in
each consumer's `node_modules/.bin`, alongside the vite pkg's
`svelte-native`/`svelte-native-dev`):

- `svelte-native-package` → `scripts/package-app.ts` (shebang added) —
  the .app bundler; same flags, usage string updated.
- `svelte-native-icon` → `scripts/app-icon.ts` via an `import.meta.main`
  CLI block — `<icon.png|icon.iconset|icon.icns> [-o out.icns]`; default
  output is `<basename>.icns` in cwd. Standalone icns compiler for icon
  iteration without bundling.

Internals: extracted `buildAppIconIcns(src, dest)` — the per-extension
dispatch both `resolveAppIcon` (bundler → AppIcon.icns) and the CLI
(arbitrary `-o`) share.

`app/package.json` build now calls `svelte-native-package` — the bin path
proves itself in the real flow. Verified through the `.bin` shims:
icon→10-slot icns, package→.app with CFBundleIconFile. Re-ran
app-icon.test.ts post-bin: **8/8** (import.meta.main inert on import).

## /animations showcase + sparse-keyframe interpolation fix

New route `/animations` — the motion showcase across all three lanes:

- **Svelte transitions** — fade (reversible), fly, scale (center +
  `transform-origin: top left` variant), slide, honest blur card
  (opacity-only), and a custom `css(t)` spin-in using `rotate()` +
  `scale()` + `elasticOut`.
- **crossfade** — tokens hop lanes via send/receive (transform-origin +
  translate + scale between keyed counterparts).
- **animate:flip** — keyed-each reorder glides; first real verification
  (limitations said "untested").
- **imperative `element.animate()`** — click burst, infinite/alternate
  pulse with cancel, pause/play marquee, `await .finished` chain.
- **CSS animation** — honest gap card: `@keyframes` is parser-dropped;
  the declared square sits dead next to the same keyframes driven
  through `element.animate()`.

Surfaced a real bug: `interp()` NaN'd on `'scale(1)'` — sparse WAAPI
keyframes never interpolated transforms (transitions masked it by
baking dense frames). Fixed with same-skeleton numeric-slot
interpolation — also covers rgba()/shadow same-shape strings.

probe-motion.ts + cases/motion.svelte: **13/13**. Regression: transform
15/15, rapid-toggle 9/9, slide 12/12, qg 45/45, conformance 51/51.

## 2025-XX — svelte runtime instance split (lifecycle_outside_component)

`getContext(...) can only be used during component initialisation` when any
nkit component called `componentTheme()`. Root cause: **two module instances
of svelte's internals in vite's native env**.

- `svelte/internal/*` (compiled components) → alias → `internalRoot` → vite's
  resolver **realpaths** → `.bun/svelte@5.57.0/node_modules/svelte/src/...`
- `@svelte-desktop/svelte/svelte-client.js` (theming.js getContext) → relative
  `./node_modules/svelte/src/...` → the resolveId relative-import shortcut
  returned `existsSync(base)` **verbatim** → `packages/svelte/node_modules/...`

Same file, two ids → `$.push` wrote `component_context` in the `.bun` copy,
`getContext` read the symlink-path copy (forever null) → throw. Invisible
until Icon was the first nkit component the app rendered.

Fix (packages/vite/vite-plugin.js):
1. `svelteDir` prefers `resolveSvelteDir(SVELTE_PKG)` — the framework's own
   copy (the shim's `./node_modules/svelte`), all realpathed to `.bun`.
2. resolveId relative-import shortcut now returns `realpathSync(...)` for
   both the existsSync(base) and source-candidate branches — canonicalizes
   every relative-import id to match vite's own realpathing resolver.

Also Icon.svelte: px `size` no longer flows into `ct.props` (not a variant —
'dropped style prop' warning); named sizes still resolve via the recipe,
numbers go straight to w/h styles.

Verified: resolveId probe — `svelte`, `svelte/internal/client`, and the
shim's inner import all resolve to the same `.bun/...` id. Dev boot: no
crash, host stable. nkit 31/31, unit 265/265.

## 2026-09-19 — animation freshness + CSS animation

User report: slide stops at text bounds then flashes, intro just appears;
crossfade lands wrong; animate:flip dead; marquee/chain dead; declared
CSS animation dead. Three real root causes + one missing feature:

1. **Stale layout** — bounds reads saw pre-mutation geometry. Added
   `boundsDirty` (set by every emit) + `measureBounds()` →
   `measureLayout()` NAPI: `window.draw(cx)` WITHOUT `present()` +
   `cx.notify()` — GPUI separates draw/present, so this is a true
   forced-sync-layout (prepaint+paint+bounds listeners, nothing shown).
   The earlier version presented the measured frame → visible flash —
   fixed by the no-present draw + notify (guarantees a fresh draw
   preempts the pending present).
2. **Harness ordering** — svelte defers transition setup one microtask;
   probes drew synchronously post-dispatch → caught the un-pinned mount.
   `pumpOnce` yields (`sleep(0)`) before drawing — compositor semantics.
   Production was already correct (setTimeout flush ⇒ microtasks drain
   first ⇒ mount+pin in one batch).
3. **Unit-mismatch interp** — `translateX(0)`/`translateX(-160px)` differed
   in skeleton → snap. Tokenize number+unit; bare 0 adopts the other
   unit. Marquee/chain healed.
4. **CSS animation** — `@keyframes` + `animation:`/`animation-*` now
   extracted in native-css/parse → `registerSheet(id, rules, keyframes,
   animations)` → gdom lowers matching rules onto `el.animate()` (the
   CSS→WAAPI lowering). Cascade = specificity→sheet order→source order.
   `iterations: 'infinite'` serialized as string (JSON kills Infinity).
   `animate()` gained `easing` (CSS keywords) + full `direction`
   (reverse/alternate/alternate-reverse). Missing keyframe endpoints now
   interpolate from the underlying computed value (WAAPI); `none`/`auto`/
   `''` opposite a function list = identity (scale→1, others→0).
   `@keyframes x { to {...} }` tweens from identity — the demo's
   `.css-spin` actually spins now.
5. **blur** stays honestly opacity-only — no element filter primitive in
   GPUI; real blur needs an offscreen subtree + shader pass.

Verified: slide 12/12 (intro `0→…→60`, no flash), motion 17/17
(marquee px interp, chain→done, declared rotate() mid-flight),
transform 15/15, rapid-toggle 9/9, raf 14/14, qg 45/45, svelte 51/51,
nkit 31/31, kit 49/49, pages 25/25, bun:test 271/271, parse 74/74,
cargo --lib 324/324. Dylib rebuilt + deployed + re-signed.

## present suppression + double-lease fix (in-flight flicker follow-up)

User report: real `/app` intros still flashed the end state before
running, despite the corrected probes. Root cause: the mount batch's
`apply_batch → invalidate_after_batch → cx.notify()` schedules a
display-link frame that can draw+present the un-pinned scene in the gap
before Svelte's microtask pin lands via `setTimeout` flush.

Fix — `Window::present` gate (gpui fork): `suppress_presents_until(deadline)`
+ `clear_present_suppression()` + `present_suppressed_until` field; a
suppressed present returns early WITHOUT clearing `needs_present` (retry,
not drop). `measure_layout_now` sets a 48ms hold around its draw;
`invalidate_after_batch` clears the hold so the pin batch's frame
presents immediately. Residual pre-measure ticks only draw the pre-mount
tree — element not present, nothing to flash. Single-thread runloop ⇒
no tick can interleave mid-task; the hold covers event-loop boundaries
deterministically.

**Found while verifying**: `window.draw` inside `update_window`'s view
lease panicked — `GpuixSubtree::render` re-leases `GpuixView` for memoized
subtrees → `double_lease_panic` once content is large enough to memoize
(crash-loop ~24s in). `measure_layout_now` now draws via
`update_window_without_view_in` (AnyWindowHandle — AnyView lease, not
GpuixView) then notifies separately; same split in the non-macOS
`UiCommand::Measure` arm (AnyWindowHandle for suppress+draw, window.update
for notify). Fork patch re-exported.

Verified: app runs clean 95s+ (was crash-looping), slide 12/12, motion
17/17, transform 15/15, rapid-toggle 9/9, raf 14/14. Dylib rebuilt +
deployed to all 8 binding copies + re-signed. Visual flicker check =
user's eyes on /animations; mechanism verified end-to-end at code level.

### gdom getComputedStyle longhands — slide/flip fixes

User report: slide stops at text boundary, animate:flip does nothing,
blur still only fades.

- **slide residual 16px** — Svelte's `slide` reads longhands
  (`paddingTop/Bottom`, `marginTop/Bottom`, `border-*-width`,
  `min-height`) from getComputedStyle at transition creation. Ours only
  exposed the `padding` shorthand → `parseFloat('')` → NaN →
  `css_dimension` dropped those keyframes → height animated but padding
  stayed → box stalled at 16px. Fix: `getComputedStyle` expands box
  shorthands (padding/margin/border-width) into longhands, extracts
  border widths from `border`, and fills browser defaults
  (display/position/opacity/width/height/zoom/transform).
- **flip NaN transforms** — Svelte `flip` reads
  `style.transformOrigin.split(' ').map(parseFloat)` (→ NaN on '') and
  `+style.zoom` (→ 0 on '') → `translate(NaNpx, NaNpx)`. Fix:
  transformOrigin resolves to a px pair (default element center from
  painted bounds), zoom defaults '1', transform 'none'. Real deltas now:
  `translate(-39.7px, 0px)` etc.
- **blur stays opacity-fade** — real `filter: blur()` needs an offscreen
  subtree pass + blur shader in gpui's frame graph (fork-level feature);
  honestly deferred.

Regression coverage folded in: slide.svelte gained a padded flex chip
(probe asserts collapse to ~0 + intro from ~0 — was stuck at 16);
probe-motion's flip check now requires numeric translate (was matching
`translate(NaNpx)`). Scratch probes/cases deleted.

Verified: slide 16/16, motion 17/17, transform 15/15, rapid-toggle 9/9,
raf 14/14, bun:test 112/112. App restarted clean on :5177 (killed stale
dev stacks from earlier sessions that held the app SQLite lock).

### Transition reversal — verified, fly demo switched to transition:

User asked whether mid-flight toggles could reverse instead of replaying.
Read svelte's transitions.js: reversal is `counterpart.t()` → live
`animation.currentTime` → re-sample css(t1→t2) at shortened duration —
only possible when ONE transition manager owns both directions, i.e.
`transition:` (is_both). `in:`/`out:` are two managers → counterpart
undefined → t1=0 → snap+replay — identical to a browser, and geometrically
meaningless across different curves (fly in:-44/out:+24 share no path).

probe-reverse-transition.ts + cases/reversetrans.svelte: fade opacity
1→0.53→toggle→0.50→1 continuous; fly y 0→-20.7→toggle→-24.3→0 — true
transform reversal, 9/9. gdom needed nothing — currentTime was already
live, cancel() drops the layer, delay-dummy onfinish drives the handoff.

Demo: fly chip in:/out: → transition:fly (reversible; loses the
asymmetric -44/+24 which in:/out: needed anyway). in:/out: cards remain
as the two-directive documentation.

### getComputedStyle class-cascade — the real slide stall

User: slide still stops at the "blue line" then unmounts. Reproduced with
the app's exact shape: `.chip` CLASS styles inside a flex `.stage` →
stalls at exactly 16px (padding residual). Inline-styled chip collapsed
fine — so the earlier longhand fix worked but class styles never reached
computed style at all.

Root cause: the registerSheet pipeline ships rules to Rust
(`stylesheet.register`); `_classProps`/`parseStyleSheet` is a dead legacy
path — `getComputedStyle` saw only inline props + animFrames. Svelte's
slide reads `paddingTop` → '' → NaN → `css_dimension` drops padding →
`height` animates but the box keeps 8+8px padding forever.

Fix (gdom): a read-only rule mirror — `registerComputedStyleRules` stores
parsed decls per sheet (replace contract, sheet seq for cross-sheet
order); `selMatches`/`compoundMatches` implement the full SelComp surface
(tag/class/id/universal/attr-ops/state/not + ` `, `>`, `+`, `~`
combinators, matched right-to-left against parentElement/prevSibling);
`computedClassProps` cascades spec → sheet seq → rule order, last-wins.
`getComputedStyle` merges it UNDER mergedStyleProps (inline+animFrames
stay on top). Deliberately NOT via `_classProps` — that map feeds
`nativeStyleFor`'s inline setStyle lane and would double-apply class
styles alongside native setClass resolution.

register.ts wires register/unregister. Verified: class chip collapses
35.5→0 (probe-flexslide 4/4), computed paddingTop '8px', display 'flex'.
Slide 16/16, motion 17/17, transform 15/15, rapid-toggle 9/9,
reverse-transition 9/9, bun:test 112/112. App picked it up via gdom
program reload — no native rebuild needed.

## Reversal freeze — live currentTime + sync animation flush

Reported: rapid toggles reverse correctly but the animation visibly holds
several frames before moving. Diagnosis via a real-window instrumented
probe (mission harness: GpuixRenderer + tick loop):

1. `Animation.currentTime` was a stored field updated only inside `step()`
   — up to a full frame stale when svelte's `counterpart.t()` reads it at
   interrupt time. The pin landed behind the true position: a rewind then
   a hold. Now a live getter — `max(0, now - start)` while running, frozen
   `heldTime` when paused/done; `finish()` freezes at duration*iterations.
2. Every `emit` rides `setTimeout(0)` before applyBatch. Under the app's
   rAF-storm load that hop can stretch past a vsync boundary → the pinned
   frame presents a tick late; combined with the pin→first-step tick, the
   element sits ~2-3 frames. `apply()` now flushes synchronously — every
   animation write (pin + each step) reaches Rust in the same task.

Safety: `emit`'s setTimeout comment warns applyBatch inside a native
event callback is reentrant-unsafe. Disproved empirically — 60 rAF ticks
of synchronous applyBatch in a real window, no deadlock: the tsfn is
NonBlocking so JS never runs inside a native update/tree lock. The
measure path (getComputedStyle→measureBounds→flush→applyBatch) already
ran inside click-dispatch tasks on every slide toggle.

probe-anim-timing.ts asserts both: currentTime advances with no rAF
pumped (45ms idle → 45.1), pin reaches applyBatch synchronously at
animate() call. Battery: reverse-transition 9/9, rapid-toggle 9/9,
motion 17/17, slide 16/16, raf 14/14, transform 15/15, flexslide 4/4,
bun:test 271/271.

## /animations freeze — task-speed render loop via sync step flush

Reported: navigating to /animations froze the app in an apparent infinite
loop. Root cause chain, proven with an instrumented real-window repro
(mission-motion2: wrapped applyBatch + event counting):

- `apply()` called `nativeBridge.flush()` per animation step. Every
  applyBatch ends in `finish_update → flush_effects → Window::draw`
  SYNCHRONOUSLY — gpui's test-support draw-dirty-windows path is compiled
  in because gpui_macos unconditionally enables `gpui/test-support`
  (Cargo.toml `[dependencies]` line, feature unification). So each batch =
  one full render = one emitted "frame" event.
- frame event (task) → tickRaf → step → apply → flush → applyBatch → draw
  → frame → … — a closed task-paced loop. With sync flush: ~11kHz
  (88,200 batches in 8s, maxDepth 1 — no recursion, pure ping-pong).
  setInterval/setImmediate starve → window dead. The perpetual driver:
  `.cssanimbox { animation: cssspin 300ms linear infinite }`.
- Same loop existed pre-change but paced by `setTimeout(0)` (~240Hz) —
  hot but livable.

Fix in gdom.ts `animate()`:
- `apply()` no longer flushes — steps ride emit's setTimeout hop, so every
  render→step→render cycle crosses a macrotask boundary.
- The pin keeps its explicit `nativeBridge.flush()` — bounded (once per
  animate(), at transition boundaries), and it coalesces the toggle's
  structural ops into the same draw.
- Live `currentTime` getter unchanged — the reversal correctness fix.

Regression: probe-anim-loop.ts mounts the motion fixture in a real
window, asserts the pump keeps turning, a setInterval heartbeat stays
alive, and applyBatch stays paced (<2000/s; livelocked it was ~11k/s).
3/3. Also fixed e2e fixture: emitted entry imports
`@svelte-desktop/platform` bare — added it to the fixture symlink loop.

Battery: all probes green (reverse-transition 9/9, anim-timing 2/2,
rapid-toggle 9/9, motion 17/17, slide 16/16, raf 14/14, anim-loop 3/3),
bun:test 289/289.

Caveat noted: the paced loop is still ~240Hz of redundant renders while a
perpetual animation runs (pre-existing storm). Real vsync pacing would
need frame events emitted only on display-link draws, not batch draws —
a native-side change, deferred.

## slide/scale mid-flight revert "lag" — directive semantics, not a runtime stall

User: slide + scale/zoom visibly lag on mid-flight revert; fade + fly don't.
Diagnosis: exact split is directive type. fade/fly use `transition:` (one
shared manager → counterpart → live `t()` → true reversal). slide/scale/spin/
blur used `in:`/`out:` pairs — two managers, `counterpart` undefined, so a
re-toggle snaps to the new transition's t=0 and replays full duration
(browser-faithful Svelte semantics; slide's snap is extra-visible since
css(0) is height:0).

Fix (demo-level): app/routes/animations/+page.svelte — scale·center,
scale·corner, slide, spin, blur all converted to `transition:` (kept
transform-origin on corner card; crossfade stays in:/out: — send/receive
requires it). Section copy updated to explain the distinction.

Verified: reversetrans fixture + probe extended to cover transition:slide
and transition:scale reversal — height regrows from interrupted value
(26→29.5→32.5…→50) and scale regrows (0.53→0.60→…→1), no snap-to-0.
probe-reverse-transition now 17/17; full probe battery green.

## adversarial-review remediation — animation mechanics + computed-style single-sourcing

Independent review verdict: "coherent spine, patchwork at the cascade
boundary." All 9 accepted items landed:

gdom.ts (Animation):
- playState 'running' at birth — svelte's tick: loop gates on it and is
  queued before animate() returns; 'idle' deleted the task permanently.
- pin samples tAt(max(0,-delay)) instead of frames[0] — direction:reverse
  starts on the last frame, negative delay mid-curve, alternate-reverse
  correct. Pin keeps its bounded flush (once per animate()).
- currentTime setter is a real seek: running → rebase start; paused →
  resample the held frame now; finished/cancelled → store-only.
  step() writes heldTime directly (avoids per-step seek drift).
- _liveAnims Set on GElement tracks every animate() handle;
  dematerialize cancels them all — detached iterations:Infinity chains
  no longer wake the window forever. getAnimations() returns the set.
- css-anim sig now includes JSON.stringify(frames) — an HMR sheet edit
  touching only @keyframes bodies restarts the running animation.

native.ts:
- flush() re-arms setTimeout when a failed batch lands in retryOps —
  a terminal batch no longer waits for an unrelated emit.

renderer.rs / stylesheet.rs — computed-style single-sourcing:
- merged_symbolic_fields(tree, id) extracted — the one merge that feeds
  paint (sheet cascade → style_raw → recipe → props → theme → state
  layers). resolve_element_layers + new computedStyle NAPIs both call it.
  Returns (had_inputs, map) so empty-but-authored styles still intern.
- GpuixRenderer::computed_style + TestGpuixRenderer::computed_style NAPI
  → JSON of the resolved symbolic map. index.d.ts updated in the
  deployed package.
- stylesheet ordering: match sort key now (spec, sheet_index, rule.order)
  — Vec index = registration order, which survives same-id replace,
  matching the JS mirror's sheetSeq semantics. Cross-sheet shorthand/
  longhand conflicts now paint correctly.

gdom.ts getComputedStyle:
- materialized elements read nativeBridge.computedStyle(nativeId) —
  paint source = read source; var()/calc()/shorthand/!important all
  pre-resolved by Rust. JS mirror (computedClassProps) remains only for
  detached elements Rust can't match. In-flight mergedStyleProps still
  overlay via styleObject→writeComputed normalization; painted bounds
  still win width/height; state buckets apply over the native map
  keyed by JS event flags.

Coverage: probe-anim-waapi.ts (17/17) — playState, forward/reverse/
negative-delay pins, running seek (~0.5), paused seek repaint (0.25),
resume-from-held, infinite-anim death on detach + no resurrection,
keyframe-edit restart, identical-re-register no-op, unregister cancel,
applyBatch retry delivery, cross-sheet shorthand parity ('8px' — the
old mirror answered '4px'). probe-reverse-transition extended with
continuity asserts (|firstPost − interrupted| < ε) → 21/21.

Gates: cargo --lib 324/324 · bun test 289/289 · probes: reverse 21,
waapi 17, rapid-toggle 9, anim-timing 2, anim-loop 3, motion 17,
slide 16, raf 14, transform 15, flexslide 4.

Notable: stale cargo debug rlibs — git checkouts are immutable to cargo;
`cargo clean -p gpui` removed 0 files, test build linked pre-edit gpui
until debug deps artifacts were deleted manually.

## Vsync-paced rendering (scroll jank on /animations)

Diagnosis: gpui_macos unconditionally enables gpui/test-support, which
compiles in a flush_effects block that draws every dirty window
synchronously at the end of EVERY update. Each applyBatch, wheel tick,
and notify produced a full scene-build + a "frame" event → JS rAF turn
on the shared main thread. Scroll ticks queued behind JS turns → AppKit
coalesced deltas → visible cadence lumps while draw-time stats stayed
green (the overlay measures scene-build, not present cadence).

Fix (vendored gpui, app.rs flush_effects): the eager draw is now gated
on `GpuiMode::Test` (or `bench` builds). Production-mode apps pace all
drawing through the display-link `step` → frame callback (draw+present
only when dirty). This restores upstream production semantics — the
block exists for executors with no display link (TestGpuixRenderer's
run_until_parked still draws eagerly). macOS schedule_frame/frame_waker
are no-ops; the continuously-running WindowFrameSource is the sole
driver — confirmed live.

Measured (real window, motion fixture):
- applyBatch rate during infinite anims: ~240/s → ~26-33/s (probe
  window is occluded → compositor retires its drawables ~3 vsyncs late
  → next_drawable blocks → ~33Hz cap; the VISIBLE app window samples
  clean: 88% idle in mach_msg, ~0 nextDrawable waits).
- scroll tick cost inside simulate_scroll_wheel: 0.6ms → ~0.05ms
  (draw removed from update path); 40 ticks → 40 frames.
- frame→batch JS latency p50 = 1.1ms — JS turns ride vsync.

Caveat discovered: frame events now only fire on real draws — anything
that assumed applyBatch paints synchronously must measure/pump. The
scroll repro gained a pumpUntil helper (sleep() alone never services
the main queue). gpui-fork.patch re-exported.

Gates: cargo --lib 324/324 · bun test 271/271 · all 9 probes green.

## Occluded-window stall + pump cadence — scroll lag fix (cont.)

User reported scroll still "laggy as fuck" + huge initial lag on the
motion page after the eager-draw removal. Live instrumentation on the
real app (probe-live.js — boots host.js in a probe process, instruments
tick/applyBatch/frame events, drives the real /animations page) found
two distinct defects:

1. **Occluded-window stall**: a fully covered window (the demo window is
   routinely covered by other app windows) loses its display link →
   `updateWindows`→`display_layer` runs the frame callback synchronously
   → `present()` → `CAMetalLayer nextDrawable` blocks ~25-50ms on the
   starved drawable pool → every pump stalled → ~29fps, tick() balloons
   to 38-60ms, input dispatch starves. Fix: `Window::present()` now
   skips `platform_window.draw` when `platform_window.is_occluded()`
   (new PlatformWindow method, macOS impl reads NSWindow occlusionState;
   default false elsewhere). Draws still run — scene/bounds/a11y stay
   fresh — only the Metal present is skipped. `needs_present` re-arms so
   the first post-visibility step presents the latest scene.

2. **Pump-cadence ceiling (~57Hz)**: `tick(16)` always burned the full
   budget (CFRunLoopRunInMode returnAfterSourceHandled=false), so the
   main queue drained at ~17.4ms cadence → the WindowFrameSource's
   DATA_ADD dispatch source coalesced vsyncs → draws capped at ~57Hz on
   the 95Hz display; scroll deltas batched ~2/frame → steppy scroll.
   Fix (emit.js): FRAME_MS is now 4 on darwin (16 elsewhere — tick()
   isn't a runloop pump off macOS). Pump drains at ~180Hz → every vsync
   serviced uncoalesced.

Measured on the real app (visible window, /animations):
- inject→frame p50 17.3ms → 8.3ms (max 29.4 → 14.5)
- frame gaps during scroll p50 17.5ms → 8.5ms (~117Hz ≈ full rate)
- occluded: tick p50 16ms→4.2ms idle / 37.8ms→7.8ms scroll; inject→frame
  39.1ms → 11.5ms; steady draws 29/s → 63/s (no nextDrawable stalls)

CGEvent note: scroll events hit-test the window under the cursor — a
covered window never receives them (all earlier "scroll didn't land"
attempts were Claude's window eating the events). AXRaise via
accessibility API fronts a bare bun process where
NSRunningApplication.activate fails.

Gates: cargo --lib 324/324 · bun test 271/271 · probes green
(probe-anim-loop now ~114 batches/s — pump no longer caps cadence).
gpui-fork.patch re-exported; dylib deployed+signed; dev stack restarted.
