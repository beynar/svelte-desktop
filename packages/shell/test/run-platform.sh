#!/bin/sh
# Runs every native platform suite (each in its own process/window) and sums the results.
cd "$(dirname "$0")/.."
native/build-macos.sh >/dev/null || exit 1
P=0; F=0; S=0
for suite in test/platform/*.ts; do
  case "$(basename "$suite")" in
    linux-*) continue ;; # Linux suites: test/run-platform-linux.sh (Docker)
    _*) continue ;; # helpers of the Linux suites
  esac
  # KITOP_DEV: pages come from the harness's server, not through a packaged app's gate, as under Vite.
  # No suite is worth a stuck runner, and macOS has no timeout(1).
  out=$(KITOP_DEV=1 perl -e 'alarm shift; exec @ARGV' 180 bun test/harness.ts "$suite" 2>&1)
  sum=$(echo "$out" | grep '"summary"' | tail -1)
  p=$(echo "$sum" | sed -E 's/.*"passed":([0-9]+).*/\1/'); f=$(echo "$sum" | sed -E 's/.*"failed":([0-9]+).*/\1/'); s=$(echo "$sum" | sed -E 's/.*"skipped":([0-9]+).*/\1/')
  [ -z "$sum" ] && { f=1; p=0; s=0; echo "$out" | tail -5; }
  printf '%-16s passed %3s  failed %s  skipped %s\n' "$(basename "$suite" .ts)" "$p" "$f" "$s"
  echo "$out" | grep '"pass":false' | head -5
  P=$((P+p)); F=$((F+f)); S=$((S+s))
done
echo "TOTAL            passed $P  failed $F  skipped $S"
[ "$F" = 0 ]
