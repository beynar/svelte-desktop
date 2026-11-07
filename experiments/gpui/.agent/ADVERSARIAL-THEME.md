# Adversarial review — theme engine vs svelai (2026-09-15)

Four independent adversarial reviewers attacked: (a) palette derivation vs
svelai `generateColorPalette`/colorizr, (b) the JS→Rust token-deferral wire
path, (c) override/cascade semantics, (d) x-button recipe vs svelai CVA+Button.
All findings reproduced against the live TestGpuixRenderer and the real svelai
source at /Users/arnaud/code/ai2. Baseline suites were green throughout —
these are gaps the suites don't cover.

## P0 — correctness-critical

1. **`active:{top:1}` teleports positioned x-buttons, clicks lost.** The port
   of `translate-y-px` uses `inset.top` which gpui applies as *replace*, not
   translate. Any `top`-positioned `<x-button>` jumps to top of containing
   block between mousedown/up → MouseUp hit-test misses → no click. 6/6
   clicks missed in probe. Fix: remove the top hack (no transform support in
   StyleDesc) or emulate additive translate.
   — x-button #1

2. **`ctx.color` never reaches Rust from nkit components.** `Button.svelte`
   computes `ctx={color}` for the JS emit gate but nothing emits a `color`
   custom prop → `color-*`/`color/N` refs resolve against `defaultColor`
   (neutral). `<Button color="danger">` renders neutral. Rust channel is
   verified correct; no component feeds it. Confirmed by two reviewers.
   — wire F1, cascade F2

3. **`hex_to_rgb` rejects `#rrggbbaa`.** Alpha-suffixed tokens are unparseable
   downstream: `bg-primary/20`+`raised` deletes the background (`#ffffff17`),
   `bg-primary/20`+`state-layer` composites flat, 8-digit theme colors can't
   drive readable derivation. JS `hexRgb` accepts 8-digit.
   — wire F3, palette F3

## P1 — real divergences from svelai

4. **`raised`/`lift` stomp explicit styles.** Inserts are unconditional —
   `s({shadow:'lg',raised:'sm'})` loses the lg shadow; `raised:'bogus'` emits
   `borderWidth:0` clobbering real borders (JS guarded with `??=`).
   — wire F4, palette F8

5. **Interned styles never re-resolve on theme/`color` prop change.**
   Generic elements keep stale hexes while x-* repaint correctly → mixed
   repaint. Reparented subtrees keep wrong-theme colors durably. Global
   Theme.svelte masked by themeRev; scoped changes are not.
   — cascade F1, wire F9 (verified by main agent)

6. **Fluid type ramp unconditional in Rust** vs JS flat `FONT_BASE` when no
   `typeScale` set → un-themed `text-*` renders 12–45% larger than JS.
   — wire F2

7. **Non-6-digit/non-hex color inputs diverge.** Svelai parses `#rgb`,
   `#rrggbbaa`, `rgb()`, `hsl()`, named colors, Tailwind names via colorizr;
   Rust silently derives black-fallback garbage. `surface=''` → black
   fallback vs Svelai default. — palette F1

8. **`neutral.base` ignores luminance/saturation adjustment** — Svelai
   adjusts neutral through adjustColor; Rust emits raw input. — palette F2

9. **Invalid values silently accepted where svelai throws.** luminance out
   of range, bogus spacing/radius/elevation/typeScale/motion names,
   non-monotonic spacingScale, bad defaultColor, invalid viewport ranges.
   `typeScale{minViewport:1440,maxViewport:1440}` → NaN → `null` font sizes.
   — palette F7, cascade F11

10. **`readable`/`muted-readable` role overrides honored in Rust, ignored by
    svelai** (svelai derives regardless). Decide contract. — palette F4

11. **`surface-*` keys inside `colors`/`palette` objects parsed as phantom
    color entries** (apply_colors splits on first dash). — palette F5

12. **`color=""` poisons subtree ctx** — `Some("")` matches no role → all
    `color-*` fields dropped. Svelai falsy→default. — cascade F3, x #7

13. **Nested `stateLayer` in `s()` bakes BOTH top-level buckets with wrong
    fg** — hover `stateLayer:true` writes a top-level `active` overlay that
    was never requested; fg = top-level color not bucket color. — wire F5

