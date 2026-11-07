# Spike: `bun build --compile --aot --trim` on a real SvelteKit app

Date: 2026-10-30. Machine: Apple M4 Pro, 14 cores, 48 GB, macOS 26.5.1 (arm64).
Bun stable `1.4.4+38afee6c8` (`bun` on PATH). Bun canary `1.4.4-canary.1+da867c60b` (`/tmp/bun-canary/bun-darwin-aarch64/bun`).
App deps (resolved): @sveltejs/kit 3.1.1, @sveltejs/adapter-bun 1.0.0-next.2, svelte 5.57.3, vite 8.3.5,
@sveltejs/vite-plugin-svelte 7.3.1, typescript 6.0.3.

## Short answer

- **It works.** All 8 canary variants build (except `--bytecode` with its default CJS format, see below) and pass all 10
  functional checks: SSR with `await query()`, remote query GET, remote `command()` POST, remote `form()` as a no-JS POST
  and as the JS-enhanced binary POST, prerendered `/about`, a static asset, a CSS asset, the `+server.ts` JSON endpoint and a 404.
  Nothing broke at runtime under `--trim` or `--aot`. stderr stayed empty in every run.
- **Size:** 89.6 MB (stable `--compile`) → **44.9 MB** with `--aot --trim` (−50%). Hello world: 89.2 → 30.3 MB, so the
  "89 → 34 MB" claim holds (we got even smaller).
- **Startup:** time to the first 200 on `/` drops from 21 ms to **13–15 ms** with `--aot`. `--bytecode --format=esm` gets
  close too (14 ms), but at 124 MB.
- **Memory:** this is the biggest runtime gain. RSS after 200 SSR requests is 62 MB with the JIT and **32 MB** with AOT.
  After 40k requests under load it is about 105 MB vs **38 MB**.
- **Throughput:** no measurable difference. All variants do about 21–27k SSR req/s with ab at `-c 32`, which is within the noise of ab.
- **Caveats that matter:** this is canary-only. `--aot` **cannot cross-compile**: you need one native build per OS/arch.
  `--trim` cross-compiles only if you point `--compile-executable-path` at the matching *canary* runtime. `--trim-locales`
  does nothing on macOS.

## How adapter-bun 1.0.0-next.2 builds the server, and how we take over the final compile

From `node_modules/@sveltejs/adapter-bun/index.js`:

1. `builder.generateServerInstance('.svelte-kit/bun-tmp/server.js')` writes the Kit server and its manifest.
2. The adapter builds three **virtual** files (`Bun.build({ files })`): `manifest.js` (app_dir, base, `embed`, env_prefix,
   origin), `options.js` (serverOptions) and `routes.js`. It also adds a plugin that resolves the bare specifiers
   `SERVER` / `MANIFEST` / `ROUTES` / `SERVER_OPTIONS` that its runtime (`src/index.js`, `handler.js`, `env.js`,
   `routes-util.js`) imports.
3. With `buildOptions.compile` set, it switches to **embed mode**. `routes.js` then holds
   `import asset_N from "/abs/.svelte-kit/output/client/…" with { type: 'file' }` for every client file and prerendered
   page, and maps them into `Bun.serve({ routes })` static routes. `bun build --compile` embeds those files in `$bunfs`.
   Without `compile`, it copies the files to `<out>/client` and serves them from disk next to `import.meta.url`.
4. It calls `Bun.build({ entrypoints: [src/index.js], compile: { outfile: 'server', ...buildOptions.compile }, splitting: true,
   sourcemap: 'external', target: 'bun', format: 'esm', conditions: ['bun','node'] })`.

To run `bun build --compile` ourselves with any canary flag, `scripts/staged-adapter.js` wraps the adapter in compile/embed
mode and **swaps `Bun.build` out while `adapt()` runs**. The swapped-in function writes the adapter's exact module graph to
disk under `stage/`: the runtime sources plus the virtual files, with the bare specifiers rewritten to relative paths. The
result is a normal entrypoint that needs no plugin and no `--asset`, because the client assets ride along as
`with { type: 'file' }` imports, exactly as in the adapter's own compile path. To check that the staging is faithful, compare
the adapter's own compile (`ADAPTER_COMPILE=1`, measured as `kit-0`: 89.87 MB, 10/10 checks) with ours (`kit-a`: 89.61 MB,
10/10). The small size difference comes from the adapter's `splitting`/sourcemap.

