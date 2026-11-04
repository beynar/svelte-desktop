// Installed in the page by the Vite plugin (injected before the SvelteKit client starts).
import { buildHost } from "./build.ts";
import { callPlatform } from "../platform/bus.ts";
import { installWebNotification } from "./web-notification.ts";
import { installMaterials } from "./materials.ts";

(globalThis as any).host ??= buildHost();
installWebNotification();
installMaterials();

// A view (a kept-alive tab) loads out of sight: once its page is drawn, it tells its window,
// which shows it then — never a blank view, nor the server-rendered page before hydration.
const view = (globalThis as { __desktopView?: string }).__desktopView;
if (view !== undefined) {
  let sent = false;
  const send = () => void (sent || ((sent = true), callPlatform("events", "emit", { channel: "tabs:view-ready", data: { id: view } }).catch(() => {})));
  if (document.querySelector('meta[name="desktop-view"]')) {
    // Server-rendered as the view shows it (<WindowTabs>, X-Desktop-View): drawn at its first
    // paint, before the scripts and hydration take the page's thread.
    new PerformanceObserver((list, observer) => {
      if (!list.getEntries().some((e) => e.name === "first-contentful-paint")) return;
      observer.disconnect();
      send();
    }).observe({ type: "paint", buffered: true });
    setTimeout(send, 500);
  } else
    // Otherwise once hydrated (the server-rendered page may be the window's, not the view's), and
    // two frames: the frame with the page is painted.
    addEventListener(
      "desktop:hydrated",
      () => {
        requestAnimationFrame(() => requestAnimationFrame(send));
        setTimeout(send, 500); // no frames out of sight (a platform drawing hidden views only once shown)
      },
      { once: true },
    );
}
