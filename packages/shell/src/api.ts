import type { MenuItemSpec, ShellEvent } from "./types.ts";

export interface OpenDialogOptions {
  title?: string;
  multiple?: boolean;
  directories?: boolean;
  files?: boolean;
  extensions?: string[];
  defaultPath?: string;
}
export interface SaveDialogOptions {
  title?: string;
  defaultName?: string;
  extensions?: string[];
  defaultPath?: string;
}
export interface MessageOptions {
  message: string;
  detail?: string;
  style?: "info" | "warning" | "critical";
  buttons?: string[];
}

/** What app server code (remote functions, endpoints, hooks) gets. */
export interface DesktopApi {
  readonly appName: string;
  readonly origin: string;
  /** Per-user writable directories, created on startup. */
  readonly paths: { data: string; cache: string; home: string; logs: string };
  readonly window: {
    setTitle(title: string): void;
    setSize(width: number, height: number): void;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    /** Fire-and-forget script in the page (no result; use desktop.publish/fetch to answer). */
    eval(js: string): void;
  };
  readonly dialog: {
    open(opts?: OpenDialogOptions): Promise<string[] | null>;
    save(opts?: SaveDialogOptions): Promise<string | null>;
    message(opts: MessageOptions): Promise<number>;
  };
  readonly menu: { set(spec: MenuItemSpec[]): void };
  /** Native events: focus/blur, menu clicks, external navigations, wake... */
  on<T extends ShellEvent["type"]>(type: T, fn: (e: Extract<ShellEvent, { type: T }>) => void): () => void;
  /** Push a JSON message to every open page (see `@svelte-desktop/shell/client`). */
  publish(type: string, data?: unknown): void;
  openExternal(url: string): Promise<void>;
  onBeforeQuit(fn: () => void | Promise<void>): void;
  quit(): void;
}
