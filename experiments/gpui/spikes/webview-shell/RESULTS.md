# webview-shell spike — Bun main thread + Worker + system WebView

Question: can ONE `bun build --compile` executable embed a system-WebView window
and keep a full Bun server alive, without a second process or a shipped `bun`?

Answer (macOS arm64, 2026-10-30): **yes.**

## Architecture validated

```
single executable (bun --compile, libshell.dylib embedded via `with { type: "file" }`)
 MAIN THREAD  main.ts
   dlopen libshell (webview/webview + 3 thread-safe shims, 108 KB)
   webview_create / webview_bind / new Worker(server-worker.ts)
   webview_run()  ── BLOCKS in [NSApp run]; main-thread JS loop is frozen
                     (bound callbacks still re-enter JS synchronously here)
 WORKER THREAD  server-worker.ts
   Bun.serve(127.0.0.1:0)  ← the WebView loads this
   UI calls only through shell_*_async → webview_dispatch → main queue
   webview_terminate (thread-safe) to quit
```

Same thread contract as Electrobun (native loop owns main, app in a Worker),
minus the separate bun binary, Zig launcher, second WS server and 16 ms polling.

## Checks (3/3 runs green, every build variant)

| check | result |
|---|---|
| page served by Worker while main blocked in Cocoa loop | ✅ ~100 ms after Worker start |
| Worker → UI push (`shell_eval_async`) | ✅ ~3 ms |
| page → UI-thread JS (`webview_bind` + `webview_return`) | ✅ re-entrant inside run loop |
| Worker → quit (`webview_terminate`) | ✅ rc=0, clean exit |
| main-thread `setInterval` during run | ❌ 0 ticks — by design: **no app logic on main** |
| Worker → main `postMessage` during run | queued, delivered only after run returns |
| embedded dylib dlopened from `$bunfs` in compiled binary | ✅ (run from another cwd) |

## Binary size (same 4-module spike: bun:ffi + Worker + Bun.serve)

| build | size | runs |
|---|---|---|
| stable 1.4.4 `--compile` | 89.3 MB | ✅ |
| canary `--compile` | 121.2 MB (canary is unstripped) | ✅ |
| canary `--compile --trim --trim-locales=en` | 68.5 MB | ✅ |
| canary `--compile --aot` | 56.4 MB | ✅ |
| canary `--compile --aot --trim --trim-locales=en` | **41.3 MB** | ✅ |

RSS of the app process with the window open ≈ 108 MB (aot+trim build; the
32–34 MB the script prints is measured after `webview_destroy`, so it understates).
WebKit's WebContent/Networking processes are separate and not counted.
`--trim` warns: "kept APIs your code doesn't call because the program loads a
native addon or a shared library" — using bun:ffi makes trimming conservative.

Live demo: `SPIKE_KEEP_OPEN=1 dist/spike-aot-trim` keeps the window open and
renders the check results in the page; closing the window quits.
`--aot` **type-checks** the entry (TS2345 failed the first build) — the
framework's own code must be type-clean.

## Rebuild

```sh
native/build-macos.sh                       # needs a webview/webview checkout (WEBVIEW_SRC)
bun main.ts                                  # dev
/tmp/bun-canary/bun-darwin-aarch64/bun build --compile --aot --trim --trim-locales=en \
  main.ts server-worker.ts --outfile dist/spike-aot-trim
```

## Not yet verified

- Windows (WebView2 backend, `webview_dispatch` = PostMessage) and Linux
  (WebKitGTK, `g_idle_add`) — code paths exist in webview/webview, untested here.
- SvelteKit server inside the Worker of the same executable (next step).
