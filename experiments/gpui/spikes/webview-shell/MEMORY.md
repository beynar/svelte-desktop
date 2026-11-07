# Memory — where it goes and what moves it (macOS arm64, 2026-10-30)

Measured with `bun measure-memory.ts` (window kept open 4 s, then sampled).
`footprint` = phys_footprint, what Activity Monitor shows. RSS over-counts:
it includes shared WebKit/AppKit framework pages that every app maps anyway.

| variant | app RSS | app footprint | WebKit helpers (3 procs) | total footprint |
|---|---|---|---|---|
| bun idle, no window | 10 | 4 | – | 4 |
| bun idle + empty Worker | 16 | 7 | – | 7 |
| window only | 100 | 29 | 37 | 66 |
| window + worker (debug on/off) | 106 | 31 | 37 | 68 |
| window + `smol` worker | 106 | 31 | 37 | 68 |
| compiled `--aot --trim` | 107 | 33 | 40 | 73 |

Numbers in MB. Helpers occasionally read ~160 MB on a run (2 of ~12 runs,
not reproducible on rerun) — likely GPU-process warm-up or another app's
WebKit helper caught by the pgrep diff; typical value is 37 MB.

## Reading

- The "108 MB" seen earlier was RSS. Real app footprint ≈ 31 MB, of which Bun is
  ~7 MB (runtime 4 + Worker 3) and ~25 MB is WKWebView's in-process UI side.
- Total ≈ 68 MB, dominated by WebKit — the same cost Tauri pays with the same
  system WebView.
- Idle knobs (`smol`, devtools off, AOT) change nothing at this scale.
- Under load the server heap matters and **AOT is the big lever** (kit-aot
  spike, SvelteKit server alone): RSS after 200 requests 61.5 → 32 MB, under
  ab load ~105 → 38 MB — the JIT tiers and their code caches disappear.
