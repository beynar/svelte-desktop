# Multi-window + drag/drop wire contract (v1)

Working contract for the Phase-7 multi-window milestone and the drag/drop
remainder. Both sides (Rust renderer + TS) implement against this.

## Identity model

- `windowId`: `u32`. Primary window = **0** (created by `GpuixRenderer.init`).
- Element ids stay **globally unique** across windows — one gdom document, one
  id counter. No per-window id namespaces.
- Single JS realm owns N windows: **no implicit "current window"**. Ops take an
  explicit `windowId`; mounted components receive it via props/context.

## Retained tree

- `RetainedTree.roots: BTreeMap<u32, u64>` replaces `root_id: Option<u64>`
  (windowId → root element id). A `root_id()` accessor returns `roots.get(&0)`
  for the ~7 existing read sites that mean "the primary root".
- `setRoot` op: `["setRoot", id]` → window 0 (unchanged); `["setRoot", id, w]`
  → window w. Optional trailing arg, parser only.
- Mutations apply to the **shared** tree unchanged. Repaint routing: after a
  batch, walk each touched element → its root → windowId; notify only those
  windows' views. Elements under no root → no notify (invisible anyway).
- `destroyElement` / `setRoot` retarget: resolve touched windows **before**
  applying the op (ancestry disappears mid-apply).
- OS-close of a window: emit `closeRequested` first (existing veto path via
  `onCloseRequested`, now per-window), then `closed {windowId}`; Rust removes
  `roots[windowId]`; the JS side destroys the subtree through normal
  `destroyElement` ops (applyBatch returns destroyed ids → `unbindNative` —
  existing machinery, no new teardown path).

## Windows registry (Rust)

- `WINDOWS: RefCell<BTreeMap<u32, gpui::AnyWindowHandle>>` thread-local,
  replacing the `GPUI_WINDOW` singleton use sites (renderer.rs:296/318/1112).
  `primary_window()` helper = `WINDOWS[&0]`.
- `GpuixView.window_id: u32`; render reads `tree.roots[&self.window_id]`;
  every element event emitted from that view sets `windowId`.
- `EventPayload` gains `window_id` → serialized `windowId` (absent on
  platform-sentinel events → `undefined` JS-side).

## Platform ops (service `"window"`)

- `create {label?, title?, x?, y?, width?, height?, decorations?, visible?,
  alwaysOnTop?}` → `{windowId, label}` — `Outcome::Now` (`open_window` is
  sync). Labels unique → `invalid_args` on duplicate. New window's `GpuixView`
  clones the shared `tree`/`selection`/`event_callback` from the dispatching
  view (platform dispatch holds `view_window`).
- `close {windowId?}` → idempotent; `windowId:0` = normal quit path.
- `list` → `[{windowId, label, focused, bounds}]`.
- `focus {windowId}` → `makeKeyAndOrderFront` + app activate.
- All existing window ops gain optional `windowId` — resolution order:
  explicit arg → the dispatching view's window → 0. Unknown id → `unavailable`.
- `capabilities` registrations for every new op.

## Events (payload gains `windowId` where window-scoped)

- `focusChanged`, `boundsChanged`, `scaleFactorChanged`, `closeRequested`,
  `closed`, `created`, `fileDrop`/`fileDrag*` (element events carry the
  emitting view's `windowId` automatically).
- JS-side `emitTo(windowId, name, payload)` → emit with `{windowId}` in data;
  `onWindow(windowId, event, cb)` filters. `secondInstance {argv,cwd}`
  unchanged — apps may `windows.focus(0)` on receipt (documented, not auto).

## Drag/drop element events (fileDrop region, renderer.rs ~5582)

- Existing: `fileDrop` `{x,y,paths}` via `on_drop::<ExternalPaths>`.
- New (same registration arm): `fileDragEnter` `{x,y,paths}` (first
  `on_drag_move::<ExternalPaths>` in a drag session on that element),
  `fileDragOver` `{x,y,paths}` (subsequent moves), `fileDragLeave` `{x,y}`
  (synthesized: when a move lands on a *different* registered element, the
  previous element leaves; and once before `fileDrop` dispatches).
- Residual gap, documented: gpui has no drag-end/leave callback — a session
  ending with no drop leaves the last-entered element "inside"; next session
  re-enters correctly but that element misses one `fileDragEnter`.
- gdom maps: `dragenter`→`fileDragEnter`, `dragover`→`fileDragOver`,
  `dragleave`→`fileDragLeave`, `drop`→`fileDrop`; reverse map + `dataTransfer`
  synthesis: `{types:['Files'], files:[{name,path}], dropEffect:'copy',
  effectAllowed:'all', getData(t)=>t==='text/uri-list'?paths.join('\n'):''}`.
  FileLike objects — **not** fake DOM `File`s.
- DOM-vs-native honesty note: `drop` fires whenever the element registered a
  drop listener — no `dragover.preventDefault()` requirement (more permissive
  than DOM; documented).

## TS surface (packages/platform + gpuix)

- `windows.create(opts) → {windowId,label}` / `close(id?)` / `list()` /
  `focus(id)` / `get(label)`; `emitTo`; `onWindow`; existing window ops pass
  `windowId` through.
- gdom: `createWindowRoot(windowId) → GElement` — mounting into it makes the
  materialize path emit `["setRoot", id, windowId]`. Mount pattern:
  `mount(Comp, {target: createWindowRoot(w), props:{windowId:w}})`.

## Honesty constraints

- `windows.create` off-macOS → `unsupported` (registry is macOS-only today).
- Ops against closed/unknown windowIds → `unavailable`, never silent no-op.
- `appearanceChanged` stays the single source for system theme (Theme.svelte
  subscribes; `defaults read` polling only as documented non-native fallback).