14. **`currentColor` leaks into baked state-layer bg** — Rust returns fg
    verbatim when unparseable; JS fell back to `[250,250,250]`. — wire F6

15. **Strict `f64` alpha parse drops JS-approved fields** — `primary/20x`,
    `/10%`, `/20/30` → whole backgroundColor removed (JS parseFloat was
    lenient). — wire F8

16. **`elevation:"flat"` keeps nonzero geometry** vs svelai zero-offset
    transparent shadow (visually equivalent, not 1:1). — palette F11

17. **Raised border color lacks `--current-border` context** — svelai uses
    `var(--current-border, var(--color-neutral-muted))`; Rust always
    neutral-muted. — palette F10

18. **Type ramp precision** — svelai rounds clamp terms to 3dp rem, floors
    pre-interpolation; Rust px math, fixed viewport 1440 (JS uses live
    innerWidth). ±0.0n px diffs. — palette F12, cascade F7

19. **x-button: no keyboard activation** — Enter/Space emit nothing;
    `keyDown`/`keyUp` declared but never wired (mod.rs warns about exactly
    this). AX Click action works. — x #2

20. **`disabled`/`loading` x-buttons stay in tab order** — `tab_stop` created
    unconditionally; no `aria-disabled` emitted. — x #3

21. **`loading` paints no spinner** — recipe only sets cursor/pointerEvents.
    svelai mounts SpinnerIndicator + `aria-busy`. — x #4

22. **No link semantics** — `href`/`as`/`target`/`rel`/`download`
    unsupported; svelai renders `<a>` with role=link. — x #5

23. **ARIA gaps** — `aria-pressed`/`haspopup`/`controls`/`disabled`/`busy`
    unmapped; svelai prop names (`pressed`, `expanded`) silently ignored.
    — x #6

24. **Compound matching type-conflated** — native coerces both sides through
    `variant_token`; svelai compares raw (`"true"` ≠ `true`). — x #8

25. **`disabled` inertness requires literal `"true"`** — `"disabled"`,
    `"1"` not inert (svelai truthy gates). — x #9

26. **`squared` gaps** — no icon-only auto-derivation, `aspect-square`
    emulated via width compounds (wrong for custom heights), `!px-0`
    important flag has no native equivalent. — x #10

27. **No icon sizing / prefix-suffix wrappers.** — x #11

28. **No transitions; `data-highlighted` state-layer trigger missing.**
    — x #12

29. **x-button never occludes** — `custom_surface` omits
    `should_occlude`/`block_mouse_except_scroll` → click-through hits both
    button and element beneath (host divs DO occlude — asymmetry). — x #13

## P2 — hygiene / secondary

30. `ResolveOutcome.dropped` collected, never surfaced — silent field loss.
31. `removeAttribute` can't clear renamed attrs (`tabindex`→`tabIndex` set
    but `removeAttribute('tabindex')` sends raw name). — cascade F5
32. `theme` prop owned by two disjoint vocabularies — TokenTheme cascade vs
    legacy code/input/markdown `Theme` (appearance/bg/caret/syntax). Silent
    no-ops in both directions. — cascade F6
33. Theme-only colors unreachable via class/`s()` lanes — JS gate uses static
    `PALETTE`; `bg-brand` under `theme.colors.brand` dropped at emit. Raw
    setStyle works. — wire F11, cascade F4
34. Nested `<Theme>` claims module-global install; per-instance `tokens`
    mutate global PALETTE permanently. — cascade F12
35. Deferred anchored overlay missing-bg fallback hardcoded `0x1A1A1A`.
    — cascade F8
36. `theme_for_element` refolds every ancestor theme per setStyle —
    O(depth × palette-gen), no memoization. — cascade F10, wire F18
37. `field_kind`-unmapped bad values (e.g. `flexBasis:'50%'`) still reject
    whole batch + `native.ts` retry guard is broken (`failedBatch===batch`
    never true → poisoned batch re-queued forever, head-of-line blocking).
    Pre-existing; deferral determines which payloads reach it. — wire F10
38. `fontWeight:'700'`/`'extrabold'` raw strings dropped (table has 4 names;
    `parse_font_weight` never reached). — wire F12
