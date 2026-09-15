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
