#!/bin/sh
# Linux counterpart of run-platform.sh: builds libshell.so and runs the native
# platform suites (each in its own process/window) under a headless session
# (Xvfb + openbox + D-Bus, see docker/session.sh), then the signal test.
# Inside the Docker image:  test/run-platform-linux.sh [suite...]
# From the host:            test/docker/run.sh platform
cd "$(dirname "$0")/.."
native/build-linux.sh >/dev/null || exit 1
SESSION_SH=test/docker/session.sh . test/docker/session.sh
# Portable suites run unchanged; linux-* are the variants of the Apple-specific ones.
SUITES=${*:-"core screen clipboard shell theme popover secure_storage linux-app linux-window linux-navigation linux-webview linux-dialog linux-diagnostics linux-notifications linux-notifications-fake linux-tray linux-power linux-extra view"}
P=0; F=0; S=0
for name in $SUITES; do
  suite=test/platform/$name.ts
  out=$(timeout 120 bun test/harness.ts "$suite" 2>&1)
  sum=$(echo "$out" | grep '"summary"' | tail -1)
  p=$(echo "$sum" | sed -E 's/.*"passed":([0-9]+).*/\1/'); f=$(echo "$sum" | sed -E 's/.*"failed":([0-9]+).*/\1/'); s=$(echo "$sum" | sed -E 's/.*"skipped":([0-9]+).*/\1/')
  [ -z "$sum" ] && { f=1; p=0; s=0; echo "$out" | tail -15; }
  printf '%-20s passed %3s  failed %s  skipped %s\n' "$name" "$p" "$f" "$s"
  echo "$out" | grep '"pass":false' | head -8
  [ -n "$VERBOSE" ] && echo "$out" | grep -E '"skip"|"pass"'
  P=$((P+p)); F=$((F+f)); S=$((S+s))
done
# SIGTERM / SIGINT → glib signal source → {"type":"signal"} event → shell_run returns → exit 0.
for sig in TERM INT; do
  out=$(SIG=$sig timeout 60 bun test/harness.ts test/platform/linux-signal.ts 2>&1); rc=$?
  if [ $rc = 0 ] && echo "$out" | grep -q "\"signal\":\"SIG$sig\""; then
    printf '%-20s passed   1  failed 0  skipped 0\n' "signal SIG$sig"; P=$((P+1))
  else
    printf '%-20s passed   0  failed 1  (exit %s)\n' "signal SIG$sig" "$rc"; echo "$out" | tail -5; F=$((F+1))
  fi
done
echo "TOTAL                passed $P  failed $F  skipped $S"
[ "$F" = 0 ]