39. `letterSpacing`/`fontStyle` dead fields — `tracking-*` emits a number
    serde silently discards; inherited verbatim via INHERITABLE. — wire F13
40. `stateLayer` on x-* setStyle double-applies (bake + recipe overlay).
    — wire F14
41. `s()` numeric-string spacing/dim now ×spacing_unit (`w:'4'`→16px was
    4px) — deliberate convention, footgun vs documented semantics. — wire F15
42. `background:{stops:[{color:'primary'}]}` inner colors never resolve —
    object kept verbatim, gradient paints invisible. — wire F16
43. Carried-over no-ops: `w-fit`→alignSelf only, `h-fit` dropped,
    `aspect-square` dropped, `ring-2` without ring color emits nothing,
    no `ms-*`/`me-*`, `border-t-primary` dropped, `focus:`/`data-*`/`aria-*`/
    `group-*`/`peer-*`/`not()`/`[...]` variants → droppedTokens,
    virtual-list ignores hover/active, boxShadow object missing `color` →
    serde reject, `s({underline})`/`s({aspect})`/`s({focus})` → droppedProps
    despite textDecoration existing. — wire F17
44. String-case diffs — svelai `#FFFFFF` vs Rust `#ffffff`; Rust resolves
    `elevation-tint-*` refs JS doesn't. — palette F13
45. JS `applyDesignTokens` rebases factor knobs from mode/factory tables on
    each call vs Rust `with_override` cumulative — nested Theme divergence
    between JS emit gate and Rust resolution. — palette F6
46. Invalid-foreground fallback differs: JS `[250,250,250]`, Rust retains
    unresolved string. — palette F9

## Verified correct under attack

- Canonical 6-digit-hex palettes byte-exact (dark & light) vs real
  `generateColorPalette` under app.css inputs.
- Same-batch theme+style resolution post-pass; nested nearest-wins; scheme
  swap replaces palette block while factor knobs survive (matches svelai
  CSS model).
- `color` precedence own > ancestor > defaultColor; attribute forwarding
  both directions.
- Hover/active ctx resolution; state-layer opacities exact per mode
  (0.16/0.32 dark, 0.05/0.10 light); explicit hover/active bg wins (`??=`).
- Atomic batch rejection; robustness vs garbage theme shapes (no panic).
- x-anchored overlays preserve retained parentage → theme/color cascade
  correct through portals.
- CVA order, falsy→default, compound arrays, null variants, cache key
  incl. tokens.id, recipe merge, focus ring, inert click suppression,
  role materialization, fullWidth/disabled/loading style mappings.

## Triage decisions needed

- Palette F4 (readable overrides): honor (broader) or ignore (svelai-exact)?
- Wire F2 (fluid ramp default): make JS ramp too (svelai-true) or gate Rust?
- Wire F15 (numeric strings ×unit): keep class-token convention in s() or
  split string-numeric vs number semantics?
- Cascade F6 (`theme` prop vocab split): rename legacy prop or merge?
- Theme-dirty re-resolution: implement native dirty pass (fixes P1-5 for
  scoped changes) or keep JS re-emission contract?

---

## Resolution — fix pass (2026-09-15)

All contract questions resolved **svelai-faithful**: where upstream behavior
differed from ours, upstream wins. Regression coverage:
`gpuix-poc/src/probe-adversarial.ts` — 27/27 assertions green end-to-end
through the real bridge, plus cargo 253/253 and every conformance suite
re-run after the fixes.

### Triage decisions (all resolved)

| Question | Resolution |
|---|---|
| readable/muted-readable overrides | **svelai-exact**: always derived from the raw base; authored role overrides ignored |
| fluid type ramp | **ramp is correct** — svelai's `typeScaleVariables` defaults to `'default'` at build; the JS flat table was the divergence, now moot (JS defers text tokens to Rust) |
| `s()` numeric strings | **kept** — class-token convention (`'4'` → ×spacing-unit) documented |
| `theme` prop vocab split | **known-key gate**: objects carrying `THEME_DECLARATION_KEYS` cascade; legacy `{caret,…}` shapes pass through to x-input/x-code |
| theme-dirty re-resolution | **native dirty pass implemented** — `style_raw` retention + `retheme_subtree` |

