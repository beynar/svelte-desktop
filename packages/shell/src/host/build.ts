// The `host` global: everything the app gets beyond the web, without imports —
// the same object in page and server code (Bun-style), installed by the Vite plugin.
//   host.theme.dark · host.clipboard.writeText() · host.notifications.show()
//   host.jobs.start('thumbnails', args)  (server) · host.jobs.list()  (both)
// Reactive in components: the members are the platform stores ($state).
import * as stores from "../platform/stores.svelte.ts";
import * as platform from "../platform/index.ts";

/** A store, falling back to the platform service of the same name for anything it doesn't wrap. */
function withService<S extends object, V extends object>(store: S, service: V | undefined): S & V {
  if (!service) return store as S & V;
  // Read on the real objects (`this` = the store: its private fields), methods bound to their owner.
  return new Proxy(store, {
    get(target, prop) {
      const owner = prop in target ? target : service;
      const value = Reflect.get(owner, prop);
      return typeof value === "function" ? value.bind(owner) : value;
    },
    has(target, prop) {
      return prop in target || prop in service;
    },
  }) as S & V;
}

const PERMISSION_NAMES = new Set([
  "camera", "microphone", "location", "contacts", "calendars", "reminders", "photos", "bluetooth", "speech", "appleEvents",
  "notifications", "screenRecording", "accessibility", "inputMonitoring", "fullDiskAccess", "desktopFolder", "documentsFolder", "downloadsFolder",
]);

/** host.permissions: the store, plus `host.permissions.camera` → its reactive status. */
function permissionsHost() {
  const store = stores.permissions;
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop === "string" && PERMISSION_NAMES.has(prop)) return target.get(prop);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof store & { readonly [K in platform.PermissionName]: platform.PermissionStatus };
}

export function buildHost(server?: Record<string, unknown>) {
  const host = {
    // reactive stores (+ their services)
    app: withService(stores.app, platform.app),
    window: withService(stores.window, platform.windows),
    windowState: stores.windowState,
    screen: withService(stores.screen, platform.screen),
    clipboard: withService(stores.clipboard, platform.clipboard),
    theme: withService(stores.theme, platform.theme),
    system: withService(stores.system, platform.system),
    power: withService(stores.power, platform.power),
    deepLink: withService(stores.deepLink, platform.deepLink),
    menu: withService(stores.menu, platform.menu),
    notifications: withService(stores.notifications, platform.notifications),
    push: withService(stores.push, platform.push),
    capture: withService(stores.capture, platform.capture),
    diagnostics: withService(stores.diagnostics, platform.diagnostics),
    capabilities: withService(stores.capabilities, platform.capabilities),
    update: withService(stores.update, platform.updater),
    tray: withService(stores.tray, platform.tray),
    shortcuts: withService(stores.shortcuts, platform.shortcuts),
    store: stores.store,
    events: stores.events,
    jobs: stores.jobs,
    permissions: permissionsHost(),
    // services without a store
    windows: platform.windows,
    dialog: platform.dialog,
    shell: platform.shell,
    secureStorage: platform.secureStorage,
    popover: platform.popover,
    webview: platform.webview,
    view: platform.view,
    // functions
    on: platform.onPlatform,
    broadcast: platform.broadcast,
    onBroadcast: platform.onBroadcast,
    nativeModule: platform.nativeModule,
    currentPopover: platform.currentPopover,
    closePopover: platform.closePopover,
    /** Running inside the app (false in a plain browser tab or a plain server). */
    get available(): boolean {
      return platform.isNative();
    },
  };
  // Copy descriptors, not values: server getters (paths…) stay lazy, so building the
  // server (prerendering) without the native layer doesn't throw.
  if (server) Object.defineProperties(host, Object.getOwnPropertyDescriptors(server));
  return host;
}

export type Host = ReturnType<typeof buildHost>;
