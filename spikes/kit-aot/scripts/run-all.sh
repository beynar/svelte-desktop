#!/bin/sh
# Re-runs the whole macOS spike from scratch. Requires: stable bun on PATH, canary at $BUN_CANARY.
set -e
cd "$(dirname "$0")/.."
export BUN_CANARY="${BUN_CANARY:-/tmp/bun-canary/bun-darwin-aarch64/bun}"
bun install
# 1. SvelteKit build (stable Bun). Writes .svelte-kit/output, stage/ (module graph for bun build --compile)
#    and, because of ADAPTER_COMPILE=1, the adapter's own compiled reference binary build-adapter/server.
ADAPTER_COMPILE=1 bun --bun x vite build
# 2. Build every executable variant from stage/entry.js
rm -rf out results/build.json results/measure.json
bun scripts/build-variants.ts
# 3. Launch time / RSS / functional checks
bun scripts/measure.ts
# 4. Steady-state throughput (ab -k -c 32)
bun scripts/throughput.ts kit-a-stable kit-b-canary kit-c2-bytecode-esm kit-e-trim-en kit-f-aot kit-g-aot-trim-en kit-h-aot-trim-en-nosrc
# 5. --explain reports for the AOT+trim build
"$BUN_CANARY" build --compile --aot --trim --trim-locales=en --explain=trim stage/entry.js --outfile out/explain-tmp > results/explain-trim.txt 2>&1
"$BUN_CANARY" build --compile --aot --trim --trim-locales=en --explain stage/entry.js --outfile out/explain-tmp > results/explain-slow.txt 2>&1
rm -f out/explain-tmp
# 6. Cross-compilation acceptance (set CANARY_LINUX_X64 / CANARY_WINDOWS_X64 to canary runtimes to test --trim)
bun scripts/cross.ts kit
bun scripts/cross.ts hello
