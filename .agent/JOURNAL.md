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