### Fixed

| # | Finding | Fix |
|---|---|---|
| 1 | `active:{top:1}` teleport | Removed — press feedback is the `active` bucket/state-layer (gpui has no additive translate) |
| 2 | `color` ctx never emitted | `data-color`→`color` attr map; `resolveTokens`/`s()` stamp `ctxColor`; `applyNativeStyle` emits the `color` custom prop (`_ctxColorOwned`) and strips it from the wire style |
| 3 | `hex_to_rgb` rejects 8-digit | Full csscolorparser path: 3/4/6/8-hex, `rgb()`/`hsl()`, named colors, Tailwind names→`500` |
| 4 | raised/lift stomp | Authored `boxShadow`/`borderWidth`/`borderColor` win (`??=`); invalid level is a no-op; `raised-none`/`0` still clears border (svelai emits `border:0`); ring + inset members survive the merge; full elevation stacks emitted |
| 5 | stale interned styles | `style_raw` retention + `retheme_subtree` on `theme`/`color` setCustomProp and reparent; freshly-resolved styles skipped |
| 6 | fluid ramp default | svelai-true as shipped (see decisions) |
| 7 | non-6-digit colors | `normalize_color_input` + `validate_color` via csscolorparser; invalid → `with_override` error (svelai throws) |
| 8 | neutral.base raw | neutral `DEFAULT` emits the luminance/saturation-adjusted base like svelai |
| 9 | silent invalid values | `with_override`→`Result`: luminance/saturation 0–100, monotonic `spacingScale`, `typeScale` viewport bounds (minViewport==maxViewport rejected — NaN impossible), unknown presets, bad `defaultColor` all error |
| 10 | readable overrides honored | Now ignored (svelai-exact) |
| 11 | `surface-*` phantom entries | `surface`/`surface-*` keys route to the surface map |
| 12 | `color=""` poisons | Falsy → `defaultColor` |
| 13 | nested stateLayer wrong fg | Per-bucket bakes resolve fg from the bucket's own `color` |
| 14 | currentColor in baked bg | `overlay_composite` falls back to `[250,250,250]` like the JS gate |
| 15 | strict alpha parse | `js_parse_float` matches `parseFloat` (`20x`→20, `10%`→10, `20/30`→20) |
| 16 | `elevation:"flat"` | Emits svelai's zero shadow (`0 0 #0000` → empty stack) |
| 19 | no keyboard activation | Enter/Space emit click on x-button; `keyDown`/`keyUp` wired |
| 20 | disabled in tab order | Inert elements skip `tab_stop`; `disabled`/`loading`/`inert` are truthy-gated |
| 21 | loading paints no spinner | `bg-surface/85` overlay + gpui-animated pulsating spinner (svelai `spinnerOverlay` shape) |
| 22 | no link semantics | `href`→`Role::Link` + `__kitGoto`/`open_url`; disabled links get `tabindex=-1` + `aria-disabled` |
| 23 | ARIA gaps | `pressed`→`aria_toggled`, `selected`, `expanded`, `keyshortcuts`, `value*`/`valuetext`, `placeholder`, `orientation`, `posinset`/`setsize`, `rowindex`/`colindex` mapped |
| 24 | compound type-conflation | Typed compound matching — `"true"` ≠ `true` |
| 25 | `disabled` needs `"true"` | `is_bool_axis` truthy gate (`""`/`"disabled"`/`"1"` inert) |
| 26 | squared gaps | Native `aspectRatio`; icon-only auto-square |
| 28 | data-highlighted | `data-highlighted` prop/attr applies the hover bucket eagerly — matches svelai's `state-layer` `[data-highlighted="true"]` fill, on generic and x-* elements |
| 29 | x-button never occludes | `custom_surface` mirrors host `should_occlude`/`block_mouse_except_scroll` |
| 30 | dropped never surfaced | Unresolved fields/props log via `log::warn` |
| 31 | `removeAttribute` rename | Removal routes through `nativeAttrName`; implicit roles recomputed |
| 32 | `theme` vocab collision | `THEME_DECLARATION_KEYS` gate (see decisions) |
| 33 | theme-only colors unreachable | JS gate passes unresolvable refs through as raw tokens — `bg-brand` under `theme.colors.brand` resolves natively |
| 35 | anchored `0x1A1A1A` fallback | Resolves theme `surface` |
| 36 | theme_for_element refold | `themed()` memo per batch |
| 37 | retry wedge | Explicit retry lane: failed batch retries once, then the poisoned prefix drops — later ops proceed |
| 38 | `fontWeight` raw strings | Numeric strings accepted (finite, >0) + named table |
| 39 | `fontStyle` dead | `italic`/`normal` wired through StyleDesc |
| 40 | stateLayer double-apply on x-* | x-* elements skip the bake (real overlay child paints it) |
| 42 | gradient stops unresolved | Inner `stops[].color` resolve like field colors |
| 43 | carried-over no-ops | `aspect-square`, `w/h-fit`→auto, `ms-*`/`me-*`, `focus:`/`focus-within:`/`focus-visible:`, `s({underline,aspect,focus})`, ring default `currentColor` all work |
| 44 | hex casing | Normalized lowercase; `elevation-tint-*` resolves in both lanes |
| 46 | invalid-fg fallback | `[250,250,250]` both lanes |

