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
SUITES=${*:-"core screen clipboard shell theme popover secure_storage linux-app linux-window linux-window-ops linux-navigation linux-webview linux-dialog linux-diagnostics linux-notifications linux-notifications-fake linux-tray linux-power linux-extra view linux-web-navigation linux-web-policy linux-web-control linux-web-gate linux-web-downloads linux-web-print linux-web-print-cups linux-web-data linux-web-cookies linux-web-sessions linux-web-proxy-tls linux-web-sessions-gate linux-web-protocol linux-web-content linux-input-policy linux-quit linux-clipboard-data linux-sheet linux-desktop linux-drag-out linux-thermal linux-portal"}
P=0; F=0; S=0
for name in $SUITES; do
  [ "$name" = linux-keepalive ] && continue # below, with its own window options
  suite=test/platform/$name.ts
  # The test channel's ops and mock capture devices; linux-web-gate checks what happens without it.
  channel=; case $name in linux-web-policy|linux-web-control) channel='KITOP_TEST=harness HARNESS_WINDOW={"testChannel":true}' ;; esac
  case $name in linux-web-gate) channel=KITOP_TEST=harness ;; esac
  # GTK's CUPS backend reads it once: its IPP server is in the suite.
  case $name in linux-web-print-cups) channel=CUPS_SERVER=127.0.0.1:8631 ;; esac
  # Schemes are declared with the first window. http and BAD are refused: they stay plain.
  case $name in linux-web-protocol) channel='HARNESS_WINDOW={"protocols":["asset","http","BAD"]}' ;; esac
  # What the machine's thermal zones would say: the suite writes them.
  case $name in linux-thermal) channel='KITOP_THERMAL_DIR=/tmp/kitop-thermal HARNESS_WINDOW={"testChannel":true}' ;; esac
  # A real Wayland session, on a headless compositor, with the suite's stand-in for the portal.
  case $name in linux-portal)
    channel="GDK_BACKEND=wayland WAYLAND_DISPLAY=kitop-wayland"
    [ -S "$XDG_RUNTIME_DIR/kitop-wayland" ] || { weston --backend=headless --socket=kitop-wayland --idle-time=0 >/tmp/weston.log 2>&1 & sleep 1.5; }
    ;;
  esac
  out=$(env $channel timeout 120 bun test/harness.ts "$suite" 2>&1)
  sum=$(echo "$out" | grep '"summary"' | tail -1)
  p=$(echo "$sum" | sed -E 's/.*"passed":([0-9]+).*/\1/'); f=$(echo "$sum" | sed -E 's/.*"failed":([0-9]+).*/\1/'); s=$(echo "$sum" | sed -E 's/.*"skipped":([0-9]+).*/\1/')
  [ -z "$sum" ] && { f=1; p=0; s=0; echo "$out" | tail -15; }
  printf '%-20s passed %3s  failed %s  skipped %s\n' "$name" "$p" "$f" "$s"
  echo "$out" | grep '"pass":false' | head -8
  [ -n "$VERBOSE" ] && echo "$out" | grep -E '"skip"|"pass"'
  P=$((P+p)); F=$((F+f)); S=$((S+s))
done
# quitOnLastWindowClosed: false — its own window options.
if [ -z "$*" ] || echo " $* " | grep -q " linux-keepalive "; then
  out=$(HARNESS_WINDOW='{"quitOnLastWindowClosed":false}' timeout 120 bun test/harness.ts test/platform/linux-keepalive.ts 2>&1)
  sum=$(echo "$out" | grep '"summary"' | tail -1)
  p=$(echo "$sum" | sed -E 's/.*"passed":([0-9]+).*/\1/'); f=$(echo "$sum" | sed -E 's/.*"failed":([0-9]+).*/\1/')
  [ -z "$sum" ] && { f=1; p=0; echo "$out" | tail -15; }
  printf '%-20s passed %3s  failed %s  skipped 0\n' "linux-keepalive" "$p" "$f"
  echo "$out" | grep '"pass":false' | head -8
  P=$((P+p)); F=$((F+f))
fi
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
