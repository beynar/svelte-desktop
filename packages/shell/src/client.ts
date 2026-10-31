// Browser-side helper: messages from server code (`desktop.publish(type, data)`)
// and native shell events (`native:focus`, `native:menu`, …). Both travel over
// the native broadcast (events.emit, channel "desktop"), so this works the same
// in the built app and under `vite dev`, with no socket of its own.
import { onPlatform } from "./platform/bus.ts";

type Listener = (data: any, type: string) => void;

/** `type` is a desktop.publish() type, a native event as `native:<type>`, or "*". */
export function onDesktopEvent(type: string, fn: Listener): () => void {
  return onPlatform<{ channel: string; data: { type: string; data: unknown } }>("message", (m) => {
    if (m?.channel !== "desktop" || !m.data) return;
    if (type === "*" || m.data.type === type) fn(m.data.data, m.data.type);
  });
}