Alternative we checked: the canary's **JS API accepts the same options**: `Bun.build({ compile: { outfile, aot: true,
trim: { locales: ['en'] } } })` produces identical sizes (`scripts/jsapi-probe.ts`). If `vite build` runs on the canary,
the stock adapter can do AOT by itself:
`adapter({ buildOptions: { compile: { aot: true, trim: { locales: ['en'] } } } })`. We verified this end to end:
`ADAPTER_COMPILE_EXTRA='{"aot":true,"trim":{"locales":["en"]}}' <canary> --bun node_modules/.bin/vite build` gives
44.5 MB, a 16.5 ms median ready time, RSS 22→32 MB and 10/10 checks.

## Results: macOS arm64 (SvelteKit app)

Ready = spawn until the first HTTP 200 on `/`, polled every 2 ms. The median is over 5 launches. "1st" is the first-ever
launch of the freshly written binary (see the note on macOS first-exec). RSS comes from `ps -o rss`, 1 s after ready and
after 200 sequential SSR requests. Throughput is `ab -k -c 32 -n 20000` after a 2000-request warm-up; RSS(load) is measured
after the ~42k requests.

| variant | flags | build | ok | size (bytes) | MB | ready median | 1st launch | RSS idle | RSS after 200 | checks | SSR req/s | api req/s | RSS (load) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kit-0 adapter's own compile (stable) | `buildOptions.compile: true` | – | ✓ | 89,869,922 | 89.87 | 21.9 ms | 887 ms | 24.0 | 62.6 | 10/10 | – | – | – |
| a stable | `--compile` (1.4.4) | 271 ms | ✓ | 89,605,730 | 89.61 | 21.1 ms | 876 ms | 24.3 | 61.5 | 10/10 | 24,137 | 42,189 | 106.6 |
| b canary | `--compile` | 117 ms | ✓ | 121,554,530 | 121.55 | 24.3 ms | 3161 ms | 23.8 | 62.5 | 10/10 | 21,574 | 38,143 | 101.0 |
| c canary bytecode | `--bytecode` | 11 ms | **✗** | – | – | – | – | – | – | – | – | – | – |
| c2 canary bytecode esm | `--bytecode --format=esm` | 138 ms | ✓ | 123,684,578 | 123.68 | 14.3 ms | 1093 ms | 22.2 | 63.3 | 10/10 | 22,971 | 43,893 | 102.5 |
| d canary trim | `--trim` | 207 ms | ✓ | 68,864,738 | 68.86 | 24.2 ms | 776 ms | 24.5 | 62.0 | 10/10 | – | – | – |
| e canary trim+en | `--trim --trim-locales=en` | 193 ms | ✓ | 68,864,738 | 68.86 | 24.0 ms | 726 ms | 24.2 | 62.1 | 10/10 | 23,231 | 40,010 | 99.1 |
| f canary aot | `--aot` | 1441 ms | ✓ | 61,137,122 | 61.14 | **12.9 ms** | 659 ms | 22.4 | **32.1** | 10/10 | 27,106 | 37,086 | **38.6** |
| g canary aot+trim+en | `--aot --trim --trim-locales=en` | 1446 ms | ✓ | 44,905,826 | **44.91** | 15.2 ms | 574 ms | 22.4 | **32.0** | 10/10 | 24,852 | 42,390 | **38.5** |
| h g + no fn source | `… --no-compile-function-source` | 1510 ms | ✓ | 44,740,706 | 44.74 | 15.9 ms | 570 ms | 22.2 | 32.0 | 10/10 | 25,460 | 46,471 | 38.2 |
| i stock adapter via JS API on canary | `compile: {aot, trim:{locales:['en']}}` | – | ✓ | 44,509,538 | 44.51 | 16.5 ms | 2145 ms | 22.3 | 32.0 | 10/10 | – | – | – |

### Hello world `Bun.serve` baseline (macOS arm64)

| variant | MB | ready median | RSS idle → after 200 |
|---|---|---|---|
| stable `--compile` | 89.16 | 8.2 ms | 11.8 → 14.0 |
| canary `--compile` | 121.11 | 11.2 ms | 11.5 → 13.9 |
| canary `--trim --trim-locales=en` | 68.42 | 11.0 ms | 11.7 → 14.0 |
| canary `--aot` | 51.91 | 10.4 ms | 13.4 → 13.6 |
| canary `--aot --trim --trim-locales=en` | **30.33** | 10.7 ms | 13.3 → 13.5 |

### Linux arm64 (native build *inside* a `debian:bookworm-slim` container on the same Mac, canary linux-aarch64 runtime)

| variant | MB | ready median | RSS idle → after 200 | checks |
|---|---|---|---|---|
| kit canary `--compile` | 141.87 | 18.1 ms | 32.7 → 58.2 | 10/10 |
| kit `--trim` | 85.58 | 17.6 ms | 32.3 → 59.6 | 10/10 |
| kit `--trim --trim-locales=en` | 82.17 | 18.0 ms | 32.2 → 63.6 | 10/10 |
| kit `--aot` | 78.96 | **4.8 ms** | 30.8 → 39.0 | 10/10 |
| kit `--aot --trim --trim-locales=en` | **52.61** | 5.3 ms | 30.6 → 38.8 | 10/10 |
| kit `… --no-compile-function-source` | 52.48 | 5.5 ms | 30.5 → 38.8 | 10/10 |
| hello `--aot --trim --trim-locales=en` | 36.23 | 4.9 ms | 18.8 → 19.1 | 1/1 |

## Failures and diagnosis

1. **`--bytecode` (canary and stable) fails on the adapter's server:**
   ```
   13 | await server.init({
              ^
   error: "await" can only be used inside an "async" function
       at stage/adapter/handler.js:13:7
   error: Unexpected .
   ```
   `--bytecode` defaults to `--format=cjs`, and adapter-bun's `handler.js` uses top-level `await`. Fix: add `--format=esm`
   (variant c2). It works and gives the second-best startup, but no size or memory gain.
2. **Cross-compiling with `--aot`** (any target other than the host): `error: --aot can't cross-compile. It only builds for the platform it runs on`.
3. **Cross-compiling with `--trim`** using the auto-downloaded runtime: `error: this build of Bun doesn't support --trim (NoTrimTable)`.
   The canary downloads `bun-<target>-v1.4.4`, which is the *stable* runtime and has no trim table. It works with
   `--compile-executable-path=<canary runtime for that target>`, for example the zips from
   `github.com/oven-sh/bun/releases/tag/canary` (same commit `da867c60b`):
   - linux-x64 kit: 140.80 → 84.91 MB (`--trim`) → 79.36 MB (`+--trim-locales=en`). These binaries ran 10/10 in an amd64
     container (emulated, so the timings are meaningless).
   - windows-x64 kit: 150.31 → 96.28 → 93.66 MB (built only, not run).
4. No runtime failures. The AOT compiler warned 4 times (`results/build-kit-f-aot.log`), and none of the warnings cause a
   failure:
   - `TS100064 this import path isn't a constant` at Svelte's `internal/server/crypto.js` `obfuscated_import("node:crypto")`.
     Bun has `globalThis.crypto.subtle`, so that branch never runs. Built-ins resolve anyway.
   - `TS100058 this regular expression runs in the interpreter` (×3): `new RegExp(...)` built at runtime in Svelte's
     escape helpers and in devalue's `fromRegExpInfo`.
   - There is no `eval` / `new Function` in the server bundle (Svelte 5 SSR, Kit 3 and devalue's `parse`/`stringify`
     don't use them). So `--no-compile-function-source` is safe here, but it only saves 0.17 MB.

## What `--explain=trim` says (`results/explain-trim.txt`)

`compile 44.9 MB (83.5 MB of unused Bun APIs removed)`. Trim is conservative here, and three things block it:
- `blocked by dynamic-import` at Svelte's `obfuscated_import(module_name)` (server `crypto.js`). Because of it, trim keeps
  the interpreter path for `import()`/`require()` of data files.
- "can't tell which API" at `esm-env/dev-fallback.js` (`globalThis.process?.env?.NODE_ENV`) and at devalue
  (`globalThis[type]` for typed arrays in `utils.js`/`uneval.js`). These make trim keep large groups: all typed arrays,
  Worker, WebSocket, BroadcastChannel, HTMLRewriter, URLPattern, Brotli/zstd, crypto.subtle, S3 and so on.
- Things trim **kept** that we really use: `bun:sqlite`, `Bun.serve` (+HTTP/2-3 and cookies), `Bun.file`, `Bun.semver`,
  `Bun.Glob` (Kit), `node:fs`/`path`/`crypto`/`buffer`/`events`, `TextEncoder`, `FormData`.
- The report lists 3,558 "uses" lines and 143 "kept" features.
- Patching those three sites would probably trim more (Svelte's dynamic import, esm-env and devalue's `globalThis[type]`).

## What `--explain` (slow paths) says (`results/explain-slow.txt`)

"Untyped code works, but runs slower. 1,148 causes." The compiler expects about 25% of execution time in untyped operations
at the worst site: `group_formdata` in Kit's `remote.js` (`builtin-result`: types come from `.d.ts`, so the compiler can't
check them). The next sites are:
- Kit `internal.js` `handle_remote_call_internal` (caught value, 5.5%)
- remote-function id assignment in `data.remote.js`
- the `LazyFile` Proxy
- `create_remote_arg_reducers` (functions handed to devalue, so they are "called-by-unknown-code")

21% of property accesses compile to a single load. All of these sit in Kit, Svelte or devalue internals, not in app code.
The throughput numbers show the untyped code is no slower in practice than the JIT.

## Notes / caveats

- **Canary only** (`1.4.4-canary.1+da867c60b`). Flags and output may change. Stable 1.4.4 has neither `--aot` nor `--trim`.
- The canary runtime itself is 121 MB (stable: 88.7 MB), so plain canary `--compile` gives *bigger* binaries. Compare
  AOT/trim against **stable** (89.6 MB), not against canary-plain.
- **`--trim-locales` does nothing on macOS** (68.86 MB with or without it, even with `de-AT`), presumably because the macOS
  build uses the system ICU. On Linux and Windows it saves another 2.6–5.5 MB.
- **macOS first launch of a newly written binary** costs 0.45–3.9 s (XProtect/syspolicyd scanning an ad-hoc-signed Mach-O).
  It roughly scales with size (30 MB ≈ 0.45 s, 121 MB ≈ 1–4 s), which is a real UX argument for smaller binaries. Later
  launches don't pay it. The medians above leave it out (it is always the 1st run).
- Ready-time medians are from a warm page cache. In the Linux container AOT startup looks dramatic (18 → 5 ms). On macOS
  the gain is 21 → 13 ms.
- `paths.origin` is pinned to `http://localhost:42777` because remote-function mutations are CSRF-checked against it. The
  measurement script spawns every binary with `PORT=42777`.
- Throughput is limited by single-threaded `ab`, so treat ±10% as noise. Two extra rounds are in `results/throughput-round{1,2}.json`.
- AOT build time is about 1.4–1.8 s for this app, against 0.1–0.3 s without AOT.

## Recipe (best working variant: g)

```sh
cd spikes/kit-aot
bun install
# 1. Kit build (stable bun is fine). The staged adapter writes stage/entry.js (adapter-bun's compile-mode module graph).
bun --bun x vite build
# 2. AOT + trim executable (canary), client assets embedded through routes.js `with { type: 'file' }` imports
/tmp/bun-canary/bun-darwin-aarch64/bun build --compile --aot --trim --trim-locales=en stage/entry.js --outfile out/kit-g-aot-trim-en
PORT=42777 ./out/kit-g-aot-trim-en
```
Without the staging wrapper: run `vite build` itself on the canary and pass
`adapter({ buildOptions: { compile: { aot: true, trim: { locales: ['en'] } } } })` (variant i, 44.5 MB).

## Files and re-running

- `scripts/staged-adapter.js`: adapter wrapper that stages the module graph (`ADAPTER_COMPILE=1` also runs the adapter's
  own compile; `ADAPTER_COMPILE_EXTRA` merges extra compile keys into it).
- `scripts/build-variants.ts`: builds all variants and writes `results/build.json` and `results/build-*.log`.
- `scripts/measure.ts`: launch time, RSS and the 10 functional checks; writes `results/measure.json` and `results/run-*.log`.
- `scripts/throughput.ts`: ab load test; writes `results/throughput.json`.
- `scripts/cross.ts`: cross-target acceptance matrix; writes `results/cross-{kit,hello}.json`.
- `scripts/jsapi-probe.ts`: checks that the `Bun.build()` JS API accepts `aot`/`trim`.
- `scripts/run-all.sh`: runs the whole macOS pipeline. Env: `BUN_CANARY`, plus optional `CANARY_LINUX_X64` /
  `CANARY_WINDOWS_X64` for cross `--trim`.
- Linux arm64 run (all variant/result names are suffixed with the tag):
  ```sh
  S=$PWD; docker run --rm -v $S:$S -v <canary linux-aarch64 dir>:/opt/bun -w $S \
    -e BUN_STABLE=none -e BUN_CANARY=/opt/bun/bun -e KIT_AOT_TAG=linux-arm64 debian:bookworm-slim \
    sh -c '/opt/bun/bun scripts/build-variants.ts kit-b kit-d kit-e kit-f kit-g kit-h hello-b hello-e hello-f hello-g && /opt/bun/bun scripts/measure.ts'
  ```
  (The spike dir is mounted at the same absolute path because `stage/` uses absolute asset paths.)
