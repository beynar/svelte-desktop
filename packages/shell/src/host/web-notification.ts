// The web's Notification API on the app's notifications: page code written for the browser —
// Notification.requestPermission(), new Notification(title, options) — gets the system's
// permission prompt and real notifications. Installed where the app can show them (a bundled app:
// not a dev run, whose process has no bundle to notify from).
import { platformReady } from "../platform/bus.ts";
import { notifications, observeNotificationEvent } from "../platform/notifications.ts";

type Permission = "default" | "granted" | "denied";
const toWeb = (status: string): Permission => (status === "granted" ? "granted" : status === "denied" ? "denied" : "default");

export function installWebNotification(): void {
  // In a browser, host.notifications is the web's own Notification: leave it be.
  if (!platformReady()) return;
  void notifications
    .getPermissionStatus()
    .then(({ status }) => {
      if (status === "unavailable") return;
      let permission = toWeb(status);
      const open = new Map<string, DesktopNotification>();

      class DesktopNotification extends EventTarget {
        static get permission(): Permission {
          return permission;
        }
        static async requestPermission(callback?: (p: Permission) => void): Promise<Permission> {
          permission = toWeb((await notifications.requestPermission()).status);
          callback?.(permission);
          return permission;
        }
        static readonly maxActions = 2;
        readonly title: string;
        readonly body: string;
        readonly tag: string;
        readonly icon: string;
        readonly data: unknown;
        readonly silent: boolean;
        onclick: ((e: Event) => void) | null = null;
        onclose: ((e: Event) => void) | null = null;
        onshow: ((e: Event) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        #id: string | null = null;

        constructor(title: string, options: NotificationOptions = {}) {
          super();
          this.title = title;
          this.body = options.body ?? "";
          this.tag = options.tag ?? "";
          this.icon = options.icon ?? "";
          this.data = options.data ?? null;
          this.silent = options.silent ?? false;
          if (permission !== "granted") {
            queueMicrotask(() => this.fire("error"));
            return;
          }
          notifications.show({ id: options.tag || undefined, title, body: options.body, image: options.icon, silent: options.silent, data: options.data }).then(
            ({ id }) => {
              this.#id = id;
              open.set(id, this);
              this.fire("show");
            },
            () => this.fire("error"),
          );
        }

        close(): void {
          if (this.#id) void notifications.dismiss(this.#id).catch(() => {});
        }

        /** @internal */
        fire(type: "click" | "close" | "show" | "error"): void {
          const e = new Event(type, { cancelable: type === "click" });
          this.dispatchEvent(e);
          this[`on${type}`]?.call(this, e);
          if (type === "close" || type === "click") open.delete(this.#id ?? "");
        }
      }

      observeNotificationEvent("click", (e) => open.get(e.id)?.fire("click"));
      observeNotificationEvent("dismiss", (e) => open.get(e.id)?.fire("close"));
      Object.defineProperty(globalThis, "Notification", { value: DesktopNotification, configurable: true, writable: true });
    })
    .catch(() => {});
}