### Additional bugs found and fixed during validation

- `focus-within:` was missing from the `PSEUDO` regex — never parsed.
- Ring state didn't accumulate across tokens — `ring-2 ring-color/50` emitted
  `currentColor` then dropped the color (per-token `sub`). Now per-bucket.
- `textDecorationColor` missing from `FieldKind::Color` — `decoration-*`
  refs crossed unresolvable.
- `resolve_color` only knew `current`, not `currentColor` — ring members
  were dropped wholesale.
- `setText` accepted non-string content — a numeric text node (`{count}`)
  poisoned the whole batch. Surfaced by the new retry lane during the
  showcase smoke; `data` setter now coerces `String(v)` like real DOM.

### Documented limitations (not fixed — fork/API boundary or deliberate)

- `aria-haspopup`/`aria-controls`/`aria-disabled`/`aria-busy`: gpui fork's
  `AriaProperties` is a closed struct — needs a fork-level
  `write_a11y_info` extension. Props are accepted and stored, not materialized.
- `letterSpacing`/`tracking-*`: no `Style` field in this gpui (text-system
  level). Tokens drop to the audit trail.
- Attribute/selector-conditional class variants — `data-[…]:`, `aria-[…]:`,
  `group-*`, `peer-*`, `has-[…]`, `not(…)`, `[&_svg]`, and svelai's
  `highlight:` variant — have no native bucket channel; they drop to
  `droppedTokens`. (`data-highlighted` the *attribute* works — see #28.)
- Per-side border colors (`border-t-primary` …): no native fields.
- `!important` class flag, style transitions/`transition-*`: unsupported.
- `--current-border` escape hatch (#17): svelai consumer var nothing sets
  upstream; native uses `neutral-muted` always.
- Type ramp (#18): two-endpoint ramp ported; residual ±sub-px diffs and a
  fixed 1440px viewport vs svelai's live `innerWidth`.
- Nested `<Theme>` (#34): `applyDesignTokens` still mutates the module-global
  emit-gate palette. Emit-side only — native per-subtree resolution is
  correct; the divergence is confined to the audit trail.
- `s()` numeric-string ×spacing (#41): deliberate class-token convention.
- `text-current` on non-shadow fields: `currentColor` passes through but no
  field-level currentColor paint exists; shadow members resolve it against
  the element's own `color`.
- x-button icon sizing axis / dedicated prefix-suffix slots (#27): children
  render normally; no auto icon sizing per size variant.

### Final validation (2026-09-15, post-fix)

| Suite | Result |
|---|---|
| cargo test --lib | 253/253 |
| adversarial probe (new) | 27/27 |
| nkit conformance | 30/30 |
| svelte conformance | 45/45 |
| kit conformance | 49/49 |
| quickgui conformance | 45/45 |
| showcase smoke | 25/25 pages |
| theme probe | 4/4 |
| reliability | 11/11 |

Feasibility evidence, not production readiness — the suites cover healthy
paths plus the regression probes above; the documented limitations stand.
