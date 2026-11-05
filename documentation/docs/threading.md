# Threading model — measured, not assumed

## Our model (gpuix path — production candidate)

Single process, single JS thread, in-process Rust via NAPI:

```
main thread:  Bun event loop ──┐
               ├─ app JS / Svelte effects
               ├─ emit(op) → JSON ops queue
               │    setTimeout(flush) ──→ renderer.applyBatch(json)   [NAPI call]
               ├─ renderer.tick() loop (setImmediate) ──→ GPUI draws
               └─ native event callback → dispatchPayload → DOM dispatch
```

Rules that keep it sound (verified):
- **No `applyBatch` inside a native event callback** — GPUI panics
  ("cannot update GpuixView while already being updated", reproduced). All
  mutations funnel through the `setTimeout`-deferred flush.
- `drainEvents` + `tick` drive the pump; idle is event-driven — the showcase
  painted 9 frames in 3 s idle (measured via `getDebugFrameOverlayStats`).
- Heavy app work belongs in a Bun **Worker** (validated: workers spawn, run
  `bun:sqlite` on their own connection, postMessage back). Connections are
  NOT shared across threads — one DB handle per thread.

## QuickGUI model (reference, in-repo)

Two threads in one process: `quickgui_run_host()` blocks the main thread; app
code runs in a Bun Worker; FFI callback `set_event_notifier` wakes JS,
`drain_events` batch-delivers. Same rule discovered independently: their
`NativeEvent.data: Uint8Array` is the binary side-channel — matches our
conclusion that bulk bytes shouldn't ride JSON.

## Implications for the architecture decision

- NAPI in-process means **no IPC hop, no serialization boundary between JS
  and Rust beyond the op batch**, and shared typed arrays are possible where
  the ABI supports them. Measured call overhead: NAPI 0.044 µs, FFI 0.013 µs —
  both noise; the real cost is JSON encode+parse of batches (10k ops → 0.68 ms
  total, i.e. ~68 ns/op amortized).
- The reentrancy constraint is a *discipline* cost of single-thread — already
  enforced at `emit()`. A two-process sidecar would remove the constraint but
  add IPC latency (~50–100 µs/round-trip typical) and a second runtime to
  package.
- Bun Workers give us the "compute off the UI path" story without
  process-spawn complexity — validated with `bun:sqlite` inside a worker.
- GPUI must stay on the main thread for macOS UI (AppKit main-thread rule) —
  our model satisfies it by construction; the QG model satisfies it by running
  the host on main and JS on a worker. Both are valid; ours is simpler.
