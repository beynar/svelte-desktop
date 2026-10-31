# Sourced by the Linux test scripts inside the Docker image: a headless desktop
# session — Xvfb, a D-Bus session bus, openbox (EWMH window manager), dunst
# (notification server), gnome-keyring (Secret Service, unlocked), a stand-in
# org.freedesktop.ScreenSaver, a scriptable fake notification server (built, not
# started), and an xdg-open that records instead of opening.
here=$(cd "$(dirname "${SESSION_SH:-$0}")" && pwd)
export DISPLAY=${DISPLAY:-:99}
export XDG_RUNTIME_DIR=/tmp/runtime-$(id -u); mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export NO_AT_BRIDGE=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1
# Software rendering under Xvfb (no GPU / DMA-BUF in the container).
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
if [ ! -S /tmp/.X11-unix/X${DISPLAY#:} ]; then
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X${DISPLAY#:} ] && break; sleep 0.1; done
fi
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then eval "$(dbus-launch --sh-syntax)"; export DBUS_SESSION_BUS_ADDRESS; fi
openbox >/tmp/openbox.log 2>&1 &
dunst >/tmp/dunst.log 2>&1 &
eval "$(printf 'test' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
[ -x /tmp/fake-screensaver ] || gcc "$here/fake-screensaver.c" $(pkg-config --cflags --libs gio-2.0) -o /tmp/fake-screensaver
/tmp/fake-screensaver >/tmp/fake-screensaver.log 2>&1 &
# Scriptable notification server for linux-notifications-fake (started by that suite, replacing dunst).
[ -x /tmp/fake-notifications ] || gcc "$here/fake-notifications.c" $(pkg-config --cflags --libs gio-2.0) -o /tmp/fake-notifications
mkdir -p /tmp/fakebin
cat > /tmp/fakebin/xdg-open <<'X'
#!/bin/sh
echo "$@" >> /tmp/xdg-open.log
X
chmod +x /tmp/fakebin/xdg-open
export PATH=/tmp/fakebin:$PATH
sleep 0.5
